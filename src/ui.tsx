import { useCallback, useEffect, useRef, useState } from "react";
import { render, Box, Text, useApp, useStdin, useStdout } from "ink";
import { createSession, resumeSession, adoptSession, persist, type Session } from "./session.js";
import { getApprovalMode, setApprovalMode, type Emitter, type ApprovalRequest } from "./events.js";
import { runAgent } from "./engine.js"; // 引擎接缝：ENGINE=langgraph 可切换实现
import {
  listSessions,
  loadSession,
  type StoredSession,
  type SessionMeta,
} from "./store.js";
import { type Todo } from "./todo.js";
import { renderMemory } from "./memory.js";
import {
  scanSkills,
  renderSkillList,
} from "./skill.js";
import { loadGlobalMemory } from "./store.js";
import { contextReport } from "./compress.js";
import { describeToolBrief } from "./tools.js";
import { config } from "./config.js";
import { mdToLines, plainToLines, type Line } from "./markdown.js";
import { scanCommands, expandCommand, type CommandMeta } from "./commands.js";
import type OpenAI from "openai";

type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;

// 斜杠命令表：菜单、/help 单一来源。
export const COMMANDS: { name: string; desc: string }[] = [
  { name: "/help", desc: "显示帮助" },
  { name: "/new", desc: "开一个新会话" },
  { name: "/resume", desc: "切换到某个历史会话（可选 id，或回车选择）" },
  { name: "/sessions", desc: "列出历史会话" },
  { name: "/history", desc: "打印当前历史的 role 时间线" },
  { name: "/context", desc: "显示当前上下文占用情况" },
  { name: "/todo", desc: "显示当前任务清单（只读；增删让 agent 代劳）" },
  { name: "/memory", desc: "显示当前长期记忆（只读；增删让 agent 代劳）" },
  { name: "/skill", desc: "skill 管理：/skill list 列出所有（名+描述+文件路径），需要时用 read_file 读取" },
  { name: "/mode", desc: "切换确认模式 auto（判风险才确认）/ strict（一律确认）" },
  { name: "/clear", desc: "清空上下文（开新对话）" },
  { name: "/exit", desc: "退出（/quit 等同）" },
];
/** 构建帮助文本（含自定义命令，每次调用实时扫描）。 */
export function buildHelp(): string {
  const custom = scanCommands().map((c) => ({ name: `/${c.name}`, desc: `${c.description}（自定义）` }));
  const customNames = new Set(custom.map((c) => c.name));
  const builtin = COMMANDS.filter((c) => !customNames.has(c.name));
  const all = [...custom, ...builtin];
  return "可用命令：\n" + all.map((c) => `  ${c.name}  ${c.desc}`).join("\n");
}
// 兼容旧导出（启动时快照，/help 命令用 buildHelp 获取实时列表）
export let HELP = buildHelp();

// 屏幕上的一条记录。
type Item =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool_call"; name: string; argsText: string }
  | { kind: "tool_result"; result: string }
  | { kind: "note"; text: string }
  | { kind: "todos"; todos: Todo[] }
  | { kind: "memory"; text: string }
  | { kind: "skill"; text: string };

// 用户侧任务状态图标（BMP 符号，避开 emoji 列宽坑；模型侧另用 [x]/[~]/[ ]）。
const TODO_ICON: Record<Todo["status"], string> = {
  pending: "☐",
  in_progress: "⟳",
  completed: "☑",
};

// 把一条 Item 摊成「带样式的行」（Line=Span[]），便于做行级滚动窗口。
// assistant 内容走 markdown 渲染；其余纯文本套基础样式。
function itemLines(it: Item, width: number): Line[] {
  switch (it.kind) {
    case "user":
      return plainToLines("💬 " + it.text, width, { color: "cyan" });
    case "assistant": {
      const ls = mdToLines(it.text, width);
      if (ls.length === 0) ls.push([]);
      ls[0] = [{ text: "🤖 " }, ...ls[0]!]; // 首行前面挂上机器人标记
      return ls;
    }
    case "tool_call": {
      const desc = it.argsText
        ? describeToolBrief(it.name, it.argsText)
        : it.name;
      return plainToLines(`🔧 ${desc}`, width, { color: "yellow" });
    }
    case "tool_result":
      return plainToLines(" ↳ " + it.result, width, { color: "green" });
    case "note":
      return plainToLines(it.text, width, { dim: true });
    case "todos": {
      const done = it.todos.filter((t) => t.status === "completed").length;
      const lines: Line[] = [
        [{ text: `📋 计划 ${done}/${it.todos.length}`, color: "magenta" }],
      ];
      for (const t of it.todos)
        lines.push([
          {
            text: `  ${TODO_ICON[t.status]} ${t.content}`,
            dim: t.status === "completed",
          },
        ]);
      return lines;
    }
    case "memory":
      return plainToLines(it.text, width, { color: "blue" });
    case "skill":
      return plainToLines(it.text, width, { color: "yellow" });
  }
}

// 取一组字符串的最长公共前缀（Tab 补全多个候选时用）。
function commonPrefix(arr: string[]): string {
  if (arr.length === 0) return "";
  let pre = arr[0]!;
  for (const s of arr) while (!s.startsWith(pre)) pre = pre.slice(0, -1);
  return pre;
}

// 从 messages 里取出用户说过的话（绑定到 session 的输入历史）。
function userTexts(messages: Message[]): string[] {
  return messages
    .filter((m) => m.role === "user")
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .filter(Boolean);
}

// 把已存的 messages 历史还原成屏幕条目（恢复会话时铺到界面上）。
function messagesToItems(messages: Message[]): Item[] {
  const out: Item[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ kind: "user", text: typeof m.content === "string" ? m.content : "" });
    } else if (m.role === "assistant") {
      if (typeof m.content === "string" && m.content)
        out.push({ kind: "assistant", text: m.content });
      const tcs = (m as { tool_calls?: { function: { name: string; arguments: string } }[] })
        .tool_calls;
      if (tcs)
        for (const tc of tcs)
          out.push({ kind: "tool_call", name: tc.function.name, argsText: tc.function.arguments });
    }
    // role:"tool"（工具结果）恢复时不铺到界面——只在日志里
  }
  return out;
}

// 输入行上方的实时命令菜单：命中前缀亮绿，其余青色，随输入筛选。
// 自定义命令用黄色标记，放在内置命令前面。
function CommandMenu({ input, customCommands }: { input: string; customCommands: CommandMeta[] }) {
  const custom = customCommands.map((c) => ({ name: `/${c.name}`, desc: `${c.description}（自定义）` }));
  const customNames = new Set(custom.map((c) => c.name));
  const builtin = COMMANDS.filter((c) => !customNames.has(c.name));
  const all = [...custom, ...builtin];
  const hits = all.filter((c) => c.name.startsWith(input));
  return (
    <Box flexDirection="column">
      <Text dimColor>── 命令（Enter 执行）──</Text>
      {hits.length === 0 ? (
        <Text dimColor> （无匹配命令）</Text>
      ) : (
        hits.map((c) => {
          const isCustom = customNames.has(c.name);
          return (
            <Text key={c.name}>
              {"  "}
              <Text color="green" bold>
                {c.name.slice(0, input.length)}
              </Text>
              <Text color={isCustom ? "yellow" : "cyan"}>{c.name.slice(input.length)}</Text>
              {"  "}
              <Text dimColor>{c.desc}</Text>
            </Text>
          );
        })
      )}
    </Box>
  );
}

function App({ session }: { session: Session }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const { setRawMode, isRawModeSupported } = useStdin();
  const [items, setItems] = useState<Item[]>(() => [
    {
      kind: "note",
      text: `📝 会话 ${session.id} · 引擎 ${config.engine} · 日志 ${session.logger.path}`,
    },
    ...messagesToItems(session.messages), // 恢复会话时把历史铺上来
  ]);
  const [input, setInput] = useState("");
  const [cursor, setCursor] = useState(0); // 光标在 input 中的位置（0..len）
  // 输入历史绑定当前会话：初始就用会话里说过的话（恢复会话时也能 ↑ 翻）
  const [history, setHistory] = useState<string[]>(() =>
    userTexts(session.messages)
  );
  const [streaming, setStreaming] = useState("");
  const [busy, setBusy] = useState(false);
  const [ctxTokens, setCtxTokens] = useState(() => session.lastPromptTokens); // 当前上下文 token
  const [outputTokens, setOutputTokens] = useState(0); // 累积输出 token
  const [inputTokens, setInputTokens] = useState(0); // 累积输入 token（prompt）
  const [requestCount, setRequestCount] = useState(0); // 已发请求次数
  const [mode, setMode] = useState(getApprovalMode()); // 确认门模式 auto/strict
  const [activeTools, setActiveTools] = useState(0); // 后台正在跑的工具数
  const [todos, setTodos] = useState<Todo[]>(() => session.plan.todos); // 任务清单（面板用）
  const [tick, setTick] = useState(0); // 驱动 spinner 动画的帧计数
  const [scroll, setScroll] = useState(0); // 从底部往上滚的行数，0=跟随最新
  const [size, setSize] = useState({
    cols: stdout.columns || 80,
    rows: stdout.rows || 24,
  });
  const abortRef = useRef<AbortController | null>(null); // 当前生成的中断器
  const [approval, setApproval] = useState<ApprovalRequest | null>(null); // 待确认的工具
  const approveResolveRef = useRef<((ok: boolean) => void) | null>(null);
  const histPosRef = useRef<number | null>(null); // 当前浏览到的历史下标；null=未浏览
  const draftRef = useRef(""); // 进入历史浏览前暂存的草稿
  // 会话切换选择器：list=候选会话元信息，index=高亮项（选中时才读完整文件）
  const [picker, setPicker] = useState<{
    list: SessionMeta[];
    index: number;
  } | null>(null);
  // 自定义命令（启动时扫描一次）
  const [customCommands, setCustomCommands] = useState<CommandMeta[]>([]);
  useEffect(() => { setCustomCommands(scanCommands()); }, []);

  // 切换到某个会话：先存当前，再把目标会话【全部状态】装进来并铺到界面。
  // 整体交接必须走 adoptSession——手抄字段列表漏过压缩状态（摘要/记忆/水位线），
  // 会让旧会话的摘要挂到新会话上、还持久化进新会话存档。
  const switchSession = useCallback(
    (stored: StoredSession) => {
      persist(session); // 当前会话先保存
      const ns = resumeSession(stored);
      adoptSession(session, ns);
      setPicker(null);
      setCtxTokens(ns.lastPromptTokens); // ctx 占比切到目标会话
      setInputTokens(0); // 新会话输入 token 从零开始
      setOutputTokens(0); // 新会话输出 token 从零开始
      setRequestCount(0); // 请求次数从零开始
      setTodos(ns.plan.todos); // 面板切到目标会话的清单
      setHistory(userTexts(ns.messages)); // 输入历史也跟着切到目标会话
      histPosRef.current = null;
      setItems([
        { kind: "note", text: `↩️ 已切换到会话 ${ns.id}（${ns.messages.length} 条历史）` },
        ...messagesToItems(ns.messages),
      ]);
    },
    [session]
  );

  // 处理中时让 spinner 转起来：busy 期间每 100ms 推进一帧，空闲就停（不空转重绘）。
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => setTick((t) => t + 1), 100);
    return () => clearInterval(id);
  }, [busy]);

  // 跟随终端尺寸变化（备用屏进入/退出在 renderUI 里）。
  useEffect(() => {
    const onResize = () =>
      setSize({ cols: stdout.columns || 80, rows: stdout.rows || 24 });
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  const push = useCallback((it: Item) => setItems((xs) => [...xs, it]), []);

  const onSubmit = useCallback(
    async (raw: string) => {
      // busy 是 state（异步刷新）：同一个 stdin chunk 里连着两个换行（粘贴多行文本）
      // 会在它还没刷新时把 onSubmit 同步调两次，两个 runAgent 并发写同一份历史。
      // 所以再用 busyRef 做同步守卫（进入跑 agent 分支时立刻置位）。
      if (busy || busyRef.current) return;
      let text = raw.trim();
      setInput("");
      setCursor(0);
      setScroll(0); // 提交即回到底部跟随
      histPosRef.current = null; // 退出历史浏览
      draftRef.current = "";
      if (!text) return;
      // 记录到输入历史（连续重复不重复记）
      setHistory((h) => (h[h.length - 1] === text ? h : [...h, text]));

      // 开新会话：换 id/历史/日志/压缩状态（旧会话已存盘，可日后 --resume 恢复）。
      // /clear 语义相同——曾经它复用旧 id 只清 messages，下次 persist 会用
      // 清空后的历史【覆盖旧会话存档】，且摘要/记忆/水位线全残留。
      const startFresh = (prefix: string) => {
        const fresh = createSession();
        adoptSession(session, fresh);
        setHistory([]); // 新会话输入历史清空
        histPosRef.current = null;
        setCtxTokens(0);
        setInputTokens(0);
        setOutputTokens(0);
        setRequestCount(0);
        setTodos([]);
        setItems([{ kind: "note", text: `${prefix} ${fresh.id}` }]);
      };
      if (text === "/exit" || text === "/quit") return exit();
      if (text === "/help") {
        HELP = buildHelp(); // 每次 /help 实时扫描自定义命令
        return push({ kind: "note", text: HELP });
      }
      if (text === "/new") return startFresh("🆕 新会话");
      if (text === "/resume" || text.startsWith("/resume ")) {
        const arg = text.slice("/resume".length).trim();
        if (arg) {
          const s = loadSession(arg);
          if (!s) return push({ kind: "note", text: `❓ 找不到会话: ${arg}` });
          switchSession(s);
        } else {
          const list = listSessions();
          if (list.length === 0)
            return push({ kind: "note", text: "（暂无历史会话）" });
          setPicker({ list, index: 0 }); // 打开选择器
        }
        return;
      }
      if (text === "/sessions") {
        const list = listSessions().slice(0, 12);
        if (list.length === 0)
          return push({ kind: "note", text: "（暂无历史会话）" });
        const lines = list
          .map((s) => `  ${s.id}${s.id === session.id ? " *当前" : ""}  ${s.title}`)
          .join("\n");
        return push({
          kind: "note",
          text: "历史会话（启动时 --resume <id> 恢复）：\n" + lines,
        });
      }
      if (text === "/clear") return startFresh("🧹 已清空上下文，新会话");
      if (text === "/history") {
        const tl = session.messages.map((m) => m.role).join(" → ");
        return push({
          kind: "note",
          text: `🧠 历史（${session.messages.length} 条）: ${tl}`,
        });
      }
      if (text === "/context") {
        return push({ kind: "note", text: contextReport(session) });
      }
      if (text === "/todo" || text === "/todo list") {
        return session.plan.todos.length
          ? push({ kind: "todos", todos: session.plan.todos })
          : push({ kind: "note", text: "（任务清单为空）" });
      }
      if (text === "/memory") {
        const merged = [...loadGlobalMemory(), ...session.memory];
        return push({ kind: "memory", text: renderMemory(merged) });
      }
      if (text.startsWith("/skill")) {
        const list = scanSkills();
        return push({ kind: "skill", text: renderSkillList(list) });
      }
      if (text === "/mode" || text.startsWith("/mode ")) {
        const arg = text.slice(5).trim();
        const next =
          arg === "auto" || arg === "strict"
            ? arg
            : mode === "auto"
              ? "strict"
              : "auto";
        setApprovalMode(next);
        setMode(next);
        return push({
          kind: "note",
          text:
            next === "auto"
              ? "🔁 确认模式：auto —— 危险工具先让模型判风险，只有有风险才确认"
              : "🔁 确认模式：strict —— 危险工具（run_bash/write_file/edit_file）一律确认",
        });
      }
      // —— 自定义命令（/ 开头且不在内置列表中）：展开模板后发送 ——
      if (text.startsWith("/")) {
        const cmdName = text.split(/\s+/)[0]!.slice(1);
        const cmd = customCommands.find((c) => c.name === cmdName);
        if (cmd) {
          const arg = text.slice(cmdName.length + 1).trim();
          const expanded = expandCommand(cmdName, arg);
          if (!expanded)
            return push({ kind: "note", text: `❓ 命令模板加载失败: /${cmdName}` });
          push({ kind: "user", text }); // 屏幕显示原始命令
          text = expanded; // 传给模型的是展开后的 prompt
          // 继续走下方 agent 流程
        } else {
          return push({ kind: "note", text: `❓ 未知命令 ${text}（/help）` });
        }
      }

      if (!text.startsWith("/")) { // 非命令：正常 push user 消息
        push({ kind: "user", text });
      }
      busyRef.current = true; // 同步置位（见函数开头的守卫说明）
      setBusy(true);
      const ac = new AbortController(); // Ctrl+C 时 abort 它来中断本次生成
      abortRef.current = ac;
      let acc = "";
      const emit: Emitter = (ev) => {
        if (ev.type === "assistant") {
          acc += ev.text;
          setStreaming(acc);
        } else if (ev.type === "tool_call") {
          acc = "";
          setStreaming("");
          setActiveTools((n) => n + 1); // 起一个工具
          push({ kind: "tool_call", name: ev.name, argsText: ev.argsText });
        } else if (ev.type === "tool_result") {
          setActiveTools((n) => Math.max(0, n - 1)); // 完成一个；结果不显示（在日志里）
        } else if (ev.type === "usage") {
          setCtxTokens(ev.promptTokens); // 实时更新标题栏 ctx 占比
          setInputTokens((n) => n + ev.promptTokens); // 累积输入 token
          setOutputTokens((n) => n + ev.completionTokens); // 累积输出 token
          setRequestCount((n) => n + 1); // 请求计数
        } else if (ev.type === "note") {
          push({ kind: "note", text: ev.text }); // 如「已折叠」提示
        } else if (ev.type === "todos") {
          setTodos(ev.todos); // 刷新标题栏常驻的 📋 done/total
          push({ kind: "todos", todos: ev.todos }); // 详情变化时印入流
        }
      };
      // 工具确认门：危险工具执行前，挂起并弹确认框，等用户按 y/n 才 resolve。
      const approve = (req: ApprovalRequest) =>
        new Promise<boolean>((resolve) => {
          approveResolveRef.current = resolve;
          setApproval(req);
        });
      try {
        const answer = await runAgent(session, text, emit, ac.signal, approve);
        // 中断时流可能「优雅结束」（不抛错）：保留已生成的部分，并标注已中断。
        if (ac.signal.aborted) {
          if (answer.trim()) push({ kind: "assistant", text: answer });
          push({ kind: "note", text: "⛔ 已中断" });
        } else {
          push({ kind: "assistant", text: answer });
        }
      } catch (err) {
        if (ac.signal.aborted) push({ kind: "note", text: "⛔ 已中断" });
        else
          push({
            kind: "note",
            text: `❌ 出错: ${err instanceof Error ? err.message : String(err)}`,
          });
      } finally {
        abortRef.current = null;
        setStreaming("");
        busyRef.current = false;
        setBusy(false);
        setActiveTools(0);
      }
    },
    [busy, exit, push, session]
  );

  // 用 ref 让 stdin 监听器始终拿到最新的 input/busy/onSubmit（避免闭包过期）。
  const inputRef = useRef(input);
  inputRef.current = input;
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const submitRef = useRef(onSubmit);
  submitRef.current = onSubmit;
  const historyRef = useRef(history);
  historyRef.current = history;
  const pickerRef = useRef(picker);
  pickerRef.current = picker;
  const switchRef = useRef(switchSession);
  switchRef.current = switchSession;

  // 自己接管全部 stdin 解析（不再用 ink 的 useInput）——这样鼠标上报序列绝不会
  // 被当成「打字」塞进输入框。同时开启鼠标上报、统一处理滚轮 + 键盘。
  useEffect(() => {
    if (isRawModeSupported) setRawMode(true);
    stdout.write("\x1b[?1000h\x1b[?1006h"); // 开启鼠标上报（SGR）
    const onData = (buf: Buffer) => {
      let s = buf.toString("utf8");

      // —— 鼠标滚轮 / PageUp/Down → 滚动历史区（任何时候都允许）——
      let delta = 0;
      s = s.replace(/\x1b\[<(\d+);\d+;\d+[Mm]/g, (_m, b: string) => {
        const n = parseInt(b, 10);
        if (n >= 64) delta += n & 1 ? -3 : 3;
        return "";
      });
      s = s.replace(/\x1b\[5~/g, () => ((delta += 5), ""));
      s = s.replace(/\x1b\[6~/g, () => ((delta -= 5), ""));
      if (delta) setScroll((o) => Math.max(0, o + delta));

      // —— Ctrl+C ——
      if (s.includes("\x03")) {
        if (approveResolveRef.current) {
          const r = approveResolveRef.current;
          approveResolveRef.current = null;
          setApproval(null);
          r(false);
          abortRef.current?.abort();
        } else if (busyRef.current && abortRef.current) abortRef.current.abort();
        else exit();
        return;
      }

      // —— 工具确认门待回应：只认 y/n/Enter/Esc，其它键忽略 ——
      if (approveResolveRef.current) {
        const r = approveResolveRef.current;
        const yes = /[yY]/.test(s) || s.includes("\r") || s.includes("\n");
        const escAlone = s.includes("\x1b") && !s.includes("\x1b[");
        if (yes || /[nN]/.test(s) || escAlone) {
          approveResolveRef.current = null;
          setApproval(null);
          r(yes);
        }
        return;
      }

      // —— 生成中：只允许滚动和 ESC 中断，其余忽略 ——
      if (busyRef.current) {
        const escAlone = s.includes("\x1b") && !s.includes("\x1b[");
        if (escAlone) abortRef.current?.abort();
        return;
      }

      // —— 会话选择器：↑↓ 选、Enter 切换、Esc 取消 ——
      if (pickerRef.current) {
        const pk = pickerRef.current;
        if (s.startsWith("\x1b[A"))
          setPicker({ list: pk.list, index: Math.max(0, pk.index - 1) });
        else if (s.startsWith("\x1b[B"))
          setPicker({
            list: pk.list,
            index: Math.min(pk.list.length - 1, pk.index + 1),
          });
        else if (s === "\r" || s === "\n") {
          // 列表里只有元信息，选中这一刻才读完整会话文件
          const full = loadSession(pk.list[pk.index]!.id);
          if (full) switchRef.current(full);
          else {
            setPicker(null);
            push({ kind: "note", text: `❓ 会话文件读不出来: ${pk.list[pk.index]!.id}` });
          }
        } else if (s === "\x1b") setPicker(null);
        return;
      }

      // —— 行编辑：用局部工作副本，避免一个 chunk 内多次 setState 读到旧值 ——
      let inp = inputRef.current;
      let cur = cursorRef.current;
      let touched = false;
      // 历史浏览：dir=-1 更早，dir=+1 更新
      const histNav = (dir: number) => {
        const h = historyRef.current;
        if (h.length === 0) return;
        if (histPosRef.current === null) {
          if (dir > 0) return; // 没在浏览时按 ↓ 不动
          draftRef.current = inp; // 保存草稿
          histPosRef.current = h.length;
        }
        let p = histPosRef.current + dir;
        if (p >= h.length) {
          histPosRef.current = null; // 回到草稿
          inp = draftRef.current;
        } else {
          p = Math.max(0, p);
          histPosRef.current = p;
          inp = h[p]!;
        }
        cur = inp.length;
        touched = true;
      };

      let i = 0;
      while (i < s.length) {
        const rest = s.slice(i);
        if (rest[0] === "\x1b") {
          if (rest.startsWith("\x1b[A")) (histNav(-1), (i += 3)); // ↑
          else if (rest.startsWith("\x1b[B")) (histNav(1), (i += 3)); // ↓
          else if (rest.startsWith("\x1b[C")) ((cur = Math.min(inp.length, cur + 1)), (touched = true), (i += 3)); // →
          else if (rest.startsWith("\x1b[D")) ((cur = Math.max(0, cur - 1)), (touched = true), (i += 3)); // ←
          else if (rest.startsWith("\x1b[H")) ((cur = 0), (touched = true), (i += 3)); // Home
          else if (rest.startsWith("\x1b[F")) ((cur = inp.length), (touched = true), (i += 3)); // End
          else {
            const m = /^\x1b\[[0-9;]*[A-Za-z~]/.exec(rest);
            if (m) i += m[0].length; // 其它 CSI：跳过
            else {
              inp = ""; // 单独的 ESC：清空
              cur = 0;
              touched = true;
              i += 1;
            }
          }
          continue;
        }
        const ch = rest[0]!;
        const code = ch.codePointAt(0)!;
        if (ch === "\r" || ch === "\n") {
          submitRef.current(inp);
          inp = "";
          cur = 0;
          touched = true;
        } else if (code === 127 || code === 8) {
          if (cur > 0) {
            inp = inp.slice(0, cur - 1) + inp.slice(cur); // 删光标前一个字
            cur -= 1;
            touched = true;
          }
        } else if (code === 9) {
          // Tab：补全斜杠命令（唯一匹配补全整条，多个补到公共前缀）
          if (inp.startsWith("/")) {
            const customNames = customCommands.map((c) => `/${c.name}`);
            const allNames = [...customNames, ...COMMANDS.map((c) => c.name)];
            const names = allNames.filter((n) => n.startsWith(inp));
            if (names.length === 1) inp = names[0]!;
            else if (names.length > 1) inp = commonPrefix(names);
            cur = inp.length;
            touched = true;
          }
        } else if (code >= 32) {
          inp = inp.slice(0, cur) + ch + inp.slice(cur); // 在光标处插入
          cur += ch.length;
          touched = true;
        }
        i += 1;
      }
      if (touched) {
        setInput(inp);
        setCursor(cur);
      }
    };
    process.stdin.on("data", onData);
    return () => {
      process.stdin.off("data", onData);
      stdout.write("\x1b[?1000l\x1b[?1006l");
      if (isRawModeSupported) setRawMode(false);
    };
  }, [stdout, setRawMode, isRawModeSupported, exit]);

  const inCmd = input.startsWith("/");
  const menuRows =
    !busy && inCmd && !approval && !picker
      ? customCommands.length + COMMANDS.length + 1
      : 0;
  // 确认框预览（命令 / diff），最多展示 14 行
  const previewLines = approval ? approval.preview.split("\n").slice(0, 14) : [];
  // 会话选择器：窗口化显示，保证高亮项始终可见
  const PICK_MAX = 8;
  const pStart = picker
    ? Math.max(0, Math.min(picker.index - 3, picker.list.length - PICK_MAX))
    : 0;
  const pickerVisible = picker ? picker.list.slice(pStart, pStart + PICK_MAX) : [];
  // 底部区域高度：确认框 / 选择器 / 输入框(+命令菜单)
  const bottomRows = approval
    ? 2 + previewLines.length
    : picker
      ? 1 + pickerVisible.length
      : 1 + menuRows;
  const contentRows = Math.max(1, size.rows - 1 /*标题*/ - bottomRows);

  // spinner 旋转点（一圈 braille 点在转）。
  const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
  const spinner = SPINNER[tick % SPINNER.length];

  // 把所有内容（含正在流式的答案）摊成行，再按滚动偏移取一个窗口。
  const allLines: Line[] = [
    ...items.flatMap((it) => itemLines(it, size.cols)),
    ...(streaming ? itemLines({ kind: "assistant", text: streaming }, size.cols) : []),
    // 实时状态：spinner 旋转点 + 文案。优先「后台运行 N 个工具」，否则「思考中」
    ...(activeTools > 0
      ? [[{ text: `${spinner} 后台运行 ${activeTools} 个工具`, color: "yellow" }] as Line]
      : busy && !streaming
        ? [[{ text: `${spinner} 思考中`, color: "yellow" }] as Line]
        : []),
  ];
  const maxScroll = Math.max(0, allLines.length - contentRows);
  const off = Math.min(scroll, maxScroll); // 自动跟随：内容增长时底部始终可见
  const end = allLines.length - off;
  const view = allLines.slice(Math.max(0, end - contentRows), end);

  return (
    <Box flexDirection="column" height={size.rows} width={size.cols}>
      {/* 顶部标题栏（固定）；显示 ctx 占比；上滚时显示提示 */}
      <Text color="magentaBright">
        🌀 Galaude · Ink UI —— /help，/exit
        <Text color={mode === "auto" ? "green" : "yellow"}> [{mode}]</Text>
        {requestCount > 0 ? (
          <Text dimColor>
            {"  "}🔢 {requestCount}次
          </Text>
        ) : null}
        {inputTokens > 0 ? (
          <Text dimColor>
            {"  "}📥 {inputTokens >= 1000 ? `${(inputTokens / 1000).toFixed(1)}k` : inputTokens}
          </Text>
        ) : null}
        {outputTokens > 0 ? (
          <Text dimColor>
            {"  "}📤 {outputTokens >= 1000 ? `${(outputTokens / 1000).toFixed(1)}k` : outputTokens}
          </Text>
        ) : null}
        {ctxTokens > 0 ? (
          <Text dimColor>
            {"  "}ctx {Math.round((ctxTokens / config.compress.budget) * 100)}%
            {ctxTokens > config.compress.budget * config.compress.trimFrac
              ? " 🗜裁剪中"
              : ""}
          </Text>
        ) : null}
        {todos.length > 0 ? (
          <Text color="magenta">
            {"  "}📋 {todos.filter((t) => t.status === "completed").length}/
            {todos.length}
          </Text>
        ) : null}
        {off > 0 ? (
          <Text color="yellow"> ↑已上滚 {off} 行（滚到底自动跟随）</Text>
        ) : null}
      </Text>

      {/* 内容区：行级滚动窗口，自上而下排，输入框留在最底。每行=若干带样式 span */}
      <Box flexGrow={1} flexDirection="column" overflow="hidden">
        {view.map((line, i) => (
          <Text key={i}>
            {line.length === 0
              ? " "
              : line.map((sp, j) => (
                  <Text
                    key={j}
                    bold={sp.bold}
                    italic={sp.italic}
                    color={sp.color}
                    dimColor={sp.dim}
                  >
                    {sp.text || " "}
                  </Text>
                ))}
          </Text>
        ))}
      </Box>

      {approval ? (
        /* 工具确认门：危险工具执行前等用户拍板，展示命令 / diff 预览 */
        <Box flexDirection="column">
          <Text color="yellow" bold>
            需要确认 · 允许执行 {approval.name}？
          </Text>
          {previewLines.map((l, i) => (
            <Text
              key={i}
              color={
                l.startsWith("+")
                  ? "green"
                  : l.startsWith("-")
                    ? "red"
                    : undefined
              }
              dimColor={!l.startsWith("+") && !l.startsWith("-")}
            >
              {l || " "}
            </Text>
          ))}
          <Text dimColor>y/Enter 执行 · n/Esc 拒绝 · Ctrl+C 中断</Text>
        </Box>
      ) : picker ? (
        /* 会话选择器：↑↓ 选、Enter 切换、Esc 取消 */
        <Box flexDirection="column">
          <Text color="cyan" bold>
            切换会话（↑↓ 选择 · Enter 切换 · Esc 取消）
          </Text>
          {pickerVisible.map((s, i) => {
            const sel = pStart + i === picker.index;
            return (
              <Text key={s.id} inverse={sel} dimColor={!sel}>
                {sel ? "› " : "  "}
                {s.id}
                {s.id === session.id ? " *当前" : ""} {s.title.slice(0, 38)}
              </Text>
            );
          })}
        </Box>
      ) : (
        <>
          {/* 命令菜单（仅在输入以 / 开头时） */}
          {!busy && inCmd ? <CommandMenu input={input} customCommands={customCommands} /> : null}

          {/* 输入框：永远在最底部；光标块画在 cursor 位置（支持 ←→ 移动） */}
          <Box>
            <Text color="cyan">💬 {"> "}</Text>
            <Text>{input.slice(0, cursor)}</Text>
            {!busy ? (
              <Text inverse>{input.slice(cursor, cursor + 1) || " "}</Text>
            ) : null}
            <Text>{input.slice(cursor + 1)}</Text>
            {!input && !busy ? (
              <Text dimColor>输入问题，/help 看命令，/exit 退出</Text>
            ) : null}
          </Box>
        </>
      )}
    </Box>
  );
}

/** 启动 Ink 界面，返回一个在退出时 resolve 的 Promise。 */
export async function renderUI(session: Session): Promise<void> {
  // 先切到备用屏并清屏，再 render —— 这样首帧直接画在备用屏上，无需按键刷新。
  process.stdout.write("\x1b[?1049h\x1b[2J\x1b[H");
  // exitOnCtrlC: false —— 关掉 ink 自带的 Ctrl+C 退出，改由我们自己处理：
  // 生成中 → 中断本次生成；空闲 → 退出。
  const app = render(<App session={session} />, { exitOnCtrlC: false });
  try {
    await app.waitUntilExit();
  } finally {
    process.stdout.write("\x1b[?1049l"); // 退出时还原普通屏
  }
}
