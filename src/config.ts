/**
 * 集中配置。所有开关放这里，方便统一管理。
 * 每一项都「配置文件默认值 ← 环境变量覆盖」：既能直接改这个文件，
 * 也能临时用 env 覆盖（例如 `TRACE_STREAM=1 npm run dev`）。
 */

const envOn = (name: string, fallback: boolean): boolean => {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return v === "1" || v.toLowerCase() === "true";
};

export const config = {
  /** 模型名（env: DEEPSEEK_MODEL） */
  model: process.env.DEEPSEEK_MODEL ?? "deepseek-v4-pro",

  /** 常规调试日志：role 时间线 / token 统计 / 流式思考。env: DEBUG=0 关闭 */
  debug: process.env.DEBUG !== "0",

  /**
   * 流式逐片追踪开关（env: TRACE_STREAM=1）。
   *
   * 关（默认 false）：日志只记每轮「累积后」的思考/正文/拼好的 tool_calls。
   * 开（true）：把流式回来的【每一个 delta chunk 的原始 JSON】全部记进日志，
   *            用来研究 SSE 流式协议——能看到：
   *              · 第一片通常只带 delta.role="assistant"
   *              · 正文分多片，每片 delta.content 是一小段文字
   *              · tool_calls 分片：id/name 往往在第一片，arguments 的
   *                JSON 字符串被切成很多片逐步拼出来
   *              · 最后一片带 finish_reason（stop / tool_calls），
   *                DeepSeek 把 usage 也挂在这同一片上
   *                （OpenAI 则会再单独发一片 choices 为空、只带 usage）
   *
   * ⚠️ 很啰嗦，只在想研究协议时开。
   */
  traceStream: envOn("TRACE_STREAM", true),
};
