// 长期记忆领域逻辑（纯函数、无依赖的叶子模块）。
// 数据结构 + 渲染 + 归一化（校验／去重／截断／限量／截断自守），供 tools/compress/agent 共用。

const MAX_FACTS = 30;
const MAX_FACT_LEN = 200;

/**
 * 模型侧渲染（也用于回注上下文 + memoryread 返回）。
 * 纯 ASCII，格式：每行 "- 事实内容"。
 */
export function renderMemory(memory: string[]): string {
  if (!memory.length) return "（长期记忆为空）";
  const lines = memory.map((s) => `- ${s}`);
  return `【已知事实（${memory.length} 条，请始终遵守）】\n${lines.join("\n")}`;
}

export interface NormalizeMemoryResult {
  facts: string[];
  dropped: number; // 被丢弃的条目数（空/非字符串/重复/超限）
}

/**
 * 把模型传来的（不可信）整表 incoming 归一化成合法记忆数组。全量替换语义。
 * - 结构校验：不是数组 → throw（回喂模型自纠）
 * - 条目过滤：非字符串 / trim 后为空 → 静默丢弃
 * - 去重：trim 后大小写不敏感去重，保留首次出现
 * - 截长：单条 > 200 字符截断（末尾加 …）
 * - 限量：最多 30 条（防上下文膨胀），超出丢弃（保留前 30）
 * 纯函数：不碰 session，结果由调用方写回。
 */
export function normalizeMemory(
  incoming: unknown
): NormalizeMemoryResult {
  if (!Array.isArray(incoming)) throw new Error("facts 必须是数组");

  let dropped = 0;
  const seen = new Set<string>();
  const facts: string[] = [];

  for (const raw of incoming) {
    if (typeof raw !== "string") {
      dropped++;
      continue;
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      dropped++;
      continue;
    }
    // 截长
    const clipped = trimmed.length > MAX_FACT_LEN
      ? trimmed.slice(0, MAX_FACT_LEN) + "…"
      : trimmed;
    // 大小写不敏感去重
    const key = clipped.toLowerCase();
    if (seen.has(key)) {
      dropped++;
      continue;
    }
    seen.add(key);
    facts.push(clipped);
  }

  // 限量：保留前 MAX_FACTS 条
  if (facts.length > MAX_FACTS) {
    dropped += facts.length - MAX_FACTS;
    facts.length = MAX_FACTS;
  }

  return { facts, dropped };
}
