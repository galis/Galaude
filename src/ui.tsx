import { useCallback, useEffect, useRef, useState } from "react";
import { render, Box, Text, useApp, useStdin, useStdout } from "ink";
import {
  runAgent,
  createSession,
  resumeSession,
  persist,
  getApprovalMode,
  setApprovalMode,
  SYSTEM_PROMPT,
  type Session,
  type Emitter,
  type ApprovalRequest,
} from "./agent.js";
import { listSessions, loadSession, type StoredSession } from "./store.js";
import { contextReport } from "./compress.js";
import { config } from "./config.js";
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
  { name: "/mode", desc: "切换确认模式 auto（判风险才确认）/ strict（一律确认）" },
  { name: "/clear", desc: "清空上下文（开新对话）" },
  { name: "/exit", desc: "退出（/quit 等同）" },
];
export const HELP =
  "可用命令：\n" + COMMANDS.map((c) => `  ${c.name}  ${c.desc}`).join("\n");

// 屏幕上的一条记录。
type Item =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool_call"; name: string; argsText: string }
  | { kind: "tool_result"; result: string }
  | { kind: "note"; text: string };

// 估算显示宽度：CJK/全角/emoji 记 2 列，其余 1 列（用于按终端宽度折行）。
function dispWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x1f300 && c <= 0x1faff);
    w += wide ? 2 : 1;
  }
  return w;
}

// 按显示宽度把一段文字折成若干行。
function wrap(s: string, width: number): string[] {
  const out: string[] = [];
  for (const raw of s.split("\n")) {
    let cur = "";
    let cw = 0;
    for (const ch of raw) {
      const w = dispWidth(ch);
      if (cw + w > width && cur) {
        out.push(cur);
        cur = ch;
        cw = w;
      } else {
        cur += ch;
        cw += w;
      }
    }
    out.push(cur);
  }
  return out;
}

// 一行渲染数据（带颜色）——把所有 Item 摊成行，便于做行级滚动窗口。
type VLine = { text: string; color?: string; dim?: boolean };
function itemLines(it: Item, width: number): VLine[] {
  const mk = (s: string, color?: string, dim?: boolean): VLine[] =>
    wrap(s, width).map((t) => ({ text: t, color, dim }));
  switch (it.kind) {
    case "user":
      return mk("💬 " + it.text, "cyan");
    case "assistant":
      return mk("🤖 " + it.text);
    case "tool_call":
      return mk(`🔧 ${it.name}(${it.argsText})`, "yellow");
    case "tool_result":
      return mk(" ↳ " + it.result, "green");
    case "note":
      return mk(it.text, undefined, true);
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
    } else if (m.role === "tool") {
      out.push({ kind: "tool_result", result: typeof m.content === "string" ? m.content : "" });
    }
  }
  return out;
}

// 输入行上方的实时命令菜单：命中前缀亮绿，其余青色，随输入筛选。
function CommandMenu({ input }: { input: string }) {
  const hits = COMMANDS.filter((c) => c.name.startsWith(input));
  return (
    <Box flexDirection="column">
      <Text dimColor>── 命令（Enter 执行）──</Text>
      {hits.length === 0 ? (
        <Text dimColor> （无匹配命令）</Text>
      ) : (
        hits.map((c) => (
          <Text key={c.name}>
            {"  "}
            <Text color="green" bold>
              {c.name.slice(0, input.length)}
            </Text>
            <Text color="cyan">{c.name.slice(input.length)}</Text>
            {"  "}
            <Text dimColor>{c.desc}</Text>
          </Text>
        ))
      )}
    </Box>
  );
}

function App({ session }: { session: Session }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const { setRawMode, isRawModeSupported } = useStdin();
  const [items, setItems] = useState<Item[]>(() => [
    { kind: "note", text: `📝 会话 ${session.id} · 日志 ${session.logger.path}` },
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
  const [mode, setMode] = useState(getApprovalMode()); // 确认门模式 auto/strict
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
  // 会话切换选择器：list=候选会话，index=高亮项
  const [picker, setPicker] = useState<{
    list: StoredSession[];
    index: number;
  } | null>(null);

  // 切换到某个会话：先存当前，再把目标会话的历史装进来并铺到界面。
  const switchSession = useCallback(
    (stored: StoredSession) => {
      persist(session); // 当前会话先保存
      const ns = resumeSession(stored);
      session.id = ns.id;
      session.createdAt = ns.createdAt;
      session.logger = ns.logger;
      session.round = ns.round;
      session.lastPromptTokens = ns.lastPromptTokens;
      session.messages.length = 0;
      session.messages.push(...ns.messages);
      setPicker(null);
      setCtxTokens(ns.lastPromptTokens); // ctx 占比也切到目标会话
      setHistory(userTexts(ns.messages)); // 输入历史也跟着切到目标会话
      histPosRef.current = null;
      setItems([
        { kind: "note", text: `↩️ 已切换到会话 ${ns.id}（${ns.messages.length} 条历史）` },
        ...messagesToItems(ns.messages),
      ]);
    },
    [session]
  );

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
      if (busy) return;
      const text = raw.trim();
      setInput("");
      setCursor(0);
      setScroll(0); // 提交即回到底部跟随
      histPosRef.current = null; // 退出历史浏览
      draftRef.current = "";
      if (!text) return;
      // 记录到输入历史（连续重复不重复记）
      setHistory((h) => (h[h.length - 1] === text ? h : [...h, text]));

      if (text === "/exit" || text === "/quit") return exit();
      if (text === "/help") return push({ kind: "note", text: HELP });
      if (text === "/new") {
        // 开新会话：换 id/历史/日志（旧会话已存盘，可日后 --resume 恢复）
        const fresh = createSession();
        session.id = fresh.id;
        session.createdAt = fresh.createdAt;
        session.logger = fresh.logger;
        session.round = 0;
        session.lastPromptTokens = 0;
        session.messages.length = 0;
        session.messages.push(...fresh.messages);
        setHistory([]); // 新会话输入历史清空
        histPosRef.current = null;
        setCtxTokens(0);
        setItems([{ kind: "note", text: `🆕 新会话 ${fresh.id}` }]);
        return;
      }
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
      if (text === "/clear") {
        session.messages.length = 0;
        session.messages.push({ role: "system", content: SYSTEM_PROMPT });
        setItems([{ kind: "note", text: "🧹 已清空上下文（新对话）" }]);
        return;
      }
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
      if (text.startsWith("/"))
        return push({ kind: "note", text: `❓ 未知命令 ${text}（/help）` });

      push({ kind: "user", text });
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
          push({ kind: "tool_call", name: ev.name, argsText: ev.argsText });
        } else if (ev.type === "tool_result") {
          push({ kind: "tool_result", result: ev.result });
        } else if (ev.type === "usage") {
          setCtxTokens(ev.promptTokens); // 实时更新标题栏 ctx 占比
        } else if (ev.type === "note") {
          push({ kind: "note", text: ev.text }); // 如「已折叠」提示
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
        setBusy(false);
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

      // —— 生成中：只允许滚动（上面已处理），其余忽略 ——
      if (busyRef.current) return;

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
        else if (s === "\r" || s === "\n") switchRef.current(pk.list[pk.index]!);
        else if (s === "\x1b") setPicker(null);
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
            const names = COMMANDS.map((c) => c.name).filter((n) =>
              n.startsWith(inp)
            );
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
    !busy && inCmd && !approval && !picker ? COMMANDS.length + 1 : 0;
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

  // 把所有内容（含正在流式的答案）摊成行，再按滚动偏移取一个窗口。
  const allLines: VLine[] = [
    ...items.flatMap((it) => itemLines(it, size.cols)),
    ...(streaming ? itemLines({ kind: "assistant", text: streaming }, size.cols) : []),
    ...(busy && !streaming
      ? [{ text: "🤖 思考中…", color: "yellow" } as VLine]
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
        {ctxTokens > 0 ? (
          <Text dimColor>
            {"  "}ctx {Math.round((ctxTokens / config.compress.budget) * 100)}%
            {ctxTokens > config.compress.budget * config.compress.trimFrac
              ? " 🗜裁剪中"
              : ""}
          </Text>
        ) : null}
        {off > 0 ? (
          <Text color="yellow"> ↑已上滚 {off} 行（滚到底自动跟随）</Text>
        ) : null}
      </Text>

      {/* 内容区：行级滚动窗口，自上而下排，输入框留在最底 */}
      <Box flexGrow={1} flexDirection="column" overflow="hidden">
        {view.map((l, i) => (
          <Text key={i} color={l.color} dimColor={l.dim}>
            {l.text || " "}
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
          {!busy && inCmd ? <CommandMenu input={input} /> : null}

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
