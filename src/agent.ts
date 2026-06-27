import type OpenAI from "openai";
import { client, MODEL } from "./llm.js";
import { toolSchemas, toolRegistry } from "./tools.js";
import { createRunLogger } from "./logger.js";

type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;

// DEBUG=0 可关闭调试日志（默认开）。不开调试器也能看到 messages 怎么变。
const DEBUG = process.env.DEBUG !== "0";
const dbg = (...args: unknown[]) => DEBUG && console.log(...args);

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
export async function runAgent(userInput: string): Promise<string> {
  // 完整的对话历史。每一轮都要把它整个传给（无状态的）API。
  const messages: Message[] = [
    {
      role: "system",
      content:
        "你是一个会使用工具的助手。需要算数时必须调用 calculate 工具，不要自己心算。",
    },
    { role: "user", content: userInput },
  ];

  // 文件日志：完整 prompt 正文写到 logs/run-*.log（控制台只放精简版）。
  const logger = createRunLogger();
  console.log(`📝 详细日志: ${logger.path}`);
  logger.section("工具定义 toolSchemas（随每轮一起发给模型）");
  logger.log(JSON.stringify(toolSchemas, null, 2));
  logger.section("USER INPUT");
  logger.log(userInput);

  // 最大轮数上限，防止模型陷入死循环（Phase 2 会再强化鲁棒性）。
  const MAX_TURNS = 10;

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    console.log(`\n──────── 第 ${turn} 轮：调用模型 ────────`);
    // 这一轮「发出去」的历史：每轮都把完整 messages 重新传给无状态的 API。
    dbg(`📤 发送历史（${messages.length} 条）: ${timeline(messages)}`);
    // 完整 prompt 正文（就是这次实际发给模型的 messages）写进日志文件。
    logger.section(`第 ${turn} 轮 — 发送给模型的完整 messages（即 prompt）`);
    logger.log(JSON.stringify(messages, null, 2));

    // —— think ——
    const response = await client.chat.completions.create({
      model: MODEL,
      messages,
      tools: toolSchemas,
    });

    const choice = response.choices[0]!;
    const assistantMsg = choice.message;

    // 把模型这一轮的回复（可能含 tool_calls）原样追加进历史。
    messages.push(assistantMsg);
    logger.log(
      `\n----- 第 ${turn} 轮 — 模型响应 -----\n` +
        JSON.stringify(
          {
            finish_reason: choice.finish_reason,
            usage: response.usage,
            message: assistantMsg,
          },
          null,
          2
        )
    );
    if (response.usage) {
      dbg(
        `📊 token: prompt=${response.usage.prompt_tokens} ` +
          `completion=${response.usage.completion_tokens} ` +
          `finish_reason=${choice.finish_reason}`
      );
    }

    const toolCalls = assistantMsg.tool_calls;

    // —— 没有 tool_calls：模型给出最终答案，循环结束 ——
    if (!toolCalls || toolCalls.length === 0) {
      dbg(
        `🏁 退出循环（共 ${turn} 轮，最终历史 ${messages.length} 条）: ` +
          timeline(messages)
      );
      const finalAnswer = assistantMsg.content ?? "(模型没有返回文本内容)";
      logger.section("最终答案");
      logger.log(finalAnswer);
      console.log(`📝 详细日志已保存: ${logger.path}`);
      return finalAnswer;
    }

    dbg(`🧩 本轮模型请求 ${toolCalls.length} 个工具，开始本地执行 …`);

    // —— act + observe：逐个执行模型请求的工具 ——
    for (const call of toolCalls) {
      const { name, arguments: rawArgs } = call.function;
      const args = JSON.parse(rawArgs || "{}");
      console.log(`🔧 模型请求工具: ${name}(${rawArgs})`);

      // 工具执行包 try/catch：报错也当成一种「观察结果」喂回给模型，
      // 而不是直接抛异常掀翻整个循环。模型看到错误信息后，往往能
      // 自己换一种方式重试（比如改用别的表达式）。
      const impl = toolRegistry[name];
      let result: string;
      try {
        result = impl ? impl(args) : `错误：未知工具 "${name}"`;
      } catch (err) {
        result = `工具执行出错：${err instanceof Error ? err.message : String(err)}`;
      }
      console.log(`   ↳ 结果: ${result}`);
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

  return `已达到最大轮数上限（${MAX_TURNS}），未得到最终答案。`;
}
