import OpenAI from "openai";
import { config } from "./config.js";

/**
 * DeepSeek 走 OpenAI 兼容协议，所以直接用官方 openai SDK，
 * 只是把 baseURL 指过去。API 是「无状态」的：每一轮请求都要把
 * 完整的 messages 历史重新传一遍，模型自己不记任何东西。
 */
// 必须在 new OpenAI 之前检查：SDK 构造时对空 key 会先抛它自己的英文错误，
// 放在后面这个友好提示就永远执行不到。
if (!process.env.DEEPSEEK_API_KEY) {
  throw new Error(
    "缺少 DEEPSEEK_API_KEY。请在 .env 里设置（参考 .env.example）。"
  );
}

export const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com",
});

export const MODEL = config.model;
/** 内部辅助调用（风险判断/摘要/折叠）用的轻量模型（env: FLASH_MODEL） */
export const FLASH_MODEL = process.env.FLASH_MODEL ?? "deepseek-v4-flash";
