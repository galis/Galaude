import { useCallback, useEffect, useRef, useState } from "react";
import { render, Box, Text, useApp, useStdin, useStdout } from "ink";
import {
  runAgent,
  SYSTEM_PROMPT,
  type Session,
  type Emitter,
} from "./agent.js";

// 斜杠命令表：菜单、/help 单一来源。
export const COMMANDS: { name: string; desc: string }[] = [
  { name: "/help", desc: "显示帮助" },
  { name: "/history", desc: "打印当前历史的 role 时间线" },
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
  const [items, setItems] = useState<Item[]>([
    { kind: "note", text: `📝 本次会话日志: ${session.logger.path}` },
  ]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState("");
  const [busy, setBusy] = useState(false);
  const [scroll, setScroll] = useState(0); // 从底部往上滚的行数，0=跟随最新
  const [size, setSize] = useState({
    cols: stdout.columns || 80,
    rows: stdout.rows || 24,
  });

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
      setScroll(0); // 提交即回到底部跟随
      if (!text) return;

      if (text === "/exit" || text === "/quit") return exit();
      if (text === "/help") return push({ kind: "note", text: HELP });
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
      if (text.startsWith("/"))
        return push({ kind: "note", text: `❓ 未知命令 ${text}（/help）` });

      push({ kind: "user", text });
      setBusy(true);
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
        }
      };
      try {
        const answer = await runAgent(session, text, emit);
        push({ kind: "assistant", text: answer });
      } catch (err) {
        push({
          kind: "note",
          text: `❌ 出错: ${err instanceof Error ? err.message : String(err)}`,
        });
      } finally {
        setStreaming("");
        setBusy(false);
      }
    },
    [busy, exit, push, session]
  );

  // 用 ref 让 stdin 监听器始终拿到最新的 input/busy/onSubmit（避免闭包过期）。
  const inputRef = useRef(input);
  inputRef.current = input;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const submitRef = useRef(onSubmit);
  submitRef.current = onSubmit;

  // 自己接管全部 stdin 解析（不再用 ink 的 useInput）——这样鼠标上报序列绝不会
  // 被当成「打字」塞进输入框。同时开启鼠标上报、统一处理滚轮 + 键盘。
  useEffect(() => {
    if (isRawModeSupported) setRawMode(true);
    stdout.write("\x1b[?1000h\x1b[?1006h"); // 开启鼠标上报（SGR）
    const onData = (buf: Buffer) => {
      let s = buf.toString("utf8");
      let delta = 0;
      // 鼠标滚轮（SGR）：button 64=上滚（看历史）、65=下滚（回最新）
      s = s.replace(/\x1b\[<(\d+);\d+;\d+[Mm]/g, (_m, b: string) => {
        const n = parseInt(b, 10);
        if (n >= 64) delta += n & 1 ? -3 : 3;
        return "";
      });
      // PageUp / PageDown 也翻历史
      s = s.replace(/\x1b\[5~/g, () => ((delta += 5), ""));
      s = s.replace(/\x1b\[6~/g, () => ((delta -= 5), ""));
      if (delta) setScroll((o) => Math.max(0, o + delta));
      // 丢弃其它转义/CSI 序列（方向键等），剩下的才是真正的键入
      s = s.replace(/\x1b\[[0-9;]*[A-Za-z~]/g, "").replace(/\x1b./g, "");
      for (const ch of s) {
        const code = ch.codePointAt(0)!;
        if (code === 3) return exit(); // Ctrl+C
        if (busyRef.current) continue; // 处理中只接受滚动 / Ctrl+C
        if (ch === "\r" || ch === "\n") submitRef.current(inputRef.current);
        else if (code === 127 || code === 8) setInput((v) => v.slice(0, -1));
        else if (code === 27) setInput(""); // Esc 清空
        else if (code >= 32) setInput((v) => v + ch); // 可见字符
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
  const menuRows = !busy && inCmd ? COMMANDS.length + 1 : 0;
  const contentRows = Math.max(1, size.rows - 2 /*标题+输入*/ - menuRows);

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
      {/* 顶部标题栏（固定）；上滚时显示提示 */}
      <Text color="magentaBright">
        🌀 Galaude · Ink UI —— /help 看命令，/exit 退出
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

      {/* 命令菜单（仅在输入以 / 开头时） */}
      {!busy && inCmd ? <CommandMenu input={input} /> : null}

      {/* 输入框：永远是最后一行 = 终端最底部。光标块紧跟 "> " 之后 */}
      <Box>
        <Text color="cyan">💬 {"> "}</Text>
        <Text>{input}</Text>
        {!busy ? <Text inverse> </Text> : null}
        {!input && !busy ? (
          <Text dimColor>输入问题，/help 看命令，/exit 退出</Text>
        ) : null}
      </Box>
    </Box>
  );
}

/** 启动 Ink 界面，返回一个在退出时 resolve 的 Promise。 */
export async function renderUI(session: Session): Promise<void> {
  // 先切到备用屏并清屏，再 render —— 这样首帧直接画在备用屏上，无需按键刷新。
  process.stdout.write("\x1b[?1049h\x1b[2J\x1b[H");
  const app = render(<App session={session} />);
  try {
    await app.waitUntilExit();
  } finally {
    process.stdout.write("\x1b[?1049l"); // 退出时还原普通屏
  }
}
