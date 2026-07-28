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

const envNum = (name: string, fallback: number): number => {
  const v = process.env[name];
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  /** 主 think 模型（env: THINK_MODEL），负责核心推理/回答/工具调用 */
  model: process.env.THINK_MODEL ?? "deepseek-v4-pro",

  /** 单次用户输入内 think→act 的最大轮数上限，防死循环（env: MAX_TURNS） */
  maxTurns: envNum("MAX_TURNS", 100),

  /** 子 Agent 默认最大轮数（env: SUBAGENT_MAX_TURNS）。可为单个 spawn 调用覆盖。 */
  subagentMaxTurns: envNum("SUBAGENT_MAX_TURNS", 50),

  /**
   * 同时运行的子 Agent 上限（env: SUBAGENT_MAX_CONCURRENT）。
   * 主 Agent 一轮可以并行吐好几个 spawn_subagent，不设闸就是几条并发流一起打 API。
   */
  subagentMaxConcurrent: envNum("SUBAGENT_MAX_CONCURRENT", 5),

  /** run_bash 单条命令超时毫秒数（env: BASH_TIMEOUT_MS）。构建/测试类命令常超 15s，默认给 60s。 */
  bashTimeoutMs: envNum("BASH_TIMEOUT_MS", 60_000),

  /** 常规调试日志：role 时间线 / token 统计 / 流式思考。env: DEBUG=0 关闭 */
  debug: process.env.DEBUG !== "0",

  /**
   * 重型协议研究日志开关（env: TRACE_STREAM=1）。
   *
   * 关（默认 false）：日志只记每轮「累积后」的思考/正文/拼好的 tool_calls，
   *            以及投影的 role 时间线（不含全文，日志体积可控）。
   * 开（true）：额外记两样很大的东西——
   *            a) 每轮发给模型的完整投影 messages JSON（每轮重复全部历史，O(n²) 膨胀）；
   *            b) 流式回来的【每一个 delta chunk 的原始 JSON】，
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
  traceStream: envOn("TRACE_STREAM", false),

  /**
   * 上下文压缩（见 docs/context-compression.md）。阈值用「绝对 token 预算」，
   * 测试时把 CTX_BUDGET 调小（如 2000）即可在短对话里强制触发裁剪。
   *
   * ⚠️ budget 必须 ≤ 模型真实上下文窗口，否则压缩永远来不及触发、API 先溢出报错。
   * 默认 1M 对应 deepseek-v4-pro 的 1M 窗口；换更小窗口的模型时记得用 CTX_BUDGET 调小。
   */
  compress: {
    budget: envNum("CTX_BUDGET", 1*1024*1024),  // 上下文 token 预算 W（ctx 占比的分母）＝模型窗口
    trimFrac: envNum("CTX_TRIM_FRAC", 0.3), // 投影 > budget*trimFrac 时开始裁旧工具输出（层 A）
    summarizeFrac: envNum("CTX_SUM_FRAC", 0.5), // 投影 > budget*summarizeFrac 时折叠旧轮成摘要（层 B）
    keepRecentTools: envNum("CTX_KEEP_TOOLS", 4), // 最近几条 role:tool 输出留全
    keepRecentTurns: envNum("CTX_KEEP_TURNS", 3), // 最近几轮原文不折叠
    trimMin: envNum("CTX_TRIM_MIN", 300), // content 超过多少字符才值得裁
    foldFrac: envNum("CTX_FOLD_FRAC", 0.25), // 摘要本身 token 占比超此 → 二级折叠（层 B 触顶）
    foldGroupSize: envNum("CTX_FOLD_GROUP", 4), // 每次把几段旧摘要再折一层
    warnFrac: envNum("CTX_WARN_FRAC", 0.85), // ctx 超此 / 出现高层摘要 → 软提示
  },

  /**
   * 确认门模式（env: APPROVAL_MODE）。
   *   auto（默认）：危险工具先让模型判风险，只有判为「有风险」才弹确认框。
   *   strict：危险工具（needsApproval）一律弹确认框。
   * 运行中可用 /mode 切换。
   */
  approvalMode: (process.env.APPROVAL_MODE === "strict" ? "strict" : "auto") as
    | "auto"
    | "strict",
};
