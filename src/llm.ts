import OpenAI from "openai";

/**
 * DeepSeek 走 OpenAI 兼容协议，所以直接用官方 openai SDK，
 * 只是把 baseURL 指过去。API 是「无状态」的：每一轮请求都要把
 * 完整的 messages 历史重新传一遍，模型自己不记任何东西。
 */
export const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com",
});

export const MODEL = process.env.DEEPSEEK_MODEL ?? "deepseek-v4-pro";

if (!process.env.DEEPSEEK_API_KEY) {
  throw new Error(
    "缺少 DEEPSEEK_API_KEY。请在 .env 里设置（参考 .env.example）。"
  );
}
