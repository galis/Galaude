// LangGraph 引擎的图本体：状态通道 + 5 个节点 + 接线。
// 与手写引擎（agent.ts）逐块对应，方便对照学习：
//   compact ≈ maybeCompact/maybeFold   agent ≈ streamModel + 投影
//   judge ≈ 阶段2b（规则+模型判风险）   approve ≈ 阶段2c（串行确认门）
//   tools ≈ 阶段1/2a/3/4（并行执行、原序写回）
// 拓扑：START → compact → agent →(有 tool_calls)→ judge → approve → tools →(未到轮上限)→ agent
//                                 ↘(无 tool_calls)→ END            ↘(到上限)→ END
import {
  Annotation,
  StateGraph,
  MemorySaver,
  START,
  END,
  interrupt,
  messagesStateReducer,
} from "@langchain/langgraph";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { ChatDeepSeek } from "@langchain/deepseek";
import {
  AIMessage,
  ToolMessage,
  isAIMessage,
  type AIMessageChunk,
  type BaseMessage,
} from "@langchain/core/messages";
import { config } from "../config.js";
import { emptyPlan, type TodoPlan } from "../todo.js";
import { loadGlobalMemory, loadProjectMemory } from "../store.js";
import {
  toolSchemas,
  pureTools,
  statefulTools,
  needsApproval,
  describeForApproval,
  ruleRisk,
  type ToolCtx,
} from "../tools.js";
import { getApprovalMode, type Emitter, type ApprovalRequest } from "../events.js";
import type { RunLogger } from "../logger.js";
import {
  buildContextWith,
  pickCompactionRangeWith,
  applyCompaction,
  applyFold,
  pickFoldGroup,
  shouldCompact,
  shouldFold,
  shouldWarn,
  type CompressState,
  type SummarySegment,
} from "../compress.js";
import {
  RISK_JUDGE_SYSTEM,
  SUMMARIZE_SYSTEM,
  FOLD_SYSTEM,
  parseRisk,
  parseSummary,
} from "../llmtasks.js";
import { FLASH_MODEL } from "../llm.js";
import { lcOps, lcText, renderTranscriptLC } from "./messages.js";

// —— 状态通道：messages 用官方 reducer（append 语义 = 我们的「真相源只增」原则），
// 其余通道整值替换。压缩通道与手写 Session 的字段一一对应 → 两边可互相灌。 ——
export const GraphState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  turn: Annotation<number>({ reducer: (_, b) => b, default: () => 0 }), // 本次输入内第几轮 think
  lastPromptTokens: Annotation<number>({ reducer: (_, b) => b, default: () => 0 }),
  summaries: Annotation<SummarySegment[]>({ reducer: (_, b) => b, default: () => [] }),
  summarizedUpTo: Annotation<number>({ reducer: (_, b) => b, default: () => 0 }),
  memory: Annotation<string[]>({ reducer: (_, b) => b, default: () => [] }),
  plan: Annotation<TodoPlan>({ reducer: (_, b) => b, default: emptyPlan }),
  // judge 节点的产物：需要确认的 tool_call（id + 风险理由 + 用户批复）。
  // 放进 state（而不是节点局部变量）是刻意的：approve 节点里的 interrupt 恢复时
  // 会【从节点开头重放】，判风险的 LLM 调用若和 interrupt 同节点就会被反复重跑；
  // 拆成前置节点后，结论过节点边界即被 checkpoint 固化，重放只重放确认本身。
  pendingRisk: Annotation<PendingRisk[]>({ reducer: (_, b) => b, default: () => [] }),
});
export type GState = typeof GraphState.State;

export interface PendingRisk {
  id: string;
  reason: string; // 「规则判定：…」/「模型判定：…」，确认框里展示
  approved?: boolean; // approve 节点填写
}

// —— 运行时依赖（emit/logger/…）经 configurable 注入：不属于持久状态，换一次
// 调用就换一套，所以不能放进 state。 ——
interface Runtime {
  emit: Emitter;
  logger: RunLogger;
  interactive: boolean;
  signal?: AbortSignal;
}
function rt(cfg: LangGraphRunnableConfig): Runtime {
  const c = (cfg.configurable ?? {}) as Partial<Runtime> & { __signal?: AbortSignal };
  return {
    emit: c.emit ?? (() => {}),
    logger: c.logger ?? { path: "", log() {}, section() {} },
    interactive: c.interactive ?? false,
    signal: c.__signal,
  };
}

/** 内部辅助 LLM 调用的精简 config：带上取消信号和回调（LangSmith 父子嵌套），
 * 打上 runName/tags 让 trace 里一眼认出这是判风险/摘要而不是主回答。 */
function internalCfg(cfg: LangGraphRunnableConfig, runName: string) {
  return {
    signal: rt(cfg).signal,
    callbacks: cfg.callbacks,
    runName,
    tags: ["internal"],
  };
}

// —— TRACE_STREAM（协议研究模式）：LangChain 把 SSE 协议细节抽象掉了，想继续研究
// 原始 chunk 就从更底层截——给 openai 客户端塞一个自定义 fetch，把请求体和响应流
// tee 一份进当前运行日志。currentTraceLogger 由 engine.ts 每次运行时指过来。 ——
export let currentTraceLogger: RunLogger | null = null;
export const setTraceLogger = (l: RunLogger | null): void => {
  currentTraceLogger = l;
};

const traceFetch: typeof fetch = async (url, init) => {
  currentTraceLogger?.section("TRACE_STREAM — 原始 HTTP 请求（langgraph 引擎）");
  currentTraceLogger?.log(typeof init?.body === "string" ? init.body : "(非文本请求体)");
  const res = await fetch(url, init);
  if (res.body && currentTraceLogger) {
    const [pass, spy] = res.body.tee();
    (async () => {
      const reader = spy.getReader();
      const dec = new TextDecoder();
      currentTraceLogger?.section("TRACE_STREAM — 原始 SSE 响应流");
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        currentTraceLogger?.log(dec.decode(value, { stream: true }));
      }
    })().catch(() => {});
    return new Response(pass, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  }
  return res;
};

// —— 模型：DeepSeek 走 @langchain/deepseek（能把非标的 reasoning_content 透出到
// additional_kwargs，思维链流式显示不丢）。工具用现成的 OpenAI 格式 schema 直接
// bindTools——不引入 zod 重写一遍声明，两个引擎共用同一份工具定义。 ——
let _model: ChatDeepSeek | null = null;
function model(): ChatDeepSeek {
  if (!_model) {
    _model = new ChatDeepSeek({
      model: config.model,
      apiKey: process.env.DEEPSEEK_API_KEY,
      streamUsage: true, // 流式也带 usage → lastPromptTokens 驱动压缩
      ...(config.traceStream ? { configuration: { fetch: traceFetch } } : {}),
    });
  }
  return _model;
}

/** 内部辅助调用（风险判断/摘要/折叠）用的轻量模型，降成本。 */
let _flashModel: ChatDeepSeek | null = null;
function flashModel(): ChatDeepSeek {
  if (!_flashModel) {
    _flashModel = new ChatDeepSeek({
      model: FLASH_MODEL,
      apiKey: process.env.DEEPSEEK_API_KEY,
      ...(config.traceStream ? { configuration: { fetch: traceFetch } } : {}),
    });
  }
  return _flashModel;
}

const timeline = (ms: BaseMessage[]) =>
  ms
    .map((m) => {
      const t = lcOps.role(m);
      const n =
        isAIMessage(m) && (m as AIMessage).tool_calls?.length
          ? `(+${(m as AIMessage).tool_calls!.length}tc)`
          : "";
      return `${t}${n}`;
    })
    .join(" → ");

const lastAI = (ms: BaseMessage[]): AIMessage | null => {
  const last = ms[ms.length - 1];
  return last && isAIMessage(last) ? (last as AIMessage) : null;
};

// ———————————————————— compact 节点（≈ maybeCompact + maybeFold）————————————————————
async function compactNode(state: GState, cfg: LangGraphRunnableConfig) {
  const { emit, logger } = rt(cfg);
  // 在草稿上跑现成的压缩纯函数（它们是就地修改风格），最后把草稿字段作为通道更新返回。
  const scratch: CompressState<BaseMessage> = {
    messages: state.messages,
    summaries: state.summaries.map((s) => ({ ...s })),
    summarizedUpTo: state.summarizedUpTo,
    memory: [...state.memory],
    lastPromptTokens: state.lastPromptTokens,
    plan: state.plan,
  };
  if (!shouldCompact(scratch)) return {};
  const range = pickCompactionRangeWith(lcOps, scratch);
  if (!range) return {};

  const slice = state.messages.slice(range[0], range[1] + 1);
  emit({
    type: "debug",
    text: `🗜 折叠 messages[${range[0]}..${range[1]}]（${slice.length} 条）成摘要 …`,
  });
  const res = await flashModel().invoke(
    [
      { role: "system", content: SUMMARIZE_SYSTEM },
      { role: "user", content: "对话片段：\n\n" + renderTranscriptLC(slice) },
    ],
    internalCfg(cfg, "summarizeChunk")
  );
  // 内部调用也要上报 token 用量，否则 UI 计费漏算
  // 所有字段优先从 usage_metadata 取，rawUsage 仅做回退
  {
    const rawU = (res.response_metadata as { usage?: Record<string, number> }).usage;
    const rum = res.usage_metadata as Record<string, number> | undefined;
    emit({ type: "usage",
      promptTokens: res.usage_metadata?.input_tokens ?? rawU?.prompt_tokens ?? 0,
      completionTokens: res.usage_metadata?.output_tokens ?? rawU?.completion_tokens ?? 0,
      cacheHitTokens: rum?.prompt_cache_hit_tokens ?? rawU?.prompt_cache_hit_tokens,
      cacheMissTokens: rum?.prompt_cache_miss_tokens ?? rawU?.prompt_cache_miss_tokens,
      timestamp: new Date().toISOString() });
  }
  const { summary, facts } = parseSummary(lcText(res));
  applyCompaction(scratch, range, summary);
  for (const f of facts) if (!scratch.memory.includes(f)) scratch.memory.push(f);
  logger.section(
    `🗜 折叠摘要 messages[${range[0]}..${range[1]}]（${slice.length} 条）` +
      (facts.length ? `；抽取事实 ${facts.length} 条` : "")
  );
  logger.log(summary + (facts.length ? "\n事实:\n- " + facts.join("\n- ") : ""));
  emit({
    type: "note",
    text:
      `🗜 已把早前 ${slice.length} 条消息折叠成摘要` +
      (facts.length ? `，记住 ${facts.length} 条事实` : "") +
      "（ctx 下降）",
  });

  // 分级折叠（层 B 触顶）
  while (shouldFold(scratch)) {
    const group = pickFoldGroup(scratch);
    if (!group) break;
    const texts = scratch.summaries.slice(group[0], group[1] + 1).map((x) => x.text);
    const folded = await flashModel().invoke(
      [
        { role: "system", content: FOLD_SYSTEM },
        { role: "user", content: texts.map((t, i) => `[摘要${i + 1}]\n${t}`).join("\n\n") },
      ],
      internalCfg(cfg, "summarizeTexts")
    );
    applyFold(scratch, group, lcText(folded).trim() || texts.join(" / "));
    // 内部 fold 调用也要上报 token
    {
      const rawU = (folded.response_metadata as { usage?: Record<string, number> }).usage;
      const rum = folded.usage_metadata as Record<string, number> | undefined;
      emit({ type: "usage",
        promptTokens: folded.usage_metadata?.input_tokens ?? rawU?.prompt_tokens ?? 0,
        completionTokens: folded.usage_metadata?.output_tokens ?? rawU?.completion_tokens ?? 0,
        cacheHitTokens: rum?.prompt_cache_hit_tokens ?? rawU?.prompt_cache_hit_tokens,
        cacheMissTokens: rum?.prompt_cache_miss_tokens ?? rawU?.prompt_cache_miss_tokens,
        timestamp: new Date().toISOString() });
    }
    logger.section(`🗜🗜 二级折叠 摘要段[${group[0]}..${group[1]}]`);
    emit({
      type: "note",
      text: `🗜 摘要过多，已把 ${group[1] - group[0] + 1} 段旧摘要再折一层`,
    });
  }
  if (shouldWarn(scratch))
    emit({
      type: "note",
      text: "⚠️ 对话很长、早期内容已重度压缩，关键信息可能丢失；可 /new 开一个聚焦的新会话",
    });

  return {
    summaries: scratch.summaries,
    summarizedUpTo: scratch.summarizedUpTo,
    memory: scratch.memory,
  };
}

// ———————————————————— agent 节点（≈ streamModel + 投影）————————————————————
async function agentNode(state: GState, cfg: LangGraphRunnableConfig) {
  const { emit, logger, signal } = rt(cfg);
  const turn = state.turn + 1;
  emit({ type: "debug", text: `──────── 第 ${turn} 轮：调用模型（langgraph）────────` });
  emit({
    type: "debug",
    text: `📤 发送历史（${state.messages.length} 条）: ${timeline(state.messages)}`,
  });

  // 投影：真相源 messages 不动，发送前套 buildContext（与手写引擎同一套纯函数，LC 方言）。
  const ctx = buildContextWith(lcOps, {
    messages: state.messages,
    summaries: state.summaries,
    summarizedUpTo: state.summarizedUpTo,
    memory: state.memory,
    globalMemory: loadGlobalMemory(),
    projectMemory: loadProjectMemory(),
    lastPromptTokens: state.lastPromptTokens,
    plan: state.plan,
  });
  logger.section(
    `第 ${turn} 轮 — 发送给模型的 messages（投影：原文 ${state.messages.length} 条 → 发送 ${ctx.length} 条；上轮 ctx≈${state.lastPromptTokens} tok）`
  );
  if (config.traceStream) logger.log(JSON.stringify(ctx, null, 2));
  else logger.log(timeline(ctx));

  // 节点内自己消费 token 流并直接发事件——与手写 streamModel 行为逐字对齐，
  // 也不依赖外层 streamMode 的形状（那是另一种做法，见 docs 对照笔记）。
  const stream = await model()
    .bindTools(toolSchemas)
    .stream(ctx, { signal, callbacks: cfg.callbacks, runName: "think" });
  let acc: AIMessageChunk | null = null;
  let reasoning = "";
  let content = "";
  // 截获最后一片带 usage 的 chunk 的原始数据——累加前取值，避开 concat 翻倍
  let lastChunkUsage: Record<string, number> | undefined;
  for await (const chunk of stream) {
    const r = (chunk.additional_kwargs as { reasoning_content?: string } | undefined)
      ?.reasoning_content;
    if (r) {
      reasoning += r;
      emit({ type: "reasoning", text: r });
    }
    if (typeof chunk.content === "string" && chunk.content) {
      content += chunk.content;
      emit({ type: "assistant", text: chunk.content });
    }
    // 在 concat 之前，先从原始 chunk 取 usage（单片的，不翻倍）
    const chunkUsage = (chunk.response_metadata as { usage?: Record<string, number> } | undefined)?.usage;
    if (chunkUsage?.prompt_tokens) lastChunkUsage = chunkUsage;
    acc = acc ? acc.concat(chunk) : chunk;
  }

  // chunk 聚合体转成普通 AIMessage 存进状态（含拼好的 tool_calls / usage / finish_reason）。
  const aiMsg = new AIMessage({
    content: acc && typeof acc.content === "string" ? acc.content : content,
    tool_calls: acc?.tool_calls ?? [],
    invalid_tool_calls: acc?.invalid_tool_calls ?? [],
    additional_kwargs: acc?.additional_kwargs ?? {},
    response_metadata: acc?.response_metadata ?? {},
    ...(acc?.usage_metadata ? { usage_metadata: acc.usage_metadata } : {}),
  });

  logger.section(`第 ${turn} 轮 — 流式接收内容`);
  if (reasoning) logger.log(`[思考 reasoning_content]\n${reasoning}\n`);
  logger.log(`[正文 content]\n${lcText(aiMsg) || "(空：本轮只发了 tool_calls)"}`);
  if (aiMsg.tool_calls?.length)
    logger.log(`[拼好的 tool_calls]\n${JSON.stringify(aiMsg.tool_calls, null, 2)}`);

  // 所有 token 字段优先从 lastChunkUsage 取（累加前的原始值，不翻倍），
  // 其次回退到 usage_metadata（标准字段可靠），最后用 response_metadata.usage。
  const um = acc?.usage_metadata;
  const rum = um as Record<string, number> | undefined;
  const rawUsage = (aiMsg.response_metadata as { usage?: Record<string, number> }).usage;
  const inTok = lastChunkUsage?.prompt_tokens ?? um?.input_tokens ?? rawUsage?.prompt_tokens ?? 0;
  const outTok = lastChunkUsage?.completion_tokens ?? um?.output_tokens ?? rawUsage?.completion_tokens ?? 0;
  const cacheHit = lastChunkUsage?.prompt_cache_hit_tokens ?? rum?.prompt_cache_hit_tokens ?? rawUsage?.prompt_cache_hit_tokens ?? 0;
  const cacheMiss = lastChunkUsage?.prompt_cache_miss_tokens ?? rum?.prompt_cache_miss_tokens ?? rawUsage?.prompt_cache_miss_tokens ?? 0;
  if (inTok > 0 || cacheHit > 0 || cacheMiss > 0) {
    emit({ type: "usage", promptTokens: inTok, completionTokens: outTok,
      cacheHitTokens: cacheHit, cacheMissTokens: cacheMiss,
      timestamp: new Date().toISOString() });
    emit({
      type: "debug",
      text: `📊 token: prompt=${inTok} completion=${outTok} `
        + `cache_hit=${cacheHit} cache_miss=${cacheMiss} finish_reason=${
        (aiMsg.response_metadata as { finish_reason?: string }).finish_reason ?? "?"
      }`,
    });
  }

  return {
    messages: [aiMsg],
    turn,
    ...(inTok > 0 ? { lastPromptTokens: inTok } : {}),
  };
}

// ———————————————————— judge 节点（≈ 阶段2b：规则 + 模型判风险）————————————————————
async function judgeNode(state: GState, cfg: LangGraphRunnableConfig) {
  const { emit, interactive } = rt(cfg);
  const ai = lastAI(state.messages);
  const calls = ai?.tool_calls ?? [];
  // 无人值守（一次性/管道）：与手写引擎一致，全部放行、不判风险。
  if (!interactive || calls.length === 0) return { pendingRisk: [] };

  const risks: PendingRisk[] = [];
  await Promise.all(
    calls.map(async (tc) => {
      if (!needsApproval.has(tc.name)) return; // 安全工具免确认
      const id = tc.id ?? tc.name;
      if (getApprovalMode() === "strict") {
        risks.push({ id, reason: "" });
        return;
      }
      const rule = ruleRisk(tc.name, (tc.args ?? {}) as Record<string, unknown>);
      if (rule) {
        risks.push({ id, reason: `规则判定：${rule}` });
        return;
      }
      try {
        const res = await flashModel().invoke(
          [
            { role: "system", content: RISK_JUDGE_SYSTEM },
            { role: "user", content: `工具: ${tc.name}\n参数: ${JSON.stringify(tc.args)}` },
          ],
          internalCfg(cfg, "judgeRisk")
        );
        const { risky, reason } = parseRisk(lcText(res));
        // 内部判风险调用也要上报 token
        {
          const rawU = (res.response_metadata as { usage?: Record<string, number> }).usage;
          const rum = res.usage_metadata as Record<string, number> | undefined;
          emit({ type: "usage",
            promptTokens: res.usage_metadata?.input_tokens ?? rawU?.prompt_tokens ?? 0,
            completionTokens: res.usage_metadata?.output_tokens ?? rawU?.completion_tokens ?? 0,
            cacheHitTokens: rum?.prompt_cache_hit_tokens ?? rawU?.prompt_cache_hit_tokens,
            cacheMissTokens: rum?.prompt_cache_miss_tokens ?? rawU?.prompt_cache_miss_tokens,
            timestamp: new Date().toISOString() });
        }
        if (risky) risks.push({ id, reason: `模型判定：${reason}` });
        else emit({ type: "note", text: `✓ 自动放行 ${tc.name}（低风险：${reason}）` });
      } catch {
        risks.push({ id, reason: "风险判定失败，保守起见需确认" }); // fail-safe
      }
    })
  );
  return { pendingRisk: risks };
}

// ———————————————————— approve 节点（≈ 阶段2c：串行确认门）————————————————————
// ⚠️ 本节点只做 interrupt：恢复时它会从头重放，已回答的 interrupt 走缓存、
// 未回答的重新挂起（探针已验证）。describeForApproval 只是幂等的读文件做 diff
// 预览，重放无害；任何贵的/有副作用的活都必须放在上游节点（judge）里。
async function approveNode(state: GState, _cfg: LangGraphRunnableConfig) {
  const ai = lastAI(state.messages);
  const decided: PendingRisk[] = [];
  for (const pr of state.pendingRisk) {
    const tc = ai?.tool_calls?.find((t) => (t.id ?? t.name) === pr.id);
    if (!tc) continue;
    const preview =
      (pr.reason ? `[风险] ${pr.reason}\n` : "") +
      (await describeForApproval(tc.name, (tc.args ?? {}) as Record<string, unknown>));
    const req: ApprovalRequest = {
      name: tc.name,
      argsText: JSON.stringify(tc.args ?? {}),
      preview,
    };
    // 图挂起 → 适配器把它接回 UI 的确认框。恢复值包成 { ok }：直接 resume 布尔值的话，
    // false 是 falsy，会被 LangGraph 的空 Command 检查当成「没给输入」而拒收。
    const res = interrupt(req) as { ok?: boolean } | boolean;
    const ok = typeof res === "object" && res !== null ? Boolean(res.ok) : Boolean(res);
    decided.push({ ...pr, approved: ok });
  }
  return { pendingRisk: decided };
}

// ———————————————————— tools 节点（≈ 阶段1/2a/3/4）————————————————————
async function toolsNode(state: GState, cfg: LangGraphRunnableConfig) {
  const { emit, logger } = rt(cfg);
  const ai = lastAI(state.messages);
  const calls = ai?.tool_calls ?? [];
  const invalid = ai?.invalid_tool_calls ?? [];
  emit({
    type: "debug",
    text: `🧩 本轮模型请求 ${calls.length + invalid.length} 个工具（执行并行 / 审批已在上游串行）…`,
  });

  // 阶段 1：先把所有 tool_call 显示出来
  for (const tc of calls)
    emit({ type: "tool_call", name: tc.name, argsText: JSON.stringify(tc.args ?? {}) });

  const rejected = new Set(
    state.pendingRisk.filter((p) => p.approved === false).map((p) => p.id)
  );
  // todo 等有状态工具在草稿计划上跑，结束后整体作为通道更新返回（state 不就地改）。
  const scratchPlan: TodoPlan = {
    todos: state.plan.todos.map((t) => ({ ...t })),
    nextId: state.plan.nextId,
  };
  const finishReason =
    ((ai?.response_metadata as { finish_reason?: string } | undefined)?.finish_reason ??
      null);
  const toolCtx: ToolCtx = { plan: scratchPlan, emit, finishReason };

  // 阶段 3：并行执行（被拒的用占位结果；各自 try/catch；完成即 emit）
  const results = await Promise.all(
    calls.map(async (tc) => {
      const id = tc.id ?? tc.name;
      let out: string;
      if (rejected.has(id)) {
        out = "用户拒绝执行该工具调用。请换一种不需要该操作的方式，或询问用户。";
      } else {
        try {
          const args = (tc.args ?? {}) as Record<string, unknown>;
          const stateful = statefulTools[tc.name];
          if (stateful) out = stateful(args, toolCtx);
          else {
            const impl = pureTools[tc.name];
            out = impl ? await impl(args) : `错误：未知工具 "${tc.name}"`;
          }
        } catch (err) {
          out = `工具执行出错：${err instanceof Error ? err.message : String(err)}`;
        }
      }
      emit({ type: "tool_result", name: tc.name, result: out });
      logger.log(`[tool] ${tc.name}(${JSON.stringify(tc.args ?? {})}) => ${out}`);
      return new ToolMessage({ content: out, tool_call_id: id, name: tc.name });
    })
  );
  // 参数不是合法 JSON 的调用（LC 已归入 invalid_tool_calls）：回喂错误让模型自纠
  const invalidResults = invalid.map((tc, i) => {
    const out = `工具执行出错：参数不是合法 JSON（${tc.error ?? "解析失败"}）`;
    emit({ type: "tool_result", name: tc.name ?? "unknown", result: out });
    return new ToolMessage({ content: out, tool_call_id: tc.id ?? `invalid_${i}` });
  });

  return { messages: [...results, ...invalidResults], plan: scratchPlan, pendingRisk: [] };
}

// ———————————————————— 路由 ————————————————————
// 注意：finish_reason=length 且带 tool_calls 时【仍然】走工具链路——直接 END 会把
// 悬挂的 tool_calls 留在历史里，下一轮 API 会因配对不完整报 400。截断自守由
// todowrite 的 F1 检查负责（与手写引擎一致）。
function routeAfterAgent(state: GState): "judge" | typeof END {
  const ai = lastAI(state.messages);
  return ai && ((ai.tool_calls?.length ?? 0) > 0 || (ai.invalid_tool_calls?.length ?? 0) > 0)
    ? "judge"
    : END;
}

// 轮数上限：到点就不再回 agent（本轮工具结果已写回，语义与手写引擎的循环出口一致）。
function routeAfterTools(state: GState): "agent" | typeof END {
  return state.turn >= config.maxTurns ? END : "agent";
}

// ———————————————————— 组图（进程内单例；MemorySaver 见 engine.ts 说明）————————————————————
let _graph: ReturnType<typeof build> | null = null;
function build() {
  return new StateGraph(GraphState)
    .addNode("compact", compactNode)
    .addNode("agent", agentNode)
    .addNode("judge", judgeNode)
    .addNode("approve", approveNode)
    .addNode("tools", toolsNode)
    .addEdge(START, "compact")
    .addEdge("compact", "agent")
    .addConditionalEdges("agent", routeAfterAgent, ["judge", END])
    .addEdge("judge", "approve")
    .addEdge("approve", "tools")
    .addConditionalEdges("tools", routeAfterTools, ["agent", END])
    .compile({ checkpointer: new MemorySaver() });
}
export function getGraph() {
  if (!_graph) _graph = build();
  return _graph;
}
