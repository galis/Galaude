import type OpenAI from "openai";
import { config } from "./config.js";

type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;

const { budget, trimFrac, keepRecentTools, trimMin } = config.compress;

/** 上下文 token 预算（窗口 W），供 UI 显示 ctx 占比。 */
export const ctxBudget = budget;
/** 超过这个 token 数就开始裁旧工具输出。 */
export const trimThreshold = budget * trimFrac;

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
 * 层 A：裁旧工具输出。保留最近 keepRecentTools 条 role:"tool" 原文，
 * 更早且较大的换成 headTail 占位。
 *
 * 关键：只改 tool 消息的 content、绝不删消息 → 消息条数 / tool_call_id / 顺序
 * 全不变 → 天然不破坏「assistant(tool_calls) 必须紧跟同 id 的 tool 结果」配对。
 */
function trimOldToolOutputs(messages: Message[]): Message[] {
  const toolIdx = messages.flatMap((m, i) => (m.role === "tool" ? [i] : []));
  const keepFrom = Math.max(0, toolIdx.length - keepRecentTools);
  const keep = new Set(toolIdx.slice(keepFrom)); // 最近 N 条工具消息留全
  return messages.map((m, i) =>
    m.role === "tool" &&
    !keep.has(i) &&
    typeof m.content === "string" &&
    m.content.length > trimMin
      ? { ...m, content: headTail(m.content) }
      : m
  );
}

/**
 * 构造这一轮发给模型的「投影」——真相源 messages 的临时视图，**绝不改 messages**。
 *
 * P1：上下文还宽裕（≤ trimThreshold）就原样发（最佳缓存命中、零保真损失）；
 *     偏大才裁旧工具输出。
 * P2/P3（待做）：在此前置「外置记忆 + 旧段摘要」，并用水位线把 messages[1..k]
 *     替换成摘要——接口就从这里扩展（再加 summaries/memory 参数）。
 */
export function buildContext(
  messages: Message[],
  lastPromptTokens: number
): Message[] {
  if (lastPromptTokens <= trimThreshold) return messages; // 宽裕：原样发
  return trimOldToolOutputs(messages); // 偏大：裁旧工具输出
}
