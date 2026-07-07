// 内部辅助 LLM 任务（判风险 / 折叠摘要 / 合并摘要）的「提示词 + 防御式解析」。
// 抽成纯函数模块的原因：手写引擎（openai SDK）和 LangGraph 引擎（LangChain 模型）
// 各自发起调用，但提示词和解析规则必须是同一份，否则两个引擎行为漂移、没法对照。

/** 风险判官 system 提示。 */
export const RISK_JUDGE_SYSTEM =
  "你是工具调用风险判官。判断给定工具调用是否「有风险」。" +
  "有风险=破坏性/不可逆（rm、删除、覆盖重要文件、git reset --hard / git push、drop、清空目录）、" +
  "提权或改系统（sudo、改系统配置或环境变量）、对外发数据/下载执行（curl|sh、上传、外联）、大范围批量改动。" +
  "低风险=只读或查询（ls、cat、grep、git status/diff、find）、构建测试、常规单文件编辑、echo、mkdir。" +
  '只输出 JSON：{"risky": true 或 false, "reason": "一句话中文理由"}。';

/** 折叠摘要器 system 提示（summary + 长期事实抽取）。 */
export const SUMMARIZE_SYSTEM =
  "你是对话摘要器。只输出一个 JSON 对象，形如 " +
  '{"summary": "...", "facts": ["..."]}。' +
  "summary：把这段对话浓缩成简洁中文要点，保留用户目标/决定、文件路径与改动、" +
  "命令与结果、关键事实与报错。facts：需长期记住的稳定事实（用户偏好/项目约定/" +
  "关键决定/身份信息等），没有就空数组。不要编造，不要客套。";

/** 分级折叠（把多段旧摘要再合并）system 提示。 */
export const FOLD_SYSTEM =
  "把下面多段对话摘要进一步合并、浓缩成一段更短的要点，保留最重要的目标/决定/" +
  "文件/结论，丢弃细枝末节。只输出合并后的摘要正文。";

/** 去掉模型爱包的 ```json 围栏。 */
const stripFence = (raw: string) => raw.replace(/^```json\s*|\s*```$/g, "");

/**
 * 解析风险判官输出。判不出来（解析失败）→ 保守当作有风险（fail-safe），
 * 由调用方决定要不要把异常也映射到这个兜底。
 */
export function parseRisk(raw: string): { risky: boolean; reason: string } {
  try {
    const o = JSON.parse(stripFence(raw.trim())) as {
      risky?: unknown;
      reason?: unknown;
    };
    return {
      risky: Boolean(o.risky),
      reason: String(o.reason ?? "").trim() || "(无说明)",
    };
  } catch {
    return { risky: true, reason: "风险判定失败，保守起见需确认" };
  }
}

/** 解析摘要器输出；不是合法 JSON 就整段当纯摘要、facts 为空。 */
export function parseSummary(raw: string): { summary: string; facts: string[] } {
  const trimmed = raw.trim();
  try {
    const o = JSON.parse(stripFence(trimmed)) as {
      summary?: unknown;
      facts?: unknown;
    };
    const summary = String(o.summary ?? "").trim() || "(摘要为空)";
    const facts = Array.isArray(o.facts)
      ? o.facts.map((f) => String(f).trim()).filter(Boolean)
      : [];
    return { summary, facts };
  } catch {
    return { summary: trimmed || "(摘要为空)", facts: [] };
  }
}
