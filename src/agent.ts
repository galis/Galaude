import type OpenAI from "openai";
import { client, MODEL } from "./llm.js";
import {
  toolSchemas,
  pureTools,
  statefulTools,
  needsApproval,
  describeForApproval,
  ruleRisk,
  type ToolCtx,
} from "./tools.js";
import { createRunLogger, type RunLogger } from "./logger.js";
import { config } from "./config.js";
import {
  RISK_JUDGE_SYSTEM,
  SUMMARIZE_SYSTEM,
  FOLD_SYSTEM,
  parseRisk,
  parseSummary,
} from "./llmtasks.js";
import { newSessionId, saveSession, loadGlobalMemory, type StoredSession } from "./store.js";
import { emptyPlan, type Todo, type TodoPlan } from "./todo.js";
import { ensureUserSkills } from "./skill.js";
import {
  buildContext,
  shouldCompact,
  pickCompactionRange,
  applyCompaction,
  shouldFold,
  pickFoldGroup,
  applyFold,
  shouldWarn,
  type SummarySegment,
} from "./compress.js";

type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;

// 调试开关（见 config.ts）。
const DEBUG = config.debug;

/**
 * agent 把「该显示给用户的东西」抽象成事件，由外层（控制台 or Ink UI）决定怎么渲染。
 * 这样 agent 核心不直接写屏，Ink 接管屏幕时才不会被 console.log 冲乱。
 * 文件日志（logger）与此独立，照常写。
 */
export type AgentEvent =
  | { type: "reasoning"; text: string } // 思维链增量
  | { type: "assistant"; text: string } // 回答正文增量
  | { type: "tool_call"; name: string; argsText: string }
  | { type: "tool_result"; name: string; result: string }
  | { type: "usage"; promptTokens: number } // 本轮模型实际看到的 prompt token（=投影大小）
  | { type: "note"; text: string } // 系统提示（如「已折叠」），界面当一条 note 显示
  | { type: "todos"; todos: Todo[] } // 任务清单变更，界面据此刷新面板
  | { type: "skills"; skills: string[] } // skill 激活变更
  | { type: "debug"; text: string };
export type Emitter = (ev: AgentEvent) => void;

// 工具确认门（human-in-the-loop）：危险工具执行前问用户要不要跑。
// 返回 true 执行、false 拒绝。默认放行（一次性/管道模式无人值守）。
export type ApprovalRequest = {
  name: string;
  argsText: string;
  preview: string; // 给用户看的可读预览（命令 / diff）
};
export type ToolApprover = (req: ApprovalRequest) => Promise<boolean>;
const autoApprove: ToolApprover = async () => true;

// 确认门模式（进程级运行时设置，默认取 config，可用 /mode 切换）。
export type ApprovalMode = "auto" | "strict";
let approvalMode: ApprovalMode = config.approvalMode;
export const getApprovalMode = (): ApprovalMode => approvalMode;
export const setApprovalMode = (m: ApprovalMode): void => {
  approvalMode = m;
};

/** 默认事件渲染：写到控制台（一次性 / 管道模式用），尽量还原老输出。 */
export function makeConsoleEmitter(): Emitter {
  let answerStarted = false;
  return (ev) => {
    switch (ev.type) {
      case "reasoning":
        if (DEBUG) process.stdout.write(ev.text);
        break;
      case "assistant":
        if (!answerStarted)
          (process.stdout.write("\n🤖 "), (answerStarted = true));
        process.stdout.write(ev.text);
        break;
      case "tool_call":
        answerStarted = false;
        console.log(`\n🔧 模型请求工具: ${ev.name}(${ev.argsText})`);
        break;
      case "tool_result":
        console.log(`   ↳ 结果: ${ev.result}`);
        break;
      case "usage":
        break; // 控制台模式不显示 ctx 占比
      case "note":
        console.log(ev.text);
        break;
      case "debug":
        if (DEBUG) console.log(ev.text);
        break;
    }
  };
}

// 把整条历史压成一行 role 时间线，最直观地看出循环在怎么推进：
// system → user → assistant → tool → assistant → ...
function timeline(messages: Message[]): string {
  return messages
    .map((m) => {
      const calls =
        m.role === "assistant" && "tool_calls" in m && m.tool_calls
          ? `(+${m.tool_calls.length}tc)`
          : "";
      return `${m.role}${calls}`;
    })
    .join(" → ");
}

/**
 * Phase 1 的核心：think → act → observe 循环。
 *
 *   think:    带上 tools 定义调用模型
 *   act:      如果模型返回 tool_calls，本地执行对应函数
 *   observe:  把执行结果作为 role:"tool" 追加进 messages，再回到 think
 *   直到模型不再请求工具，给出自然语言答案 → 返回
 */
type Chunk = OpenAI.Chat.Completions.ChatCompletionChunk;
type AssistantParam =
  OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam;

/**
 * 给一个 delta chunk 生成一行人类可读的「这片是什么」标签，
 * 配合原始 JSON 一起记进日志，方便看懂流式协议。
 */
function describeChunk(chunk: Chunk): string {
  const tags: string[] = [];
  const choice = chunk.choices[0];
  if (!choice) {
    if (chunk.usage) tags.push("尾片：choices 为空，只带 usage");
    else tags.push("choices 为空");
    return tags.join(" ");
  }
  const d = choice.delta as {
    role?: string;
    content?: string | null;
    reasoning_content?: string;
    tool_calls?: Chunk["choices"][number]["delta"]["tool_calls"];
  };
  if (d.role) tags.push(`role=${d.role}`);
  if (d.reasoning_content) tags.push(`reasoning(+${d.reasoning_content.length}字)`);
  if (d.content) tags.push(`content(+${d.content.length}字)="${d.content}"`);
  for (const tc of d.tool_calls ?? []) {
    const bits: string[] = [];
    if (tc.id) bits.push(`id=${tc.id}`);
    if (tc.function?.name) bits.push(`name=${tc.function.name}`);
    if (tc.function?.arguments !== undefined)
      bits.push(`arguments片+=${JSON.stringify(tc.function.arguments)}`);
    tags.push(`tool_calls[index=${tc.index}]{ ${bits.join(", ")} }`);
  }
  if (choice.finish_reason) tags.push(`finish_reason=${choice.finish_reason}`);
  if (chunk.usage) tags.push("usage"); // DeepSeek 把 usage 挂在 finish_reason 那片上
  return tags.join(" ");
}

/**
 * 流式调用模型，边收边打，并把分片到达的 tool_calls 拼回完整。
 * 返回值跟非流式版对齐：{ 组装好的 assistant 消息, finish_reason, usage }。
 */
async function streamModel(
  messages: Message[],
  logger: RunLogger,
  turn: number,
  emit: Emitter,
  signal?: AbortSignal
): Promise<{
  assistantMsg: AssistantParam;
  finishReason: string | null;
  usage: Chunk["usage"];
}> {
  const stream = await client.chat.completions.create(
    {
      model: MODEL,
      messages,
      tools: toolSchemas,
      stream: true,
      stream_options: { include_usage: true }, // 流式默认不给 usage，显式打开
    },
    { signal } // 传入中断信号：Ctrl+C 时 abort，会让流式迭代抛错而停止
  );

  let content = "";
  let reasoning = ""; // 累积思维链，连同正文一起落进日志
  // tool_calls 碎片：按 index 累积 id / name / arguments
  const parts: { id: string; name: string; arguments: string }[] = [];
  let finishReason: string | null = null;
  let usage: Chunk["usage"] = undefined;
  let chunkNo = 0;

  // 流式逐片追踪（config.traceStream）：把每个 delta chunk 原样记进日志。
  if (config.traceStream) {
    logger.section(`第 ${turn} 轮 — 流式逐片 chunk 追踪 (TRACE_STREAM)`);
    logger.log(
      "说明：下面每条是 SSE 流回来的一个 chunk。\n" +
        "  · 第一片一般只有 delta.role=assistant（开场白，无内容）\n" +
        "  · 正文分多片，每片 delta.content 一小段\n" +
        "  · tool_calls 分片：id/name 多在首片，arguments 的 JSON 字符串被切成很多片逐步拼出\n" +
        "  · 最后一片带 finish_reason；DeepSeek 把 usage 挂在这同一片上\n" +
        "    （OpenAI 行为不同：会再单独发一片 choices 为空、只带 usage）\n"
    );
  }

  for await (const chunk of stream) {
    chunkNo++;
    if (config.traceStream) {
      logger.log(
        `\n[chunk #${chunkNo}] ${describeChunk(chunk)}\n` +
          JSON.stringify(chunk, null, 2)
      );
    }
    if (chunk.usage) usage = chunk.usage; // 最后一个 chunk（choices 为空）带 usage
    const choice = chunk.choices[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta;

    // DeepSeek 思维链（非标准字段），DEBUG 时实时打出来看模型“在想什么”
    const reasoningDelta = (delta as { reasoning_content?: string })
      .reasoning_content;
    if (reasoningDelta) {
      reasoning += reasoningDelta; // 累积，供日志记录
      emit({ type: "reasoning", text: reasoningDelta });
    }

    // 正文：边到边发事件，这就是“流式”的直观效果
    if (delta.content) {
      content += delta.content;
      emit({ type: "assistant", text: delta.content });
    }

    // tool_calls 分片到达：按 index 拼回完整的一次调用
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
    content,
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
  };

  // 把这一轮「流式收到的内容」按可读形式落进日志文件。
  logger.section(`第 ${turn} 轮 — 流式接收内容`);
  if (reasoning) logger.log(`[思考 reasoning_content]\n${reasoning}\n`);
  logger.log(`[正文 content]\n${content || "(空：本轮只发了 tool_calls)"}`);
  if (toolCalls.length)
    logger.log(`[拼好的 tool_calls]\n${JSON.stringify(toolCalls, null, 2)}`);

  return { assistantMsg, finishReason, usage };
}

export const SYSTEM_PROMPT =
  "你是一个 AI 编程 Agent 助手，帮用户在本机完成编程相关任务。可用工具：" +
  "read_file 读文件、write_file 写/建文件、edit_file 精确改文件" +
  "（这三类文件操作一律用专门工具，不要用 run_bash 的 cat/echo/sed）；" +
  "run_bash 跑其它命令（构建、测试、git、看目录等）；calculate 做精确计算；" +
  "todowrite/todoread 维护多步任务清单；" +
  "memoryread/memorywrite 读写长期记忆（用户偏好、项目约定、关键决定等）；" +
  "skillread/skillactivate 切换 skill 工作模式（渐进式披露：先 skillread 看有哪些，再 skillactivate 激活需要的）。" +
  "【任务清单规则】多步任务必须先用 todowrite 列出完整计划，再把第一项标为 in_progress 开始执行。" +
  "每做完一项立即用 todowrite 标 completed、把下一项标 in_progress，始终保持最多一个 in_progress。" +
  "开始执行前、不确定进度时先用 todoread 确认当前清单，不要凭记忆猜测。" +
  "清单会每轮自动回注到上下文，你始终看得见——照着清单推进，不要跳过 todowrite 直接干活。" +
  "【记忆规则】用户说了值得长期记住的事（偏好、约定、决定、身份信息、项目规则），用 memorywrite 记下来；" +
  "开始新任务前先用 memoryread 了解背景。记忆是跨会话持久化的，不要记琐碎/临时信息。" +
  "【通用规则】优先用工具获取真实信息，不要凭空臆测或编造文件内容；" +
  "完成后用简洁清晰的话回答。";

/** 一次对话会话：跨多轮用户输入持久保存历史与日志。 */
export interface Session {
  id: string; // 会话 id，对应 sessions/<id>.json
  createdAt: string;
  messages: Message[];
  logger: RunLogger;
  round: number; // 第几次「用户输入」（区别于内部 think-act 轮）
  lastPromptTokens: number; // 上轮模型实际看到的 prompt token（投影大小），驱动压缩触发
  // —— 压缩状态（投影用，messages 始终完整不动）——
  summaries: SummarySegment[]; // 旧段摘要，append-only
  summarizedUpTo: number; // messages[1..k] 已被 summaries 覆盖
  memory: string[]; // 会话级外置关键事实（P3 自动抽取），豁免压缩
  globalMemory?: string[]; // 全局记忆（~/.galaude/memory.json），每轮注入前读取
  plan: TodoPlan; // 任务清单（模型驱动，每轮回注上下文）
  activeSkills: string[]; // 已激活的 skill 名列表（模型驱动，每轮回注上下文）
}

/** 新建一个会话：装好 system 提示 + 一个会话级日志文件。 */
export function createSession(): Session {
  const logger = createRunLogger();
  logger.section("工具定义 toolSchemas（随每轮一起发给模型）");
  logger.log(JSON.stringify(toolSchemas, null, 2));
  const messages: Message[] = [{ role: "system", content: SYSTEM_PROMPT }];
  return {
    id: newSessionId(),
    createdAt: new Date().toISOString(),
    messages,
    logger,
    round: 0,
    lastPromptTokens: 0,
    summaries: [],
    summarizedUpTo: 0,
    memory: [],
    plan: emptyPlan(),
    activeSkills: [],
  };
  // 首次启动：内置 skill 复制到用户目录（幂等，已有则跳过）
  try { ensureUserSkills(); } catch { /* 非致命 */ }
}

/**
 * 把 source 会话的【全部】字段装进 target（原地、保持对象引用不变）。
 * UI 层的 /new、/clear、切换会话都必须走这里——曾经三处各自手抄字段列表，
 * 结果压缩状态（summaries/summarizedUpTo/memory）被漏掉：旧会话的摘要挂到
 * 新会话上、水位线越界切空近段、还会把旧摘要持久化进新会话存档。
 */
export function adoptSession(target: Session, source: Session): void {
  target.id = source.id;
  target.createdAt = source.createdAt;
  target.logger = source.logger;
  target.round = source.round;
  target.lastPromptTokens = source.lastPromptTokens;
  target.messages.length = 0;
  target.messages.push(...source.messages);
  target.summaries = source.summaries;
  target.summarizedUpTo = source.summarizedUpTo;
  target.memory = source.memory;
  target.plan = source.plan;
  target.activeSkills = source.activeSkills;
}

/** 从存盘记录恢复一个会话：沿用其 id 与历史，重开一份运行日志。 */
export function resumeSession(stored: StoredSession): Session {
  const logger = createRunLogger();
  logger.section(`恢复会话 ${stored.id}（${stored.messages.length} 条历史）`);
  return {
    id: stored.id,
    createdAt: stored.createdAt,
    messages: stored.messages,
    logger,
    round: stored.messages.filter((m) => m.role === "user").length,
    // 恢复时带上 ctx 大小：这样恢复后第一轮就知道要不要裁，不会先发一坨超大上下文
    lastPromptTokens: stored.lastPromptTokens ?? 0,
    // 压缩状态直接读回（零重放）：摘要/水位线/记忆都是固化好的
    summaries: stored.summaries ?? [],
    summarizedUpTo: stored.summarizedUpTo ?? 0,
    memory: stored.memory ?? [],
    plan: stored.plan ?? emptyPlan(),
    activeSkills: stored.activeSkills ?? [],
  };
}

/** 把会话当前状态写盘（sessions/<id>.json），每轮结束自动调用。 */
export function persist(session: Session): void {
  const firstUser = session.messages.find((m) => m.role === "user");
  if (!firstUser) return; // 空会话（还没说过话）不必存盘
  const title =
    typeof firstUser.content === "string" ? firstUser.content.slice(0, 50) : "(无标题)";
  saveSession({
    id: session.id,
    createdAt: session.createdAt,
    updatedAt: new Date().toISOString(),
    title,
    messages: session.messages,
    lastPromptTokens: session.lastPromptTokens,
    summaries: session.summaries,
    summarizedUpTo: session.summarizedUpTo,
    memory: session.memory,
    plan: session.plan,
    activeSkills: session.activeSkills,
  });
}

/** 把一段消息渲染成可读「对话稿」喂给摘要器（工具结果截断，控制摘要输入大小）。 */
function renderTranscript(slice: Message[]): string {
  return slice
    .map((m) => {
      if (m.role === "user")
        return `用户: ${typeof m.content === "string" ? m.content : ""}`;
      if (m.role === "assistant") {
        const tcs = (m as AssistantParam).tool_calls;
        const calls = tcs
          ? tcs
              .map((t) => `〔调用 ${t.function.name}(${t.function.arguments})〕`)
              .join(" ")
          : "";
        const text = typeof m.content === "string" ? m.content : "";
        return `助手: ${text} ${calls}`.trim();
      }
      if (m.role === "tool") {
        const c = typeof m.content === "string" ? m.content : "";
        return `工具结果: ${c.length > 1500 ? c.slice(0, 1500) + "…" : c}`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * 折叠那一次 LLM 调用（非流式、稀疏）。从原文摘 → 不漂移。
 * 顺带抽取「需长期记住的稳定事实」放进外置记忆（层 C），用 JSON 输出，防御式解析。
 */
async function summarizeChunk(
  slice: Message[],
  signal?: AbortSignal
): Promise<{ summary: string; facts: string[] }> {
  const res = await client.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: SUMMARIZE_SYSTEM }, // 提示词与解析在 llmtasks.ts，两引擎共用
      { role: "user", content: "对话片段：\n\n" + renderTranscript(slice) },
    ],
  }, { signal }); // 接中断信号：Ctrl+C 时内部 LLM 调用也随之取消
  return parseSummary(res.choices[0]?.message?.content ?? "");
}

/**
 * auto 模式下让模型判断这个工具调用是否「有风险」。
 * 防御式 JSON 解析；判不出来（解析失败/异常）→ 保守当作有风险（fail-safe）。
 */
async function judgeRisk(
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal
): Promise<{ risky: boolean; reason: string }> {
  try {
    const res = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: RISK_JUDGE_SYSTEM }, // 提示词与解析在 llmtasks.ts，两引擎共用
        { role: "user", content: `工具: ${name}\n参数: ${JSON.stringify(args)}` },
      ],
    }, { signal });
    return parseRisk(res.choices[0]?.message?.content ?? "");
  } catch {
    return { risky: true, reason: "风险判定失败，保守起见需确认" };
  }
}

/** 把若干旧摘要再合并浓缩成更高层级的一条（分级折叠的那次 LLM 调用）。 */
async function summarizeTexts(texts: string[], signal?: AbortSignal): Promise<string> {
  const res = await client.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: FOLD_SYSTEM }, // 提示词在 llmtasks.ts，两引擎共用
      {
        role: "user",
        content: texts.map((t, i) => `[摘要${i + 1}]\n${t}`).join("\n\n"),
      },
    ],
  }, { signal });
  return res.choices[0]?.message?.content?.trim() || texts.join(" / ");
}

/** 分级折叠（层 B 触顶）：摘要本身太大时，把最旧的若干段再折一层，必要时软提示。 */
async function maybeFold(
  session: Session,
  emit: Emitter,
  signal?: AbortSignal
): Promise<void> {
  while (shouldFold(session)) {
    const group = pickFoldGroup(session);
    if (!group) break;
    const texts = session.summaries.slice(group[0], group[1] + 1).map((x) => x.text);
    const text = await summarizeTexts(texts, signal);
    applyFold(session, group, text);
    session.logger.section(`🗜🗜 二级折叠 摘要段[${group[0]}..${group[1]}]`);
    session.logger.log(text);
    persist(session);
    emit({
      type: "note",
      text: `🗜 摘要过多，已把 ${group[1] - group[0] + 1} 段旧摘要再折一层`,
    });
  }
  if (shouldWarn(session)) {
    emit({
      type: "note",
      text: "⚠️ 对话很长、早期内容已重度压缩，关键信息可能丢失；可 /new 开一个聚焦的新会话",
    });
  }
}

/** 轮边界检查：上下文偏大时，把最旧的若干完整轮折叠成一段摘要（一次 LLM 调用）。 */
async function maybeCompact(
  session: Session,
  emit: Emitter,
  signal?: AbortSignal
): Promise<void> {
  if (!shouldCompact(session)) return;
  const range = pickCompactionRange(session);
  if (!range) return;
  const slice = session.messages.slice(range[0], range[1] + 1);
  emit({
    type: "debug",
    text: `🗜 折叠 messages[${range[0]}..${range[1]}]（${slice.length} 条）成摘要 …`,
  });
  const { summary, facts } = await summarizeChunk(slice, signal);
  applyCompaction(session, range, summary);
  for (const f of facts)
    if (!session.memory.includes(f)) session.memory.push(f); // 外置记忆去重追加
  session.logger.section(
    `🗜 折叠摘要 messages[${range[0]}..${range[1]}]（${slice.length} 条）` +
      (facts.length ? `；抽取事实 ${facts.length} 条` : "")
  );
  session.logger.log(summary + (facts.length ? "\n事实:\n- " + facts.join("\n- ") : ""));
  persist(session); // 摘要 + 水位线 + 记忆落盘（之后恢复直接读，零重放）
  emit({
    type: "note",
    text:
      `🗜 已把早前 ${slice.length} 条消息折叠成摘要` +
      (facts.length ? `，记住 ${facts.length} 条事实` : "") +
      "（ctx 下降）",
  });
  await maybeFold(session, emit, signal); // 摘要本身若过大，再折一层
}

/**
 * 处理「一次用户输入」：追加进会话历史，跑完 think→act→observe 循环
 * 直到模型给出自然语言答案，返回该答案。历史留在 session 里，下次调用
 * 自动带上下文——这就是多轮对话的关键。
 */
export async function runAgent(
  session: Session,
  userInput: string,
  emit: Emitter = makeConsoleEmitter(),
  signal?: AbortSignal,
  approve: ToolApprover = autoApprove
): Promise<string> {
  const { messages, logger } = session;
  session.round++;
  messages.push({ role: "user", content: userInput });
  logger.section(`========== 用户输入 #${session.round} ==========`);
  logger.log(userInput);
  persist(session); // 先记下用户这轮（即使中途被中断也不丢）

  // 每轮注入前刷新全局记忆（跨会话共享 → 新会话也能看到之前记下的事实）
  session.globalMemory = loadGlobalMemory();

  // 轮边界：上下文偏大就先把最旧的若干完整轮折叠成摘要，再开始这一轮（不折当前在飞轮）。
  await maybeCompact(session, emit, signal);

  // 最大轮数上限，防止模型陷入死循环（见 config.maxTurns，env: MAX_TURNS）。
  const MAX_TURNS = config.maxTurns;

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    emit({ type: "debug", text: `──────── 第 ${turn} 轮：调用模型 ────────` });
    // 这一轮「发出去」的历史：每轮都把完整 messages 重新传给无状态的 API。
    emit({ type: "debug", text: `📤 发送历史（${messages.length} 条）: ${timeline(messages)}` });
    // 投影：真相源 messages 的临时视图（外置记忆 + 旧段摘要 + 近段原文，近段里偏旧的大
    // 工具输出再裁一道）。messages 本身一字不动，只是发送时套一层 buildContext。
    const ctx = buildContext(session);
    logger.section(
      `第 ${turn} 轮 — 发送给模型的 messages（投影：原文 ${messages.length} 条 → 发送 ${ctx.length} 条；上轮 ctx≈${session.lastPromptTokens} tok）`
    );
    // 全量投影 JSON 每轮重复全部历史（日志 O(n²) 膨胀），只在协议研究模式下记；
    // 平时记 role 时间线就够定位问题了。
    if (config.traceStream) logger.log(JSON.stringify(ctx, null, 2));
    else logger.log(timeline(ctx));

    // —— think（流式）——
    const { assistantMsg, finishReason, usage } = await streamModel(
      ctx,
      logger,
      turn,
      emit,
      signal
    );

    // 把模型这一轮的回复（可能含 tool_calls）原样追加进历史。
    messages.push(assistantMsg);
    logger.log(
      `\n----- 第 ${turn} 轮 — 模型响应 -----\n` +
        JSON.stringify(
          { finish_reason: finishReason, usage, message: assistantMsg },
          null,
          2
        )
    );
    if (usage) {
      // 记下投影实际大小：下一次 buildContext 据此决定要不要裁（也驱动 UI 的 ctx 占比）。
      session.lastPromptTokens = usage.prompt_tokens;
      emit({ type: "usage", promptTokens: usage.prompt_tokens });
      emit({
        type: "debug",
        text:
          `📊 token: prompt=${usage.prompt_tokens} ` +
          `completion=${usage.completion_tokens} ` +
          `finish_reason=${finishReason}`,
      });
    }

    const toolCalls = assistantMsg.tool_calls;

    // —— 没有 tool_calls：模型给出最终答案，循环结束 ——
    if (!toolCalls || toolCalls.length === 0) {
      emit({
        type: "debug",
        text: `🏁 退出循环（共 ${turn} 轮，最终历史 ${messages.length} 条）: ${timeline(messages)}`,
      });
      // content 类型是 string | ContentPart[] | null；streamModel 里我们
      // 始终把它拼成 string，这里收窄一下让类型也对齐。
      const finalAnswer =
        typeof assistantMsg.content === "string" && assistantMsg.content
          ? assistantMsg.content
          : "(模型没有返回文本内容)";
      logger.section("最终答案");
      logger.log(finalAnswer);
      persist(session); // 落盘本轮完整结果
      return finalAnswer;
    }

    emit({
      type: "debug",
      text: `🧩 本轮模型请求 ${toolCalls.length} 个工具（执行并行 / 审批串行）…`,
    });

    // —— act + observe：执行并行、审批串行、结果按原序配回 ——
    // 模型在一条消息里批量请求的工具默认互不依赖，可并行；但确认门要一次一个、
    // 结果要按 tool_call_id 原序写回（配对不乱）。

    // 阶段 1：先把所有 tool_call 显示出来
    for (const call of toolCalls)
      emit({ type: "tool_call", name: call.function.name, argsText: call.function.arguments });

    // results[i]: 已定结果(被拒/参数错)用字符串占位，null=待并行执行
    const results: (string | null)[] = toolCalls.map(() => null);
    const parsed: (Record<string, unknown> | null)[] = toolCalls.map(() => null);

    // 阶段 2a：解析参数（即时）
    for (let i = 0; i < toolCalls.length; i++) {
      const rawArgs = toolCalls[i]!.function.arguments;
      try {
        parsed[i] = JSON.parse(rawArgs || "{}");
      } catch (err) {
        results[i] = `工具执行出错：参数不是合法 JSON（${err instanceof Error ? err.message : String(err)}）`;
      }
    }

    // 阶段 2b：判定每个危险工具要不要确认。无人值守(autoApprove)直接放行；
    // strict：危险工具一律确认；auto：先过确定性规则（rm/sudo/重定向/外联等，
    // 命中直接要确认——LLM 判官可能被工具输出里的提示注入带偏，规则不会），
    // 规则放行的再让模型判风险（可并行判），只有有风险才确认。
    const interactive = approve !== autoApprove;
    const needConfirm: boolean[] = toolCalls.map(() => false);
    const riskReason: string[] = toolCalls.map(() => "");
    if (interactive) {
      await Promise.all(
        toolCalls.map(async (call, i) => {
          const name = call.function.name;
          if (results[i] !== null || !needsApproval.has(name)) return; // 出错的/安全工具：免确认
          if (approvalMode === "strict") {
            needConfirm[i] = true;
            return;
          }
          const rule = ruleRisk(name, parsed[i]!);
          if (rule) {
            needConfirm[i] = true;
            riskReason[i] = `规则判定：${rule}`;
            return;
          }
          const { risky, reason } = await judgeRisk(name, parsed[i]!, signal);
          needConfirm[i] = risky;
          riskReason[i] = risky ? `模型判定：${reason}` : "";
          if (!risky)
            emit({ type: "note", text: `✓ 自动放行 ${name}（低风险：${reason}）` });
        })
      );
    }

    // 阶段 2c：串行弹确认框（只对 needConfirm 的；一次一个；带风险理由）
    for (let i = 0; i < toolCalls.length; i++) {
      if (results[i] !== null || !needConfirm[i]) continue;
      const { name, arguments: rawArgs } = toolCalls[i]!.function;
      const preview =
        (riskReason[i] ? `[风险] ${riskReason[i]}\n` : "") +
        (await describeForApproval(name, parsed[i]!));
      if (!(await approve({ name, argsText: rawArgs, preview })))
        results[i] = "用户拒绝执行该工具调用。请换一种不需要该操作的方式，或询问用户。";
    }

    // 阶段 3：并行执行（只跑还没定结果的；各自 try/catch；完成即 emit，乱序但带名字）
    // 分派：有状态工具（todo）走 statefulTools（同步、带 ctx）；其余走 pureTools（可异步）。
    const toolCtx: ToolCtx = { plan: session.plan, activeSkills: session.activeSkills, emit, finishReason: finishReason ?? null };
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
        emit({ type: "tool_result", name, result: results[i]! });
      })
    );

    // 阶段 4：按原顺序写回 messages（observation 用 role:"tool"，tool_call_id 对应上）
    for (let i = 0; i < toolCalls.length; i++) {
      const call = toolCalls[i]!;
      logger.log(`[tool] ${call.function.name}(${call.function.arguments}) => ${results[i]}`);
      messages.push({ role: "tool", tool_call_id: call.id, content: results[i]! });
    }
    // 每轮 tool 结果写回后就落一次盘：长任务中途网络报错/崩溃时，
    // 已执行的轮次不丢（否则只有最终答案时才 persist，尾巴全没）。
    persist(session);
    // 带着新的 observation 回到循环顶部，再次 think。
  }

  persist(session);
  return `已达到最大轮数上限（${MAX_TURNS}），未得到最终答案。`;
}
