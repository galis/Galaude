// 消息「方言」桥：OpenAI wire 格式（真相源/存盘） ↔ LangChain BaseMessage（图状态）。
// 会话 JSON 永远存 OpenAI 格式——它同时是手写引擎的运行格式，也是两个引擎共享的
// 唯一真相源；LangGraph 线程只是它的运行时视图（进程内 MemorySaver，见 engine.ts）。
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  isAIMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type OpenAI from "openai";
import type { MessageOps } from "../compress.js";

type OAIMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type OAIAssistant = OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam;

/** LC content 可能是分块数组（多模态）；我们只用文本，拼出字符串。 */
export function lcText(m: BaseMessage): string {
  const c = m.content as unknown;
  if (typeof c === "string") return c;
  if (Array.isArray(c))
    return c
      .map((p) => (typeof p === "object" && p && "text" in p ? String(p.text) : ""))
      .join("");
  return "";
}

/** OpenAI 存档 → LC 消息（种子：把会话历史灌进图线程时用）。 */
export function toLC(messages: OAIMessage[]): BaseMessage[] {
  const out: BaseMessage[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      out.push(new SystemMessage(typeof m.content === "string" ? m.content : ""));
    } else if (m.role === "user") {
      out.push(new HumanMessage(typeof m.content === "string" ? m.content : ""));
    } else if (m.role === "assistant") {
      const tcs = (m.tool_calls ?? []).map((tc) => {
        // OpenAI 存 JSON 字符串，LC 要解析好的对象；坏 JSON（中断残留）退化成 {}
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
        } catch {
          /* 保底 {} */
        }
        return { id: tc.id, name: tc.function.name, args };
      });
      out.push(
        new AIMessage({
          content: typeof m.content === "string" ? m.content : "",
          ...(tcs.length ? { tool_calls: tcs } : {}),
        })
      );
    } else if (m.role === "tool") {
      out.push(
        new ToolMessage({
          content: typeof m.content === "string" ? m.content : "",
          tool_call_id: m.tool_call_id,
        })
      );
    }
    // 其它 role（developer 等）目前不产生，忽略
  }
  return out;
}

/** LC 消息 → OpenAI 存档（回写镜像时用）。invalid_tool_calls 也带上，保持线协议配对完整。 */
export function fromLC(messages: BaseMessage[]): OAIMessage[] {
  const out: OAIMessage[] = [];
  for (const m of messages) {
    const t = m.getType();
    if (t === "system") out.push({ role: "system", content: lcText(m) });
    else if (t === "human") out.push({ role: "user", content: lcText(m) });
    else if (t === "ai") {
      const ai = m as AIMessage;
      const tcs = [
        ...(ai.tool_calls ?? []).map((tc) => ({
          id: tc.id ?? "",
          type: "function" as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
        })),
        ...(ai.invalid_tool_calls ?? []).map((tc, i) => ({
          id: tc.id ?? `invalid_${i}`,
          type: "function" as const,
          function: { name: tc.name ?? "unknown", arguments: tc.args ?? "" },
        })),
      ];
      const msg: OAIAssistant = {
        role: "assistant",
        content: lcText(m),
        ...(tcs.length ? { tool_calls: tcs } : {}),
      };
      out.push(msg);
    } else if (t === "tool") {
      const tm = m as ToolMessage;
      out.push({ role: "tool", tool_call_id: tm.tool_call_id, content: lcText(m) });
    }
  }
  return out;
}

/** compress 的 LC 方言实现（投影/选段在 BaseMessage 上跑）。 */
export const lcOps: MessageOps<BaseMessage> = {
  role(m) {
    const t = m.getType();
    return t === "system"
      ? "system"
      : t === "human"
        ? "user"
        : t === "ai"
          ? "assistant"
          : t === "tool"
            ? "tool"
            : "other";
  },
  text(m) {
    return typeof m.content === "string" ? m.content : null;
  },
  withText(m, text) {
    // 裁剪只发生在 role:tool 上（见 trimOldToolOutputs），其余类型防御性原样返回
    if (m.getType() === "tool") {
      const tm = m as ToolMessage;
      return new ToolMessage({ content: text, tool_call_id: tm.tool_call_id });
    }
    return m;
  },
  system(text) {
    return new SystemMessage(text);
  },
};

/** 把一段 LC 消息渲染成可读「对话稿」喂给摘要器（语义对齐 agent.ts 的 renderTranscript）。 */
export function renderTranscriptLC(slice: BaseMessage[]): string {
  return slice
    .map((m) => {
      const t = m.getType();
      if (t === "human") return `用户: ${lcText(m)}`;
      if (t === "ai") {
        const ai = m as AIMessage;
        const calls = (ai.tool_calls ?? [])
          .map((tc) => `〔调用 ${tc.name}(${JSON.stringify(tc.args ?? {})})〕`)
          .join(" ");
        return `助手: ${lcText(m)} ${calls}`.trim();
      }
      if (t === "tool") {
        const c = lcText(m);
        return `工具结果: ${c.length > 1500 ? c.slice(0, 1500) + "…" : c}`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * 找出末尾「悬挂」的 tool_calls：最后一条 AI 消息带 tool_calls、但后面没有对应的
 * tool 结果（确认框挂着时被 Ctrl+C / 崩溃会留下这种状态）。直接带着它再调模型会被
 * API 以配对不完整拒掉，所以恢复时要先补上占位结果。
 */
export function danglingToolCalls(
  messages: BaseMessage[]
): { id: string; name: string }[] {
  const last = messages[messages.length - 1];
  if (!last || !isAIMessage(last)) return [];
  const ai = last as AIMessage;
  return [
    ...(ai.tool_calls ?? []).map((tc, i) => ({
      id: tc.id ?? `missing_${i}`,
      name: tc.name,
    })),
    ...(ai.invalid_tool_calls ?? []).map((tc, i) => ({
      id: tc.id ?? `invalid_${i}`,
      name: tc.name ?? "unknown",
    })),
  ];
}

/** 悬挂修补用的占位结果文本。 */
export const INTERRUPTED_TOOL_RESULT =
  "（上次运行在该工具执行前被中断，未执行。如仍需要请重新调用。）";
