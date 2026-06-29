import type OpenAI from "openai";
import { client, MODEL } from "./llm.js";
import {
  toolSchemas,
  toolRegistry,
  needsApproval,
  describeForApproval,
} from "./tools.js";
import { createRunLogger, type RunLogger } from "./logger.js";
import { config } from "./config.js";
import { newSessionId, saveSession, type StoredSession } from "./store.js";

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
  "run_bash 跑其它命令（构建、测试、git、看目录等）；calculate 做精确计算。" +
  "优先用工具获取真实信息，不要凭空臆测或编造文件内容；" +
  "多步任务一步步调用工具推进，完成后用简洁清晰的话回答。";

/** 一次对话会话：跨多轮用户输入持久保存历史与日志。 */
export interface Session {
  id: string; // 会话 id，对应 sessions/<id>.json
  createdAt: string;
  messages: Message[];
  logger: RunLogger;
  round: number; // 第几次「用户输入」（区别于内部 think-act 轮）
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
  };
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
  });
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

  // 最大轮数上限，防止模型陷入死循环（Phase 2 会再强化鲁棒性）。
  const MAX_TURNS = 10;

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    emit({ type: "debug", text: `──────── 第 ${turn} 轮：调用模型 ────────` });
    // 这一轮「发出去」的历史：每轮都把完整 messages 重新传给无状态的 API。
    emit({ type: "debug", text: `📤 发送历史（${messages.length} 条）: ${timeline(messages)}` });
    // 完整 prompt 正文（就是这次实际发给模型的 messages）写进日志文件。
    logger.section(`第 ${turn} 轮 — 发送给模型的完整 messages（即 prompt）`);
    logger.log(JSON.stringify(messages, null, 2));

    // —— think（流式）——
    const { assistantMsg, finishReason, usage } = await streamModel(
      messages,
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
      text: `🧩 本轮模型请求 ${toolCalls.length} 个工具，开始本地执行 …`,
    });

    // —— act + observe：逐个执行模型请求的工具 ——
    for (const call of toolCalls) {
      const { name, arguments: rawArgs } = call.function;
      emit({ type: "tool_call", name, argsText: rawArgs });

      let result: string;
      // 工具执行包 try/catch：报错也当成一种「观察结果」喂回给模型，
      // 而不是直接抛异常掀翻整个循环。
      try {
        const args = JSON.parse(rawArgs || "{}");
        // 危险工具先过用户确认门（确认框带可读预览：命令 / diff）；
        // 被拒绝就把「已拒绝」当 observation 喂回，模型据此换个做法。
        if (needsApproval.has(name)) {
          const preview = await describeForApproval(name, args);
          if (!(await approve({ name, argsText: rawArgs, preview }))) {
            result = "用户拒绝执行该工具调用。请换一种不需要该操作的方式，或询问用户。";
            emit({ type: "tool_result", name, result });
            logger.log(`[tool] ${name}(${rawArgs}) => ${result}`);
            messages.push({ role: "tool", tool_call_id: call.id, content: result });
            continue;
          }
        }
        const impl = toolRegistry[name];
        result = impl ? await impl(args) : `错误：未知工具 "${name}"`;
      } catch (err) {
        result = `工具执行出错：${err instanceof Error ? err.message : String(err)}`;
      }
      emit({ type: "tool_result", name, result });
      logger.log(`[tool] ${name}(${rawArgs}) => ${result}`);

      // observation 必须用 role:"tool"，且 tool_call_id 要和请求对应上。
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: result,
      });
    }
    // 带着新的 observation 回到循环顶部，再次 think。
  }

  persist(session);
  return `已达到最大轮数上限（${MAX_TURNS}），未得到最终答案。`;
}
