import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { createSession, runAgent } from "./agent.js";
import { renderUI, HELP } from "./ui.js";

// 一个会话 = 一份持久的 messages 历史 + 一个会话级日志文件。
const session = createSession();

// 参数解析：--ui 强制进入交互界面（即使后面还跟了问题，UI 优先）。
const argv = process.argv.slice(2);
const forceUi = argv.includes("--ui");
const oneShot = argv.filter((a) => a !== "--ui").join(" ").trim();

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
