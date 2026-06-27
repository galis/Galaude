import type OpenAI from "openai";

/**
 * 工具 = 两部分：
 *   1. 给模型看的「声明」（JSON schema），告诉它有什么工具、参数长什么样；
 *   2. 给我代码执行的「实现」（本地函数）。
 *
 * 模型永远只是「请求」调用工具，真正跑代码的是我们自己。
 */

// —— 1. 声明：传给模型的 tools 定义 ——
export const toolSchemas: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "calculate",
      description:
        "计算一个数学表达式并返回结果。当用户需要算数时使用。" +
        "支持：加减乘除、括号、幂（用 ^ 或 **）、% 取余，" +
        "以及函数 sqrt/cbrt/abs/round/floor/ceil/min/max/log/log2/log10/exp/sin/cos/tan，" +
        "和常量 pi、e。例如 'sqrt(7)'、'(12+7)*3'、'2^10'。",
      parameters: {
        type: "object",
        properties: {
          expression: {
            type: "string",
            description: "要计算的表达式，例如 '(12 + 7) * 3' 或 '2 ** 10'",
          },
        },
        required: ["expression"],
        additionalProperties: false,
      },
    },
  },
];

// —— 2. 实现：工具名 → 本地函数 的注册表 ——
// 每个实现接收「已解析好的参数对象」，返回一个字符串（喂回给模型当 observation）。
type ToolImpl = (args: Record<string, unknown>) => string;

export const toolRegistry: Record<string, ToolImpl> = {
  calculate({ expression }) {
    const expr = String(expression ?? "").trim();
    if (!expr) throw new Error("表达式为空");

    // 白名单校验：先把允许的函数名/常量名抠掉，剩下的必须只是
    // 数字、空白和算术符号，防止把任意 JS 喂进求值器。
    const ALLOWED = /\b(sqrt|cbrt|abs|round|floor|ceil|min|max|log10|log2|log|exp|sin|cos|tan|pi|e)\b/gi;
    const stripped = expr.replace(ALLOWED, "");
    if (/[^0-9\s+\-*/%().,^]/.test(stripped)) {
      throw new Error(
        `表达式含不支持的字符或函数: "${expr}"（支持的函数见工具描述）`
      );
    }

    // ^ 当作幂，转成 JS 的 **；把允许的函数/常量绑到 Math 上再求值。
    const js = expr.replace(/\^/g, "**");
    const result = Function(
      "Math",
      `"use strict";
       const {sqrt,cbrt,abs,round,floor,ceil,min,max,log,log2,log10,exp,sin,cos,tan,PI,E}=Math;
       const pi=PI, e=E;
       return (${js});`
    )(Math);
    return `${expr} = ${result}`;
  },
};
