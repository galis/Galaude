import type OpenAI from "openai";
import { config } from "./config.js";

type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;

const { budget, trimFrac, summarizeFrac, keepRecentTools, keepRecentTurns, trimMin } =
  config.compress;

/** 上下文 token 预算（窗口 W），供 UI 显示 ctx 占比。 */
export const ctxBudget = budget;
/** 超过这个 token 数就开始裁旧工具输出（层 A）。 */
export const trimThreshold = budget * trimFrac;

/** 一段摘要：覆盖 messages[range[0]..range[1]]，append-only。 */
export interface SummarySegment {
  range: [number, number];
  level: number;
  text: string;
}

/** buildContext / 折叠所需的会话状态（Session 在结构上满足它）。 */
export interface CompressState {
  messages: Message[];
  summaries: SummarySegment[];
  summarizedUpTo: number; // messages[1..k] 已被 summaries 覆盖（messages[0]=system 不算）
  memory: string[];
  lastPromptTokens: number;
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
function trimOldToolOutputs(messages: Message[]): Message[] {
  const toolIdx = messages.flatMap((m, i) => (m.role === "tool" ? [i] : []));
  const keepFrom = Math.max(0, toolIdx.length - keepRecentTools);
  const keep = new Set(toolIdx.slice(keepFrom));
  return messages.map((m, i) =>
    m.role === "tool" &&
    !keep.has(i) &&
    typeof m.content === "string" &&
    m.content.length > trimMin
      ? { ...m, content: headTail(m.content) }
      : m
  );
}

// ———————————————————— 层 B/C：摘要 + 外置记忆 ————————————————————

function memoryMessage(memory: string[]): Message {
  return {
    role: "system",
    content: "【已知事实（请始终遵守）】\n" + memory.map((s) => "- " + s).join("\n"),
  };
}

function summaryMessage(summaries: SummarySegment[]): Message {
  return {
    role: "system",
    content:
      "【早前对话摘要（更久远的历史已折叠成下面要点）】\n" +
      summaries.map((s) => s.text).join("\n\n"),
  };
}

/**
 * 构造这一轮发给模型的「投影」——真相源 messages 的临时视图，**绝不改 messages**。
 *
 * 结构：system（缓存根，永不变） + 外置记忆 + 旧段摘要 + 近段原文（messages[k+1..]）。
 * - 摘要/记忆放在 system 之后、近段之前，作为独立 system 消息：首条 system 稳定可缓存，
 *   摘要块只在折叠时变一次。
 * - 近段起点 messages[k+1] 落在轮边界（user 消息），所以「全 system 在前、user 在后」序列合法。
 * - 近段里偏旧的大工具输出再走层 A 裁一道。
 */
export function buildContext(s: CompressState): Message[] {
  const { messages, summaries, summarizedUpTo: k, memory, lastPromptTokens } = s;
  const system = messages[0];
  const ctx: Message[] = system ? [system] : [];
  if (memory.length) ctx.push(memoryMessage(memory));
  if (summaries.length) ctx.push(summaryMessage(summaries));

  let recent = messages.slice(k + 1); // 近段（system 与已摘要段之后）
  if (lastPromptTokens > trimThreshold) recent = trimOldToolOutputs(recent);
  ctx.push(...recent);
  return ctx;
}

// ———————————————————— 折叠（compaction）逻辑：纯函数，LLM 调用由外层注入 ————————————————————

/** 是否该折叠：投影大小超过 budget*summarizeFrac。 */
export function shouldCompact(s: CompressState): boolean {
  return s.lastPromptTokens > budget * summarizeFrac;
}

/**
 * 选出本次该折叠的原文区间 [start, end]（含），或 null（还不该折）。
 *
 * 轮边界：user 消息处。保留最近 keepRecentTurns 轮原文不折；把水位线之后、
 * 到「最近窗口起点」之前的完整若干轮折成一段。start 一定是 user（轮起点），
 * end 一定是某轮最后一条 → 区间是若干完整轮，绝不切断 tool_call/tool 对。
 */
export function pickCompactionRange(s: CompressState): [number, number] | null {
  const { messages, summarizedUpTo: k } = s;
  const userIdx = messages.flatMap((m, i) => (m.role === "user" ? [i] : []));
  if (userIdx.length <= keepRecentTurns) return null; // 还没攒够轮数
  const recentStart = userIdx[userIdx.length - keepRecentTurns]!; // 最近窗口起点(user)
  const start = k + 1;
  const end = recentStart - 1;
  if (end < start) return null; // 没有新的可折
  return [start, end];
}

/** 把一段摘要追加进状态（append-only），推进水位线。 */
export function applyCompaction(
  s: CompressState,
  range: [number, number],
  text: string
): void {
  s.summaries.push({ range, level: 1, text });
  s.summarizedUpTo = range[1];
}
