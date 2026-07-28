/**
 * Subagent 运行时：管理后台子 Agent 的派发、执行与结果通知。
 *
 * 设计（v0）：
 *   - 主 Agent 通过 spawn_subagent 工具派发子任务
 *   - 子 Agent 以 async IIFE 运行于同一个 Event Loop，独立 AbortController
 *   - 完成后结果以 <task-notification> user 消息注入主对话
 *   - 并发上限可配（默认 5）
 *
 * 子 Agent 获得干净的上下文（不继承主 Agent 对话历史），仅复用：
 *   - system prompt（角色定义）
 *   - skill 发现层（渐进式披露）
 *   - 纯工具集（受限，不包含 spawn_subagent 自身）
 */

/**
 * llm.ts 在【模块加载时】就校验 DEEPSEEK_API_KEY 并抛错（有意的 fail-fast）。
 * 而 subagent.ts 被 tools.ts 静态引用，于是「import tools」变成了「必须有 API key」——
 * tools.test.ts 只测 lineDiff/ruleRisk 这类纯函数，不配 key，整个测试文件直接 import 失败。
 * 改成用到时才动态 import（ESM 会缓存，只解析一次），把这条依赖挪出模块加载期。
 */
const llm = () => import("./llm.js");
import { toolSchemas, pureTools, statefulTools, needsApproval, ruleRisk, type ToolCtx } from "./tools.js";
import { SYSTEM_PROMPT } from "./system-prompt.js";
import { config } from "./config.js";
import { RISK_JUDGE_SYSTEM } from "./llmtasks.js";
import { parseRisk } from "./llmtasks.js";
import type { Session } from "./session.js";
import { createRunLogger, type RunLogger } from "./logger.js";
import { loadGlobalMemory, loadProjectMemory } from "./store.js";
import { getSkillIndexText } from "./skill.js";
import { emptyPlan } from "./todo.js";
import { getApprovalMode, SUBAGENT_STATUS_LABEL, type Emitter, type SubagentStatus } from "./events.js";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type OpenAI from "openai";

type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type Chunk = OpenAI.Chat.Completions.ChatCompletionChunk;
type AssistantParam = OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam;

// —— 类型定义 ——

export interface SubagentOptions {
  description: string;       // 简短描述（UI / 通知用）
  prompt: string;            // 子 Agent 的任务 prompt
  subagentType?: "explore";  // 内置 Agent 类型：explore=只读探索代码库
  allowedTools?: string[];   // 允许的工具，explore 类型默认只读（read_file/run_bash/calculate）
  maxTurns?: number;         // 限制轮数，默认 config.subagentMaxTurns
}

export interface SubagentResult {
  agentId: string;
  description: string;
  status: SubagentStatus;
  text: string;
  turns: number;
  totalTokens: number;
  toolCalls: number;
  cost: number;
}

interface SubagentState {
  id: string;
  description: string;
  status: "running" | SubagentStatus;
  abortController: AbortController;
  startedAt: number;
  result?: SubagentResult;
}

/** spawn 的结果：拒绝时带上给模型看的理由（并发已满等）。 */
export type SpawnOutcome =
  | { ok: true; agentId: string }
  | { ok: false; reason: string };

/** 默认子 Agent 不可用的工具（防止递归 + 状态污染）。 */
const DEFAULT_DISALLOWED = new Set([
  "spawn_subagent",
  "memorywrite",
  "todowrite",
]);

/** Explore Agent 的专属 system prompt（替换通用子Agent prompt）。 */
const EXPLORE_SYSTEM_PROMPT =
  SYSTEM_PROMPT +
  "【Explore Agent 规则】你是主 Agent 派出的「代码库探索」Agent。你的任务：" +
  "1. 并行读取：需要看多个文件时用多个 read_file 并发。" +
  "2. 先广后深：先用 run_bash(ls/find/grep) 了解目录结构和大致范围，再深入读关键文件。" +
  "3. 结构化输出：结论按「关键文件→发现→建议关注点」组织，用清晰的标题和要点。" +
  "4. 不写不改：你没有 write_file/edit_file 能力，只读，只报告。" +
  "5. 不询问用户，不委派其他 Agent。干完直接汇报。";

/** Explorer Agent 的默认工具白名单（只读）。 */
const EXPLORE_DEFAULT_TOOLS = new Set([
  "read_file",
  "run_bash",
  "calculate",
]);

/** 生成简短 ID："sa-" + 4 位 hex。 */
let _nextId = 0;
function newAgentId(): string {
  _nextId += 1;
  const hex = _nextId.toString(16).padStart(4, "0");
  return `sa-${hex}`;
}

// —— SubagentRuntime：全局单例 ——

const SUBAGENTS_DIR = join(process.cwd(), "sessions");

function inboxPath(sessionId: string): string {
  return join(SUBAGENTS_DIR, `${sessionId}.subagents.json`);
}

function atomicWrite(target: string, data: string): void {
  mkdirSync(SUBAGENTS_DIR, { recursive: true });
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, target);
}

class SubagentRuntimeImpl {
  private agents = new Map<string, SubagentState>();
  private inbox: SubagentResult[] = [];
  private sessionId: string | null = null;

  /** 绑定当前主会话（resume / new 时调用），恢复未消费的子Agent 结果。 */
  bindSession(sessionId: string): SubagentResult[] {
    if (this.sessionId === sessionId) return []; // 已经绑定过，不重复加载
    // 切会话：先把内存里还没被消费的结果落回【旧】会话的文件，再清空。
    // 否则会话 A 的未读结果会被后续 flushInbox 写进会话 B 的文件、投递给 B。
    this.flushInbox();
    this.inbox.length = 0;
    this.sessionId = sessionId;
    // 从磁盘恢复上次未消费的结果
    const loaded = loadInbox(sessionId);
    if (loaded.length) this.inbox.push(...loaded);
    return loaded;
  }

  /** 落盘未消费的 inbox（已有 results + 后续到达的更完整）。 */
  private flushInbox(): void {
    if (!this.sessionId) return;
    const all = this.inbox;
    if (all.length === 0) {
      // 空 inbox：清理残留文件
      try { unlinkSync(inboxPath(this.sessionId)); } catch { /* 不存在不管 */ }
      return;
    }
    atomicWrite(inboxPath(this.sessionId), JSON.stringify(all, null, 2));
  }

  spawn(opts: SubagentOptions, emit: Emitter, _parentSession?: Session): SpawnOutcome {
    // 并发闸：主 Agent 一轮能并行吐 N 个 spawn_subagent，不挡就是 N 条流一起打 API。
    const running = this.runningCount();
    if (running >= config.subagentMaxConcurrent) {
      return {
        ok: false,
        reason:
          `当前已有 ${running} 个子Agent 在运行，达到并发上限 ` +
          `${config.subagentMaxConcurrent}（env: SUBAGENT_MAX_CONCURRENT）。` +
          `请等已派发的子Agent 汇报后再派新的，或自己直接做这件事。`,
      };
    }

    const id = newAgentId();
    const controller = new AbortController();
    const state: SubagentState = {
      id,
      description: opts.description,
      status: "running",
      abortController: controller,
      startedAt: Date.now(),
    };
    this.agents.set(id, state);

    // 收尾统一走这里：settle 只认第一次，之后（进程退出兜底等）重复调用全部忽略。
    // 这道幂等闸是必需的——否则同一个 agentId 会重复进 inbox、重复通知主 Agent。
    const settle = (result: SubagentResult) => {
      if (state.status !== "running") return;
      state.status = result.status;
      state.result = result;
      this.inbox.push(result);
      this.flushInbox(); // 落盘：即使进程随后崩溃也不丢
      emit({ type: "subagent_completed", agentId: id, description: opts.description, status: result.status });
    };

    // 异步启动 query loop（fire-and-forget）
    runSubagent(opts, id, emit, controller.signal, _parentSession)
      .then(settle)
      .catch((err) => {
        // abort 会让在途的 API 请求抛错走到这里，那是「被中止」而不是「崩溃」
        const aborted = controller.signal.aborted;
        settle({
          agentId: id,
          description: opts.description,
          status: aborted ? "killed" : "failed",
          text: aborted
            ? "子Agent 被中止。"
            : `子Agent 意外崩溃：${err instanceof Error ? err.message : String(err)}`,
          turns: 0,
          totalTokens: 0,
          toolCalls: 0,
          cost: 0,
        });
      });

    emit({ type: "subagent_spawned", agentId: id, description: opts.description });
    return { ok: true, agentId: id };
  }

  /** 主 Agent 每轮调用：取出所有已完成的结果。 */
  pollResults(): SubagentResult[] {
    const results = this.inbox.splice(0);
    this.flushInbox(); // 清空文件
    return results;
  }

  runningCount(): number {
    let n = 0;
    for (const a of this.agents.values()) if (a.status === "running") n++;
    return n;
  }

  /** 运行中子 Agent 的只读快照（/agents 命令用）。 */
  list(): { id: string; description: string; status: string; elapsedMs: number }[] {
    return [...this.agents.values()].map((a) => ({
      id: a.id,
      description: a.description,
      status: a.status,
      elapsedMs: Date.now() - a.startedAt,
    }));
  }

  /**
   * 用户主动 kill 某个子 Agent。
   * abort 后由 runSubagent 的 catch/轮首检查把它 settle 成 killed（幂等，见 spawn）。
   */
  abort(agentId: string): boolean {
    const state = this.agents.get(agentId);
    if (!state || state.status !== "running") return false;
    // 已 abort 但还没 settle（在途请求尚未 reject）也算「已经在中止流程里」，
    // 否则重复 kill 会重复报「已终止」，abortAll 也会把它再数一遍。
    if (state.abortController.signal.aborted) return false;
    state.abortController.abort();
    return true;
  }

  /** kill 全部运行中的子 Agent，返回被中止的个数。 */
  abortAll(): number {
    let n = 0;
    for (const a of this.agents.values()) if (this.abort(a.id)) n++;
    return n;
  }

  /**
   * 进程退出：中止所有运行中的子Agent，把它们的终态写进 inbox 落盘。
   *
   * 必须是【全同步】的——它挂在 process 的 "exit" 事件上，那里跑不了异步。
   * 早先的版本另有一个 async shutdown() 挂在 "beforeExit" 上，里面无条件
   * `await setTimeout(200)`：beforeExit 的语义是「事件循环空了才触发」，
   * 而回调里新排的 timer 又把循环填上，排空后再次触发 beforeExit……
   * 于是进程永远退不出，还每 200ms 重写一次 inbox 文件。别再引入异步收尾。
   */
  shutdownSync(): void {
    for (const a of this.agents.values()) {
      if (a.status !== "running") continue;
      a.abortController.abort();
      a.status = "killed"; // 先置位：settle 的幂等闸据此忽略随后到达的 catch
      this.inbox.push({
        agentId: a.id,
        description: a.description,
        status: "killed",
        text: "进程退出，子Agent 被终止。",
        turns: 0,
        totalTokens: 0,
        toolCalls: 0,
        cost: 0,
      });
    }
    this.flushInbox();
  }
}

// —— 磁盘 I/O ——

function loadInbox(sessionId: string): SubagentResult[] {
  try {
    const raw = JSON.parse(readFileSync(inboxPath(sessionId), "utf8"));
    if (Array.isArray(raw)) return raw as SubagentResult[];
  } catch {
    /* 文件不存在或损坏 */
  }
  return [];
}

/** 全局单例（模块级）。 */
export const subagentRuntime = new SubagentRuntimeImpl();

// —— 格式化 ——

/**
 * 把 SubagentResult 渲染为 <task-notification> XML，
 * 作为 user 消息注入主对话。
 */
export function formatTaskNotification(r: SubagentResult): string {
  return [
    `<task-notification>`,
    `  <task-id>${r.agentId}</task-id>`,
    `  <status>${r.status}</status>`,
    `  <summary>子Agent "${r.description}" ${SUBAGENT_STATUS_LABEL[r.status]}</summary>`,
    `  <result>`,
    r.text,
    `  </result>`,
    `  <usage>`,
    `    <turns>${r.turns}</turns>`,
    `    <total_tokens>${r.totalTokens}</total_tokens>`,
    `    <tool_calls>${r.toolCalls}</tool_calls>`,
    `    <cost>¥${r.cost.toFixed(4)}</cost>`,
    `  </usage>`,
    `</task-notification>`,
  ].join("\n");
}

/**
 * 取走全部未消费结果，渲染成一段可以直接当「用户输入」发给主 Agent 的文本。
 * 没有待处理结果时返回 null。
 *
 * UI 用它做「子Agent 完成 → 自动叫醒主Agent」：把通知当作这一轮的输入送进去，
 * 主Agent 于是能立刻接着干活，而不是躺到用户下次敲键盘才看见结果。
 */
export function drainNotifications(): string | null {
  const results = subagentRuntime.pollResults();
  if (!results.length) return null;
  return results.map(formatTaskNotification).join("\n");
}

// —— 子 Agent query loop ——

/**
 * 流式调用模型（精简版，复刻 agent.ts 的 streamModel）。
 * 子 Agent 不接 UI 事件（思考链和正文只在 DEBUG 模式打印），
 * 但 tool_call / tool_result 事件透传给主 UI。
 */
async function streamModel(
  messages: Message[],
  logger: RunLogger,
  emit: Emitter,
  signal: AbortSignal,
  allowedSet: Set<string> | null,
): Promise<{
  assistantMsg: AssistantParam;
  finishReason: string | null;
  usage: Chunk["usage"];
}> {
  const { client, MODEL } = await llm();
  const stream = await client.chat.completions.create(
    {
      model: MODEL,
      messages,
      tools: (() => {
        let schemas = toolSchemas.filter((t) => !DEFAULT_DISALLOWED.has(t.function.name));
        if (allowedSet) schemas = schemas.filter((t) => allowedSet.has(t.function.name));
        return schemas;
      })(),
      stream: true,
      stream_options: { include_usage: true },
    },
    { signal },
  );

  let content = "";
  let reasoning = "";
  const parts: { id: string; name: string; arguments: string }[] = [];
  let finishReason: string | null = null;
  let usage: Chunk["usage"] = undefined;
  let _chunkNo = 0;

  for await (const chunk of stream) {
    _chunkNo++;
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta;

    // 思考链只记日志，不发 UI
    const reasoningDelta = (delta as { reasoning_content?: string }).reasoning_content;
    if (reasoningDelta) reasoning += reasoningDelta;

    // 正文不发 UI（子 Agent 的中间回答不需要逐字展示）
    if (delta.content) content += delta.content;

    // tool_calls 碎片拼接
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const i = tc.index;
        parts[i] ??= { id: "", name: "", arguments: "" };
        if (tc.id) parts[i]!.id = tc.id;
        if (tc.function?.name) parts[i]!.name += tc.function.name;
        if (tc.function?.arguments) parts[i]!.arguments += tc.function.arguments;
      }
    }
  }

  const toolCalls = parts.filter(Boolean).map((p) => ({
    id: p.id,
    type: "function" as const,
    function: { name: p.name, arguments: p.arguments },
  }));

  const assistantMsg: AssistantParam = {
    role: "assistant",
    content: content || null,
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
  };

  logger.section(`子Agent 轮 — 流式接收`);
  if (reasoning) logger.log(`[思考] ${reasoning}`);
  logger.log(`[正文] ${content || "(无：只发了 tool_calls)"}`);
  if (toolCalls.length) logger.log(`[tool_calls] ${JSON.stringify(toolCalls, null, 2)}`);

  return { assistantMsg, finishReason, usage };
}

/**
 * auto 模式下让模型判断工具调用是否「有风险」（精简版，复刻 agent.ts judgeRisk）。
 */
async function judgeRisk(
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ risky: boolean; reason: string }> {
  try {
    const { client, FLASH_MODEL } = await llm();
    const res = await client.chat.completions.create({
      model: FLASH_MODEL,
      messages: [
        { role: "system", content: RISK_JUDGE_SYSTEM },
        { role: "user", content: `工具: ${name}\n参数: ${JSON.stringify(args)}` },
      ],
    }, { signal });
    return parseRisk(res.choices[0]?.message?.content ?? "");
  } catch {
    return { risky: true, reason: "风险判定失败，保守起见需确认" };
  }
}

/**
 * 子 Agent 的 think→act→observe 循环。
 * 复用 toolSchemas 声明 + pureTools/statefulTools 实现，
 * 确认门继承主 Agent 模式，但在子 Agent 中不可交互：auto 模式下自动放行，
 * strict 模式下危险工具一律拒绝（子 Agent 没有 UI 确认框）。
 */
async function runSubagent(
  opts: SubagentOptions,
  agentId: string,
  emit: Emitter,
  signal: AbortSignal,
  _parentSession?: Session,
): Promise<SubagentResult> {
  // updateLatest:false —— 不抢 logs/last.log 软链，否则主会话的 `tail -f` 会被子Agent 截胡
  const logger = createRunLogger({ updateLatest: false });
  logger.section(`子Agent ${agentId}: ${opts.description}`);
  logger.log(`任务: ${opts.prompt}`);

  const MAX_TURNS = opts.maxTurns ?? config.subagentMaxTurns;

  // 按类型决定 system prompt 和默认工具集
  const isExplore = opts.subagentType === "explore";
  const baseSystemPrompt = isExplore
    ? EXPLORE_SYSTEM_PROMPT
    : SYSTEM_PROMPT +
      "【子Agent规则】你是主 Agent 派出的子 Agent，完成一项具体任务后给出简洁结论。" +
      "不要询问用户，不要委派其他 Agent。直接干活，干完汇报。";
  const effectiveAllowedSet = (() => {
    if (opts.allowedTools) return new Set(opts.allowedTools);
    if (isExplore) return EXPLORE_DEFAULT_TOOLS;
    return null; // null = 用默认过滤（除 disallowed 外全部可用）
  })();

  /**
   * 工具准入：schema 过滤只决定「模型看得见什么」，执行前必须再判一次。
   * 子Agent 继承的 SYSTEM_PROMPT 里明确写了 spawn_subagent 的用法，模型完全
   * 可能凭记忆吐一个 schema 里没有的调用——不在执行侧拦，就是无限递归派发。
   */
  const isToolAllowed = (name: string): boolean => {
    if (DEFAULT_DISALLOWED.has(name)) return false;
    return effectiveAllowedSet ? effectiveAllowedSet.has(name) : true;
  };

  // 构建初始消息
  const messages: Message[] = [
    { role: "system", content: baseSystemPrompt },
  ];
  // 注入 skill 发现层
  const skillHint = getSkillIndexText();
  if (skillHint) messages.push({ role: "system", content: skillHint });
  // 注入全局/项目记忆
  const globalMemory = loadGlobalMemory();
  const projectMemory = loadProjectMemory();
  const mergedMemory = [...projectMemory, ...globalMemory];
  if (mergedMemory.length) {
    messages.push({
      role: "system",
      content: "【已知事实（请始终遵守）】\n" + mergedMemory.map((f, i) => `${i + 1}. ${f}`).join("\n"),
    });
  }

  messages.push({ role: "user", content: `【主Agent委派的任务】\n${opts.prompt}` });

  let totalTokens = 0;
  let toolCallCount = 0;

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    // 检查中断
    if (signal.aborted) {
      logger.section("子Agent 被中断");
      return {
        agentId,
        description: opts.description,
        status: "killed",
        text: "子Agent 被中断。",
        turns: turn - 1,
        totalTokens,
        toolCalls: toolCallCount,
        cost: 0,
      };
    }

    logger.section(`子Agent ${agentId} 第 ${turn} 轮`);

    // —— think ——
    const { assistantMsg, finishReason, usage } = await streamModel(
      messages,
      logger,
      emit,
      signal,
      effectiveAllowedSet,
    );

    messages.push(assistantMsg);
    if (usage) {
      totalTokens += usage.total_tokens;
      logger.log(`[usage] prompt=${usage.prompt_tokens} completion=${usage.completion_tokens} total=${usage.total_tokens}`);
    }

    const toolCalls = assistantMsg.tool_calls;

    // —— 无 tool_calls：最终答案 ——
    if (!toolCalls || toolCalls.length === 0) {
      const text = typeof assistantMsg.content === "string" && assistantMsg.content
        ? assistantMsg.content
        : "(子Agent 没有返回文本内容)";
      logger.section("子Agent 最终答案");
      logger.log(text);
      return {
        agentId,
        description: opts.description,
        status: "completed",
        text,
        turns: turn,
        totalTokens,
        toolCalls: toolCallCount,
        cost: 0, // 暂不计费明细
      };
    }

    // —— act + observe ——
    // 子 Agent 中：工具展示给主 UI（可折叠），但确认门简化处理
    for (const call of toolCalls) {
      emit({ type: "tool_call", name: call.function.name, argsText: call.function.arguments, agentId });
      toolCallCount++;
    }

    const results: (string | null)[] = toolCalls.map(() => null);
    const parsed: (Record<string, unknown> | null)[] = toolCalls.map(() => null);

    // 解析参数
    for (let i = 0; i < toolCalls.length; i++) {
      const rawArgs = toolCalls[i]!.function.arguments;
      try {
        parsed[i] = JSON.parse(rawArgs || "{}");
      } catch (err) {
        results[i] = `工具执行出错：参数不是合法 JSON（${err instanceof Error ? err.message : String(err)}）`;
      }
    }

    // 准入闸：模型可能调用 schema 里没给它的工具，执行前挡掉
    for (let i = 0; i < toolCalls.length; i++) {
      const name = toolCalls[i]!.function.name;
      if (results[i] !== null || isToolAllowed(name)) continue;
      results[i] = `错误：子Agent 无权使用工具 "${name}"。可用工具见本轮 tools 列表，请用它们完成任务。`;
      logger.log(`  [拦截] 越权工具调用 ${name}`);
    }

    // 确认门：子 Agent 无人值守，auto 自动放行低风险，strict 拒绝所有危险工具
    for (let i = 0; i < toolCalls.length; i++) {
      const name = toolCalls[i]!.function.name;
      if (results[i] !== null || !needsApproval.has(name)) continue;
      if (getApprovalMode() === "strict") {
        // strict 模式：子 Agent 不弹确认框，直接拒绝
        results[i] = "子Agent 被禁止执行危险工具（当前为 strict 确认模式）。请换一种方式。";
        continue;
      }
      // auto 模式：规则判断 + LLM 判风险
      const rule = ruleRisk(name, parsed[i]!);
      if (rule) {
        // 规则命中 → 拒绝（子 Agent 不能弹确认框）
        results[i] = `子Agent 需要执行危险操作（${rule}），但子Agent 不能弹确认框。请换一种方式或告知主Agent 需要的操作。`;
        continue;
      }
      // LLM 判风险
      const { risky } = await judgeRisk(name, parsed[i]!, signal);
      if (risky) {
        results[i] = "子Agent 判定此操作为高风险，已自动拒绝。请换一种方式。";
      }
    }

    // 并行执行纯工具
    const toolCtx: ToolCtx = { plan: emptyPlan(), emit, finishReason: finishReason ?? null };
    await Promise.all(
      toolCalls.map(async (call, i) => {
        const name = call.function.name;
        if (results[i] === null) {
          try {
            const stateful = statefulTools[name];
            if (stateful) {
              results[i] = stateful(parsed[i]!, toolCtx);
            } else {
              const impl = pureTools[name];
              results[i] = impl ? await impl(parsed[i]!) : `错误：未知工具 "${name}"`;
            }
          } catch (err) {
            results[i] = `工具执行出错：${err instanceof Error ? err.message : String(err)}`;
          }
        }
        emit({ type: "tool_result", name, result: results[i]!, agentId });
      }),
    );

    // 写回 messages
    for (let i = 0; i < toolCalls.length; i++) {
      const call = toolCalls[i]!;
      const tr = results[i]!;
      const lines = tr.split("\n").length;
      const bytes = Buffer.byteLength(tr);
      const summary = tr.includes("\n") || tr.length > 80
        ? `(${lines} 行, ${bytes} 字节)`
        : tr;
      logger.log(`  [tool] ${call.function.name}(${call.function.arguments}) => ${summary}`);
      messages.push({ role: "tool", tool_call_id: call.id, content: tr });
    }
  }

  return {
    agentId,
    description: opts.description,
    status: "completed",
    text: `已达到最大轮数上限（${MAX_TURNS}），未得到最终答案。`,
    turns: MAX_TURNS,
    totalTokens,
    toolCalls: toolCallCount,
    cost: 0,
  };
}

// —— 进程退出：中止运行中的子Agent，落盘未消费结果 ——
//
// 只挂 "exit"：它同时覆盖自然退出和 process.exit()（Ctrl+C / /exit / 一次性模式），
// 且 shutdownSync 全程同步（writeFileSync + renameSync），在这里跑得完。
//
// 千万不要再往 "beforeExit" 上挂带 timer 的异步收尾：beforeExit 的触发条件是
// 事件循环已清空，而异步回调里排的 timer 又把循环填上，排空后再次触发……
// 结果是进程永远退不出（`echo /exit | tsx src/index.ts` 直接挂死）。
process.on("exit", () => {
  subagentRuntime.shutdownSync();
});

