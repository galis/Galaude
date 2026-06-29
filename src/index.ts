import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { createSession, resumeSession, runAgent } from "./agent.js";
import { latestSession, loadSession } from "./store.js";
import { renderUI, HELP } from "./ui.js";

// 参数解析：
//   --ui            强制进入交互界面（UI 优先于一次性）
//   --continue / -c 接最近一次会话
//   --resume <id>   接指定会话（id 可只给前缀）
//   其余文本        一次性模式的问题
const argv = process.argv.slice(2);
let forceUi = false;
let cont = false;
let resumeId: string | undefined;
const rest: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a === "--ui") forceUi = true;
  else if (a === "--continue" || a === "-c") cont = true;
  else if (a === "--resume") resumeId = argv[++i];
  else rest.push(a);
}
const oneShot = rest.join(" ").trim();

// 建立 / 恢复会话。
let session;
if (resumeId) {
  const s = loadSession(resumeId);
  if (!s) {
    console.error(`❌ 找不到会话: ${resumeId}（用 /sessions 或看 sessions/ 目录）`);
    process.exit(1);
  }
  session = resumeSession(s);
  console.log(`↩️  已恢复会话 ${s.id}（${s.messages.length} 条历史）`);
} else if (cont) {
  const s = latestSession();
  session = s ? resumeSession(s) : createSession();
  if (s) console.log(`↩️  已接续最近会话 ${s.id}`);
} else {
  session = createSession();
}

// —— 一次性模式：没强制 --ui 且命令行给了问题 → 跑一次就退出（控制台输出）——
if (!forceUi && oneShot) {
  await runAgent(session, oneShot); // 默认 console emitter
  process.exit(0);
}

if (process.stdin.isTTY) {
  // —— 交互模式：Ink 终端 UI（独占全屏，输入框钉在最底部）——
  await renderUI(session);
  console.log("👋 再见。");
} else {
  // —— 非 TTY（管道/重定向）：Ink 需要真实终端，这里退回简单逐行循环 ——
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  for await (const line of rl) {
    const text = line.trim();
    if (text === "/exit" || text === "/quit") break;
    if (!text) continue;
    if (text === "/help") {
      console.log(HELP + "\n");
      continue;
    }
    try {
      await runAgent(session, text); // 默认 console emitter
    } catch (err) {
      console.error(
        `\n❌ 出错: ${err instanceof Error ? err.message : String(err)}\n`
      );
    }
    console.log();
  }
  rl.close();
  console.log("\n👋 再见。");
}
