import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import type OpenAI from "openai";

const execFileAsync = promisify(execFile);

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
  {
    type: "function",
    function: {
      name: "run_bash",
      description:
        "在本机执行一条 bash 命令并返回输出（stdout+stderr+退出码）。" +
        "适合看目录、查日期/系统信息、跑构建/测试/git 等命令行工具。" +
        "例如 'ls -la'、'date'、'npm test'、'git status'。" +
        "⚠️ 读/写/改文件内容请用 read_file/write_file/edit_file，不要用 cat/echo/sed。",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "要执行的 bash 命令，例如 'ls -la' 或 'uname -a'",
          },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "读取文本文件内容（带行号返回）。读文件请用本工具，不要用 run_bash 的 cat。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文件路径（相对或绝对）" },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "写入/覆盖整个文件（父目录须已存在；文件不存在则新建）。" +
        "创建新文件或整体替换内容请用本工具，不要用 run_bash 的重定向。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文件路径" },
          content: { type: "string", description: "要写入的完整内容" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "精确编辑文件：把 old_string 在文件中「唯一一次」出现替换成 new_string。" +
        "old_string 必须逐字匹配（含缩进与换行），且在文件中唯一。" +
        "改文件请用本工具，不要用 run_bash 的 sed。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文件路径" },
          old_string: { type: "string", description: "要被替换的原文（需唯一）" },
          new_string: { type: "string", description: "替换成的新内容" },
        },
        required: ["path", "old_string", "new_string"],
        additionalProperties: false,
      },
    },
  },
];

// 需要先经用户确认才执行的「危险」工具（有副作用 / 能跑任意命令）。
// read_file / calculate 只读或纯计算，无副作用，不需要确认。
export const needsApproval = new Set<string>([
  "run_bash",
  "write_file",
  "edit_file",
]);

// —— 2. 实现：工具名 → 本地函数 的注册表 ——
// 每个实现接收「已解析好的参数对象」，返回一个字符串（喂回给模型当 observation）。
// 允许返回 Promise：像 run_bash 这种 IO 工具必须异步，否则会卡死事件循环（UI 冻结）。
type ToolImpl = (
  args: Record<string, unknown>
) => string | Promise<string>;

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

  async run_bash({ command }) {
    const cmd = String(command ?? "").trim();
    if (!cmd) throw new Error("command 为空");

    // 异步执行（不阻塞事件循环 → UI 不冻结）；限时 15s、限输出 1MB。
    const clip = (s: string) =>
      s.length > 4000 ? s.slice(0, 4000) + "\n…(输出已截断)" : s;
    try {
      const { stdout, stderr } = await execFileAsync("bash", ["-c", cmd], {
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      });
      return `exit=0\n${clip(`${stdout}${stderr}`) || "(无输出)"}`;
    } catch (e) {
      // 非零退出/超时：execFile 会 reject，但 stdout/stderr 仍带回内容。
      const err = e as {
        code?: number | string;
        signal?: string;
        stdout?: string;
        stderr?: string;
        message?: string;
      };
      const out = clip(`${err.stdout ?? ""}${err.stderr ?? ""}`);
      const status = err.signal ?? err.code ?? "?";
      return `exit=${status}\n${out || err.message || "(出错)"}`;
    }
  },

  async read_file({ path }) {
    const p = String(path ?? "").trim();
    if (!p) throw new Error("path 为空");
    const content = await readFile(p, "utf8");
    const lines = content.split("\n");
    const shown = lines.slice(0, 400); // 最多 400 行
    const body = shown.map((l, i) => `${i + 1}\t${l}`).join("\n");
    const more = lines.length > shown.length ? `\n…(共 ${lines.length} 行，省略其余)` : "";
    return body + more || "(空文件)";
  },

  async write_file({ path, content }) {
    const p = String(path ?? "").trim();
    if (!p) throw new Error("path 为空");
    const c = String(content ?? "");
    await writeFile(p, c, "utf8");
    return `已写入 ${p}（${c.split("\n").length} 行，${Buffer.byteLength(c)} 字节）`;
  },

  async edit_file({ path, old_string, new_string }) {
    const p = String(path ?? "").trim();
    if (!p) throw new Error("path 为空");
    const oldS = String(old_string ?? "");
    const newS = String(new_string ?? "");
    if (!oldS) throw new Error("old_string 为空");
    const content = await readFile(p, "utf8");
    const idx = content.indexOf(oldS);
    if (idx === -1)
      throw new Error("文件中找不到 old_string（需逐字匹配，含缩进/换行）");
    if (content.indexOf(oldS, idx + 1) !== -1)
      throw new Error("old_string 在文件中出现多次，请提供更长、唯一的片段");
    await writeFile(p, content.slice(0, idx) + newS + content.slice(idx + oldS.length), "utf8");
    return `已编辑 ${p}（替换 1 处）`;
  },
};

// 极简行级 diff：剥掉公共前后缀，把变化的中段按 -旧 / +新 展示。
function lineDiff(oldText: string, newText: string, max = 16): string {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let ea = a.length;
  let eb = b.length;
  while (ea > p && eb > p && a[ea - 1] === b[eb - 1]) (ea--, eb--);
  const out = [
    ...a.slice(p, ea).map((l) => `- ${l}`),
    ...b.slice(p, eb).map((l) => `+ ${l}`),
  ];
  if (out.length === 0) return "(无变化)";
  return out.length > max
    ? out.slice(0, max).join("\n") + "\n…(差异较多，已省略)"
    : out.join("\n");
}

/**
 * 给「需要确认」的工具生成一段可读预览（确认框里展示）：
 * run_bash → 命令；write_file/edit_file → diff。
 */
export async function describeForApproval(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  if (name === "run_bash") return `$ ${String(args.command ?? "")}`;

  if (name === "write_file") {
    const p = String(args.path ?? "");
    const next = String(args.content ?? "");
    let prev = "";
    let exists = true;
    try {
      prev = await readFile(p, "utf8");
    } catch {
      exists = false;
    }
    const head = exists ? `写入（覆盖）${p}` : `新建文件 ${p}`;
    return `${head}\n${lineDiff(prev, next)}`;
  }

  if (name === "edit_file") {
    const p = String(args.path ?? "");
    const oldS = String(args.old_string ?? "");
    const newS = String(args.new_string ?? "");
    let warn = "";
    try {
      const content = await readFile(p, "utf8");
      if (!content.includes(oldS)) warn = "\n⚠️ 未找到要替换的内容（执行会失败）";
    } catch {
      warn = "\n⚠️ 读不到该文件（执行会失败）";
    }
    return `编辑 ${p}${warn}\n${lineDiff(oldS, newS)}`;
  }

  return `${name}(${JSON.stringify(args)})`;
}
