import type OpenAI from "openai";
import { config } from "./config.js";
import { renderTodos, type TodoPlan } from "./todo.js";

type OAIMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

const {
  budget,
  trimFrac,
  summarizeFrac,
  keepRecentTools,
  keepRecentTurns,
  trimMin,
  foldFrac,
  foldGroupSize,
  warnFrac,
} = config.compress;

/** 粗估 token 数（中英文混合，约 3 字符/token）。 */
const roughTokens = (text: string) => Math.ceil(text.length / 3);

/** 上下文 token 预算（窗口 W），供 UI 显示 ctx 占比。 */
export const ctxBudget = budget;
/** 超过这个 token 数就开始裁旧工具输出（层 A）。 */
export const trimThreshold = budget * trimFrac;

// ———————————————————— 消息方言适配 ————————————————————
// 压缩逻辑本身与「消息长什么样」无关：手写引擎用 OpenAI wire 格式，
// LangGraph 引擎用 LangChain 的 BaseMessage。这里只依赖 4 个操作，
// 两个引擎各自提供实现（LC 版见 src/lgraph/messages.ts）。

export type MsgRole = "system" | "user" | "assistant" | "tool" | "other";

export interface MessageOps<M> {
  role(m: M): MsgRole;
  /** 纯文本 content；不是字符串（多模态等）返回 null，压缩就不碰它。 */
  text(m: M): string | null;
  /** 克隆一条消息并替换其文本 content（裁剪工具输出用，其余字段保留）。 */
  withText(m: M, text: string): M;
  /** 构造一条 system 消息（记忆/摘要/任务清单块）。 */
  system(text: string): M;
}

/** OpenAI wire 格式的方言实现（手写引擎；也是存盘格式）。 */
export const oaiOps: MessageOps<OAIMessage> = {
  role(m) {
    return m.role === "system" ||
      m.role === "user" ||
      m.role === "assistant" ||
      m.role === "tool"
      ? m.role
      : "other";
  },
  text(m) {
    return typeof m.content === "string" ? m.content : null;
  },
  withText(m, text) {
    return { ...m, content: text };
  },
  system(text) {
    return { role: "system", content: text };
  },
};

/** 一段摘要：覆盖 messages[range[0]..range[1]]，append-only。 */
export interface SummarySegment {
  range: [number, number];
  level: number;
  text: string;
}

/** buildContext / 折叠所需的会话状态（Session 在结构上满足它）。 */
export interface CompressState<M = OAIMessage> {
  messages: M[];
  summaries: SummarySegment[];
  summarizedUpTo: number; // messages[1..k] 已被 summaries 覆盖（messages[0]=system 不算）
  memory: string[];
  lastPromptTokens: number;
  plan?: TodoPlan; // 任务清单（豁免压缩、每轮回注）
}

// ———————————————————— 层 A：裁旧工具输出 ————————————————————

/**
 * 把一段工具输出裁成「头几行 + 省略提示 + 尾几行」。
 * 纯确定函数：同样的输入永远同样输出 → 不会无谓击穿 prompt 前缀缓存。
 */
export function headTail(content: string, head = 4, tail = 4): string {
  const lines = content.split("\n");
  if (lines.length <= head + tail + 2) return content; // 没几行，裁了不划算
  const omitted = lines.length - head - tail;
  const bytes = Buffer.byteLength(content);
  return [
    ...lines.slice(0, head),
    `… 中间 ${omitted} 行已省略（原 ${bytes} 字节）；需要可重新调用该工具 …`,
    ...lines.slice(-tail),
  ].join("\n");
}

/**
 * 保留最近 keepRecentTools 条 role:"tool" 原文，更早且较大的换成占位。
 * 只改 content、绝不删消息 → 天然不破坏 tool_call/tool 配对。
 */
function trimOldToolOutputs<M>(ops: MessageOps<M>, messages: M[]): M[] {
  const toolIdx = messages.flatMap((m, i) => (ops.role(m) === "tool" ? [i] : []));
  const keepFrom = Math.max(0, toolIdx.length - keepRecentTools);
  const keep = new Set(toolIdx.slice(keepFrom));
  return messages.map((m, i) => {
    if (ops.role(m) !== "tool" || keep.has(i)) return m;
    const text = ops.text(m);
    return text !== null && text.length > trimMin ? ops.withText(m, headTail(text)) : m;
  });
}

// ———————————————————— 层 B/C：摘要 + 外置记忆 ————————————————————

const memoryText = (memory: string[]) =>
  "【已知事实（请始终遵守）】\n" + memory.map((s) => "- " + s).join("\n");

const summaryText = (summaries: SummarySegment[]) =>
  "【早前对话摘要（更久远的历史已折叠成下面要点）】\n" +
  summaries.map((s) => s.text).join("\n\n");

const todoText = (plan: TodoPlan) =>
  "【当前任务清单（你自己维护的多步进度；完成/新增用 todowrite 更新，尽量保留每项 #id）】\n" +
  renderTodos(plan.todos);

/**
 * 构造这一轮发给模型的「投影」——真相源 messages 的临时视图，**绝不改 messages**。
 *
 * 结构：system（缓存根，永不变） + 外置记忆 + 旧段摘要 + 近段原文（messages[k+1..]）。
 * - 摘要/记忆放在 system 之后、近段之前，作为独立 system 消息：首条 system 稳定可缓存，
 *   摘要块只在折叠时变一次。
 * - 近段起点 messages[k+1] 落在轮边界（user 消息），所以「全 system 在前、user 在后」序列合法。
 * - 近段里偏旧的大工具输出再走层 A 裁一道。
 */
export function buildContextWith<M>(ops: MessageOps<M>, s: CompressState<M>): M[] {
  const { messages, summaries, summarizedUpTo: k, memory, lastPromptTokens, plan } = s;
  const system = messages[0];
  const ctx: M[] = system ? [system] : [];
  if (memory.length) ctx.push(ops.system(memoryText(memory)));
  if (summaries.length) ctx.push(ops.system(summaryText(summaries)));
  if (plan && plan.todos.length) ctx.push(ops.system(todoText(plan))); // 任务清单：记忆/摘要后·近段前，豁免压缩

  let recent = messages.slice(k + 1); // 近段（system 与已摘要段之后）
  if (lastPromptTokens > trimThreshold) recent = trimOldToolOutputs(ops, recent);
  ctx.push(...recent);
  return ctx;
}

/** OpenAI 方言绑定版（手写引擎 / UI 直接用，签名不变）。 */
export const buildContext = (s: CompressState): OAIMessage[] =>
  buildContextWith(oaiOps, s);

// ———————————————————— 折叠（compaction）逻辑：纯函数，LLM 调用由外层注入 ————————————————————

/** 是否该折叠：投影大小超过 budget*summarizeFrac。 */
export function shouldCompact(s: CompressState<unknown>): boolean {
  return s.lastPromptTokens > budget * summarizeFrac;
}

/**
 * 选出本次该折叠的原文区间 [start, end]（含），或 null（还不该折）。
 *
 * 轮边界：user 消息处。保留最近 keepRecentTurns 轮原文不折；把水位线之后、
 * 到「最近窗口起点」之前的完整若干轮折成一段。start 一定是 user（轮起点），
 * end 一定是某轮最后一条 → 区间是若干完整轮，绝不切断 tool_call/tool 对。
 */
export function pickCompactionRangeWith<M>(
  ops: MessageOps<M>,
  s: CompressState<M>
): [number, number] | null {
  const { messages, summarizedUpTo: k } = s;
  const userIdx = messages.flatMap((m, i) => (ops.role(m) === "user" ? [i] : []));
  if (userIdx.length <= keepRecentTurns) return null; // 还没攒够轮数
  const recentStart = userIdx[userIdx.length - keepRecentTurns]!; // 最近窗口起点(user)
  const start = k + 1;
  const end = recentStart - 1;
  if (end < start) return null; // 没有新的可折
  return [start, end];
}

/** OpenAI 方言绑定版。 */
export const pickCompactionRange = (s: CompressState): [number, number] | null =>
  pickCompactionRangeWith(oaiOps, s);

/** 把一段摘要追加进状态（append-only），推进水位线。 */
export function applyCompaction(
  s: CompressState<unknown>,
  range: [number, number],
  text: string
): void {
  s.summaries.push({ range, level: 1, text });
  s.summarizedUpTo = range[1];
}

// ———————————————————— 分级折叠（层 B 触顶）：把若干旧摘要再折一层 ————————————————————

/** 摘要本身占的 token 估算超过 budget*foldFrac → 该做二级折叠。 */
export function shouldFold(s: CompressState<unknown>): boolean {
  const tok = s.summaries.reduce((n, seg) => n + roughTokens(seg.text), 0);
  return tok > budget * foldFrac;
}

/** 当前摘要里的最高层级（0=无摘要，1=一级，2=二级…）。用于软提示判断。 */
export function maxSummaryLevel(s: CompressState<unknown>): number {
  return s.summaries.reduce((mx, x) => Math.max(mx, x.level), 0);
}

/** ctx 偏大或出现高层摘要 → 该软提示用户。 */
export function shouldWarn(s: CompressState<unknown>): boolean {
  return s.lastPromptTokens > budget * warnFrac || maxSummaryLevel(s) >= 2;
}

/**
 * 选出要再折一层的「最旧、连续、同最低层级」的一组摘要段。
 * 返回 [i, j]（含）或 null。folds 是把 segs[i..j] 这组合并成一条更高层级的段。
 */
export function pickFoldGroup(s: CompressState<unknown>): [number, number] | null {
  const segs = s.summaries;
  if (segs.length < foldGroupSize) return null;
  const minLevel = Math.min(...segs.map((x) => x.level));
  const start = segs.findIndex((x) => x.level === minLevel);
  if (start < 0) return null;
  let end = start;
  while (
    end + 1 < segs.length &&
    segs[end + 1]!.level === minLevel &&
    end - start + 1 < foldGroupSize
  )
    end++;
  return end - start + 1 >= foldGroupSize ? [start, end] : null;
}

/** 用合并后的文本，把 segs[i..j] 这组替换成一条更高层级的摘要段。 */
export function applyFold(
  s: CompressState<unknown>,
  group: [number, number],
  text: string
): void {
  const [i, j] = group;
  const segs = s.summaries;
  const range: [number, number] = [segs[i]!.range[0], segs[j]!.range[1]];
  const level = Math.max(...segs.slice(i, j + 1).map((x) => x.level)) + 1;
  segs.splice(i, j - i + 1, { range, level, text });
}

// ———————————————————— 上下文占用报告（/context 用）————————————————————

/** 生成一份可读的上下文占用细分（真相源 / 已折叠 / 摘要 / 记忆 / 近段 / 本轮投影）。 */
export function contextReport(s: CompressState): string {
  const { messages, summaries, summarizedUpTo: k, memory, lastPromptTokens } = s;
  const pct = Math.round((lastPromptTokens / budget) * 100);
  const recent = Math.max(0, messages.length - 1 - k); // 近段消息数（除 system）
  const levels: Record<number, number> = {};
  for (const seg of summaries) levels[seg.level] = (levels[seg.level] ?? 0) + 1;
  const levelStr =
    Object.entries(levels)
      .map(([l, n]) => `level${l}×${n}`)
      .join(", ") || "无";
  const proj = buildContext(s).length;

  const out = [
    "📊 上下文占用情况",
    `  ctx: ${lastPromptTokens} / ${budget} tok (${pct}%)  —— 裁剪@${Math.round(
      trimFrac * 100
    )}% 折叠@${Math.round(summarizeFrac * 100)}%`,
    `  完整历史: ${messages.length} 条消息（真相源，存盘/界面用，永不删）`,
    summaries.length
      ? `  已折叠: messages[1..${k}] → 摘要 ${summaries.length} 段（${levelStr}）`
      : "  已折叠: 无（还没触发摘要）",
    `  外置记忆: ${memory.length} 条事实（豁免压缩，每轮必带）`,
    `  近段原文: ${recent} 条（发给模型时带全）`,
    `  → 本轮投影: 实际发给模型 ${proj} 条消息${
      lastPromptTokens > trimThreshold ? "（近段含裁剪）" : ""
    }`,
  ];
  if (memory.length) {
    out.push("  记忆内容:");
    for (const f of memory.slice(0, 8)) out.push(`    • ${f}`);
    if (memory.length > 8) out.push(`    …（共 ${memory.length} 条）`);
  }
  return out.join("\n");
}
