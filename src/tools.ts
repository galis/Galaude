import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { promisify } from "node:util";
import type OpenAI from "openai";
import { config } from "./config.js";
import { renderTodos, normalizeTodos, type TodoPlan } from "./todo.js";
import { renderMemory, normalizeMemory } from "./memory.js";
import { loadGlobalMemory, saveGlobalMemory } from "./store.js";
import type { AgentEvent } from "./agent.js";

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
  {
    type: "function",
    function: {
      name: "memoryread",
      description:
        "读取当前长期记忆（用户偏好、项目约定、关键决定等）。开始新任务前、或需要了解背景时调用。无参数。",
      parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "memorywrite",
      description:
        "写入长期记忆（整表覆盖：每次传【完整】facts 数组，不是增量）。" +
        "用户说了值得长期记住的事（偏好、约定、决定、身份信息、项目规则等），用此工具记下来。" +
        "想删一条 → 读 → 去掉那条 → 写回剩余。想加一条 → 读 → 拼接 → 写回。" +
        "不要记琐碎/临时信息（对话历史已有），只记跨会话需要保留的关键事实。",
      parameters: {
        type: "object",
        properties: {
          facts: {
            type: "array",
            description: "完整的记忆事实数组（全量替换），例如 ['用户叫 Junqian', '项目约定：用 pnpm']",
            items: { type: "string" },
          },
        },
        required: ["facts"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "todoread",
      description:
        "读取当前任务清单及每项状态。开始多步任务前、或不确定进度时调用。无参数。",
      parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "todowrite",
      description:
        "创建/更新任务清单（整表覆盖：每次传【完整】列表，不是增量）。把多步任务拆成有序清单并持续更新进度。" +
        "规则：同一时刻最多一个 in_progress；做完一项标 completed 再把下一项标 in_progress；" +
        "更新已有项时【保留它的 id】（清单里以 #id 显示），新增项不填 id。琐碎单步任务不必用。",
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            description: "完整任务列表，按执行顺序。",
            items: {
              type: "object",
              properties: {
                id: { type: "integer", description: "已有项保留其 #id；新增项省略" },
                content: { type: "string", description: "任务描述（祈使句）" },
                status: {
                  type: "string",
                  enum: ["pending", "in_progress", "completed"],
                  description: "pending 待做 / in_progress 进行中 / completed 已完成",
                },
              },
              required: ["content", "status"],
              additionalProperties: false,
            },
          },
        },
        required: ["todos"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "batch_read_file",
      description:
        "一次读取多个文本文件内容（每个文件带行号返回）。" +
        "需要同时查看多个文件时优先使用，避免多次调用 read_file。" +
        "每个文件最多返回 400 行，超大文件会截断并标注。",
      parameters: {
        type: "object",
        properties: {
          paths: {
            type: "array",
            description: "要读取的文件路径列表（相对或绝对）",
            items: { type: "string" },
          },
        },
        required: ["paths"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "batch_write_file",
      description:
        "一次写入/覆盖多个文件（父目录须已存在；文件不存在则新建）。" +
        "需要同时创建或覆盖多个文件时优先使用，避免多次调用 write_file。",
      parameters: {
        type: "object",
        properties: {
          files: {
            type: "array",
            description: "要写入的文件列表",
            items: {
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
        required: ["files"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "batch_edit_file",
      description:
        "一次对多个文件做精确编辑：每个编辑中 old_string 在对应文件中「唯一一次」出现替换成 new_string。" +
        "old_string 必须逐字匹配（含缩进与换行），且在文件中唯一。" +
        "需要同时修改多个文件时优先使用，避免多次调用 edit_file。",
      parameters: {
        type: "object",
        properties: {
          edits: {
            type: "array",
            description: "要执行的编辑列表",
            items: {
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
        required: ["edits"],
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
  "batch_write_file",
  "batch_edit_file",
]);

// —— 确定性风险规则（auto 模式的第一道闸）——
// LLM 判风险可能被工具输出里的提示注入带偏；这些模式命中就直接要求确认，
// 不再问模型。误报的代价只是多弹一次确认框，可以接受。
const BASH_RISK_RULES: [RegExp, string][] = [
  [/\brm\b/, "删除文件（rm）"],
  [/\bsudo\b/, "提权（sudo）"],
  [/(^|\s)\d?>{1,2}\s*[^&\s]/, "输出重定向写文件（>/>>）"],
  [/\|\s*(ba|z|da)?sh\b/, "管道进 shell 执行（curl|sh 类）"],
  [/\b(curl|wget)\b/, "外联下载"],
  [/\bdd\b/, "dd 底层写盘"],
  [/\bmkfs/, "格式化文件系统"],
  [/\bgit\s+push\b.*(\s-f\b|--force)/, "git 强制推送"],
  [/\bgit\s+reset\b.*--hard/, "git reset --hard 丢弃改动"],
  [/\b(chmod|chown)\b\s+-\w*R/, "递归改权限/属主"],
];

/**
 * 规则判风险：命中返回一句理由，未命中返回 null（交给 LLM 二次把关）。
 * write_file/edit_file 写到 cwd 之外也算风险（agent 本该只动当前项目）。
 */
export function ruleRisk(
  name: string,
  args: Record<string, unknown>
): string | null {
  if (name === "run_bash") {
    const cmd = String(args.command ?? "");
    for (const [re, why] of BASH_RISK_RULES) if (re.test(cmd)) return why;
    return null;
  }
  if (name === "write_file" || name === "edit_file") {
    const p = resolve(String(args.path ?? ""));
    const cwd = process.cwd();
    if (p !== cwd && !p.startsWith(cwd + sep))
      return `写工作目录（${cwd}）之外的路径`;
    return null;
  }
  if (name === "batch_write_file") {
    const files = args.files as { path?: string }[] | undefined;
    if (!Array.isArray(files)) return null;
    const cwd = process.cwd();
    for (const f of files) {
      const p = resolve(String(f.path ?? ""));
      if (p !== cwd && !p.startsWith(cwd + sep))
        return `批量写入含工作目录（${cwd}）之外的路径: ${f.path}`;
    }
    return null;
  }
  if (name === "batch_edit_file") {
    const edits = args.edits as { path?: string }[] | undefined;
    if (!Array.isArray(edits)) return null;
    const cwd = process.cwd();
    for (const e of edits) {
      const p = resolve(String(e.path ?? ""));
      if (p !== cwd && !p.startsWith(cwd + sep))
        return `批量编辑含工作目录（${cwd}）之外的路径: ${e.path}`;
    }
    return null;
  }
  return null;
}

// —— 2. 实现：两张分类型注册表（见设计 D3）——
// pureTools：纯 / 外部副作用工具，签名 (args)=>string，碰不到会话（最小权限、天然并发安全）。
// statefulTools：需读写会话状态的工具（todo），签名 (args, ctx)=>string。
// 每个实现接收「已解析好的参数对象」，返回字符串（喂回给模型当 observation）。
// 允许返回 Promise：像 run_bash 这种 IO 工具必须异步，否则会卡死事件循环（UI 冻结）。
type ToolImpl = (
  args: Record<string, unknown>
) => string | Promise<string>;

export const pureTools: Record<string, ToolImpl> = {
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

    // 异步执行（不阻塞事件循环 → UI 不冻结）；超时见 config.bashTimeoutMs、限输出 1MB。
    const clip = (s: string) =>
      s.length > 4000 ? s.slice(0, 4000) + "\n…(输出已截断)" : s;
    try {
      const { stdout, stderr } = await execFileAsync("bash", ["-c", cmd], {
        encoding: "utf8",
        timeout: config.bashTimeoutMs,
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

  async batch_read_file({ paths }) {
    const arr = paths as string[] | undefined;
    if (!Array.isArray(arr) || arr.length === 0)
      throw new Error("paths 为空或不是数组");
    const results: string[] = [];
    for (const raw of arr) {
      const p = String(raw ?? "").trim();
      if (!p) { results.push(`⚠️ 跳过空路径`); continue; }
      try {
        const content = await readFile(p, "utf8");
        const lines = content.split("\n");
        const shown = lines.slice(0, 400);
        const body = shown.map((l, i) => `${i + 1}\t${l}`).join("\n");
        const more = lines.length > shown.length ? `\n…(共 ${lines.length} 行，省略其余)` : "";
        results.push(`=== ${p} ===\n${body + more || "(空文件)"}`);
      } catch (e) {
        results.push(`=== ${p} ===\n❌ 读取失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return results.join("\n\n");
  },

  async batch_write_file({ files }) {
    const arr = files as { path?: string; content?: string }[] | undefined;
    if (!Array.isArray(arr) || arr.length === 0)
      throw new Error("files 为空或不是数组");
    const results: string[] = [];
    for (const f of arr) {
      const p = String(f.path ?? "").trim();
      if (!p) { results.push("⚠️ 跳过空路径"); continue; }
      const c = String(f.content ?? "");
      await writeFile(p, c, "utf8");
      results.push(`已写入 ${p}（${c.split("\n").length} 行，${Buffer.byteLength(c)} 字节）`);
    }
    return results.join("\n");
  },

  async batch_edit_file({ edits }) {
    const arr = edits as { path?: string; old_string?: string; new_string?: string }[] | undefined;
    if (!Array.isArray(arr) || arr.length === 0)
      throw new Error("edits 为空或不是数组");

    // 预校验：先通读所有文件、检查 old_string 是否能匹配，全部通过后再落盘
    const plans: { path: string; idx: number; oldS: string; newS: string; content: string }[] = [];
    for (const e of arr) {
      const p = String(e.path ?? "").trim();
      if (!p) throw new Error("edits 中含有空路径");
      const oldS = String(e.old_string ?? "");
      const newS = String(e.new_string ?? "");
      if (!oldS) throw new Error(`编辑 ${p} 时 old_string 为空`);
      const content = await readFile(p, "utf8");
      const idx = content.indexOf(oldS);
      if (idx === -1)
        throw new Error(`文件中找不到 old_string（需逐字匹配，含缩进/换行）: ${p}`);
      if (content.indexOf(oldS, idx + 1) !== -1)
        throw new Error(`old_string 在文件中出现多次，请提供更长、唯一的片段: ${p}`);
      plans.push({ path: p, idx, oldS, newS, content });
    }

    // 全部预校验通过，开始写入
    const results: string[] = [];
    for (const plan of plans) {
      await writeFile(
        plan.path,
        plan.content.slice(0, plan.idx) + plan.newS + plan.content.slice(plan.idx + plan.oldS.length),
        "utf8"
      );
      results.push(`已编辑 ${plan.path}（替换 1 处）`);
    }
    return results.join("\n");
  },
};

// —— 有状态工具（todo）：拿到 ctx，可读写会话任务计划、发 UI 事件（见 D3）——
export interface ToolCtx {
  plan: TodoPlan; // 会话任务计划，按引用传入（只暴露这一块 → 最小权限）
  emit: (e: AgentEvent) => void;
  finishReason: string | null; // 本轮模型 finish_reason，用于截断自守（F1）
}
type StatefulToolImpl = (args: Record<string, unknown>, ctx: ToolCtx) => string;

export const statefulTools: Record<string, StatefulToolImpl> = {
  memoryread(_args, _ctx) {
    const mem = loadGlobalMemory();
    return mem.length
      ? renderMemory(mem)
      : "（长期记忆为空。用户说了值得记住的事可用 memorywrite 记下来。）";
  },

  memorywrite({ facts }, ctx) {
    // F1 截断自守：本轮输出被截断 → 拒写，旧记忆纹丝不动。
    if (ctx.finishReason === "length")
      return "⚠️ 上次输出被截断，未写入记忆（避免残表覆盖）。请拆成更小的更新重试。";

    const r = normalizeMemory(facts);
    saveGlobalMemory(r.facts);
    ctx.emit({ type: "note", text: `🧠 记忆已更新（${r.facts.length} 条${r.dropped ? `，${r.dropped} 条被丢弃` : ""}）` });

    const notes: string[] = [];
    if (r.dropped) notes.push(`${r.dropped} 条被过滤（空/重复/超限）`);
    return (
      "已更新。\n" +
      renderMemory(r.facts) +
      (notes.length ? "\n（注：" + notes.join("；") + "）" : "")
    );
  },

  todoread(_args, ctx) {
    return ctx.plan.todos.length
      ? renderTodos(ctx.plan.todos)
      : "（任务清单为空。多步任务可用 todowrite 建立计划。）";
  },

  todowrite({ todos }, ctx) {
    // F1 截断自守：本轮输出被截断 → 已知不可信，写入前直接拒绝，旧表纹丝不动。
    if (ctx.finishReason === "length")
      return "⚠️ 上次输出被截断，未写入清单（避免残表覆盖）。请拆成更小的更新重试。";

    const plan = ctx.plan;
    // 校验 / 软归一 / 按 id 自愈；脏输入会 throw → 由工具循环当 observation 回喂模型自纠（F3）。
    const r = normalizeTodos(plan.todos, todos, plan.nextId);
    plan.todos = r.todos;
    plan.nextId = r.nextId;
    ctx.emit({ type: "todos", todos: r.todos });

    const notes: string[] = [];
    if (r.demoted) notes.push(`多出的 ${r.demoted} 个 in_progress 已降级 pending`);
    if (r.healed) notes.push(`${r.healed} 项 content 漂移已按 #id 自愈`);
    return (
      "已更新。\n" +
      renderTodos(r.todos) +
      (notes.length ? "\n（注：" + notes.join("；") + "）" : "")
    );
  },
};

// 分派完整性（F4）：每个声明的工具须恰好落在一张表，不重不漏，否则模块加载即报错（fail fast）。
{
  const declared = new Set(toolSchemas.map((t) => t.function.name));
  const pure = new Set(Object.keys(pureTools));
  const stateful = new Set(Object.keys(statefulTools));
  for (const name of declared) {
    if (pure.has(name) && stateful.has(name))
      throw new Error(`工具 ${name} 同时在 pureTools/statefulTools（歧义）`);
    if (!pure.has(name) && !stateful.has(name))
      throw new Error(`工具 ${name} 已声明但未在任何注册表实现`);
  }
  for (const name of [...pure, ...stateful])
    if (!declared.has(name)) throw new Error(`实现了未在 toolSchemas 声明的工具 ${name}`);
}

// 极简行级 diff：剥掉公共前后缀，把变化的中段按 -旧 / +新 展示。
export function lineDiff(oldText: string, newText: string, max = 16): string {
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

  if (name === "batch_read_file") {
    const paths = args.paths as string[] | undefined;
    if (!Array.isArray(paths) || paths.length === 0) return "batch_read_file（空列表）";
    return `批量读取 ${paths.length} 个文件:\n${paths.map((p, i) => `  ${i + 1}. ${String(p ?? "")}`).join("\n")}`;
  }

  if (name === "batch_write_file") {
    const files = args.files as { path?: string; content?: string }[] | undefined;
    if (!Array.isArray(files) || files.length === 0) return "batch_write_file（空列表）";
    const lines = files.map((f, i) => {
      const p = String(f.path ?? "");
      const c = String(f.content ?? "");
      const preview = c.length > 200 ? c.slice(0, 200) + "\n…(内容截断)" : c;
      return `  ${i + 1}. ${p}（${c.split("\n").length} 行，${Buffer.byteLength(c)} 字节）\n${lineDiff("", preview)}`;
    });
    if (lines.length > 6) {
      return `批量写入 ${files.length} 个文件:\n${lines.slice(0, 5).join("\n")}\n…(共 ${files.length} 个文件，省略其余)`;
    }
    return `批量写入 ${files.length} 个文件:\n${lines.join("\n")}`;
  }

  if (name === "batch_edit_file") {
    const edits = args.edits as { path?: string; old_string?: string; new_string?: string }[] | undefined;
    if (!Array.isArray(edits) || edits.length === 0) return "batch_edit_file（空列表）";
    const lines: string[] = [];
    for (const e of edits) {
      const p = String(e.path ?? "");
      const oldS = String(e.old_string ?? "");
      const newS = String(e.new_string ?? "");
      let warn = "";
      try {
        const content = await readFile(p, "utf8");
        if (!content.includes(oldS)) warn = " ⚠️ 未找到匹配";
      } catch {
        warn = " ⚠️ 读不到该文件";
      }
      const diff = lineDiff(oldS, newS);
      lines.push(`${p}${warn}\n${diff}`);
    }
    if (lines.length > 6) {
      return `批量编辑 ${edits.length} 个文件:\n${lines.slice(0, 5).join("\n---\n")}\n…(共 ${edits.length} 个文件，省略其余)`;
    }
    return `批量编辑 ${edits.length} 个文件:\n${lines.join("\n---\n")}`;
  }

  return `${name}(${JSON.stringify(args)})`;
}
