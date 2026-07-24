/**
 * 时间感知计费模块。
 *
 * DeepSeek 定价方案：
 *   高峰时段：上午 9:00–12:00、下午 2:00–6:00（北京时间 UTC+8）
 *   高峰价格 = 非高峰价格 × 2
 *   V4 Pro 及 Flash 版本的非高峰价格维持不变。
 *
 * 价格单位：元（CNY）/ 百万 tokens。
 */

// —— 非高峰基础价格（元/百万 tokens）——
export interface PriceTier {
  /** 输入缓存未命中：$input * (1 - cacheHitRate) */
  cacheMiss: number;
  /** 输出 token */
  output: number;
  /** 输入缓存命中 */
  cacheHit: number;
}

export const BASE_PRICE: Record<string, PriceTier> = {
  "deepseek-v4-flash": { cacheMiss: 1, output: 2, cacheHit: 0.02 },
  "deepseek-v4-pro": { cacheMiss: 3, output: 6, cacheHit: 0.025 },
};

// —— 高峰时段定义（北京时间 UTC+8）——
interface HourRange {
  start: number; // inclusive
  end: number;   // exclusive
}

const PEAK_RANGES: HourRange[] = [
  { start: 9, end: 12 },  // 9:00–12:00
  { start: 14, end: 18 }, // 14:00–18:00
];

const PEAK_MULTIPLIER = 2;

/** 获取指定时刻的北京时间小时数（0–23）。 */
export function beijingHour(date: Date = new Date()): number {
  // 北京时区偏移 +8 小时
  const utcMs = date.getTime() + date.getTimezoneOffset() * 60_000;
  return new Date(utcMs + 8 * 3_600_000).getHours();
}

/** 判断指定时刻是否处于高峰时段。 */
export function isPeakHour(date: Date = new Date()): boolean {
  const h = beijingHour(date);
  return PEAK_RANGES.some((r) => h >= r.start && h < r.end);
}

/** 获取指定时刻的价格倍率：高峰 2，非高峰 1。 */
export function getMultiplier(date: Date = new Date()): number {
  return isPeakHour(date) ? PEAK_MULTIPLIER : 1;
}

/** 高峰状态文本标签（供 UI 显示）。 */
export function peakLabel(date: Date = new Date()): string {
  return isPeakHour(date) ? "🔴高峰" : "🟢非高峰";
}

/**
 * 根据 token 量计算费用。
 *
 * @param model 模型名
 * @param cacheMissTokens 缓存未命中 token
 * @param cacheHitTokens 缓存命中 token
 * @param outputTokens 输出 token
 * @param timestamp 请求时间戳（ISO 字符串），据此判定高峰/非高峰；缺省用当前时间
 * @returns 费用（元，CNY）
 */
export function calcCost(
  model: string,
  cacheMissTokens: number,
  cacheHitTokens: number,
  outputTokens: number,
  timestamp?: string,
): number {
  const tier = BASE_PRICE[model];
  if (!tier) return 0;
  const date = timestamp ? new Date(timestamp) : new Date();
  const mul = getMultiplier(date);
  return (
    (cacheMissTokens / 1_000_000) * tier.cacheMiss * mul +
    (cacheHitTokens / 1_000_000) * tier.cacheHit * mul +
    (outputTokens / 1_000_000) * tier.output * mul
  );
}

/** 格式化费用字符串（≤ 0 元不显示）。 */
export function formatCost(cost: number): string {
  if (cost <= 0) return "";
  if (cost < 0.01) return "¥<0.01";
  return `¥${cost.toFixed(2)}`;
}
