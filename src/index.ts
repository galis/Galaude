import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { createSession, runAgent, SYSTEM_PROMPT } from "./agent.js";

const HELP = `可用命令：
  /exit, /quit   退出
  /clear         清空上下文（开新对话，沿用同一日志文件）
  /history       打印当前历史的 role 时间线
  /help          显示本帮助`;

// 一个会话 = 一份持久的 messages 历史 + 一个会话级日志文件。
const session = createSession();

// —— 一次性模式：命令行直接给了问题，就跑一次然后退出（保留老用法）——
const oneShot = process.argv.slice(2).join(" ").trim();
if (oneShot) {
  await runAgent(session, oneShot);
  process.exit(0);
}

// —— 交互模式：终端多轮对话 ——
console.log("🌀 Galaude 对话 —— 输入问题开始；/help 看命令，/exit 退出");
console.log(`📝 本次会话日志: ${session.logger.path}\n`);

const rl = createInterface({ input: process.stdin, output: process.stdout });
rl.on("SIGINT", () => rl.close()); // Ctrl+C 优雅退出

const PROMPT = "💬 \x1b[36m>\x1b[0m "; // 青色提示符
rl.setPrompt(PROMPT);
rl.prompt();

// for await…of rl 带背压：处理完一行才读下一行，管道/TTY 都正确。
for await (const line of rl) {
  const input = line.trim();

  if (input === "/exit" || input === "/quit") break;

  if (!input) {
    // 空行：什么都不做，重新给提示符
  } else if (input === "/help") {
    console.log(HELP + "\n");
  } else if (input === "/clear") {
    // 重置历史到只剩 system，开始一段新对话
    session.messages.length = 0;
    session.messages.push({ role: "system", content: SYSTEM_PROMPT });
    console.log("🧹 已清空上下文。\n");
  } else if (input === "/history") {
    const tl = session.messages.map((m) => m.role).join(" → ");
    console.log(`🧠 历史（${session.messages.length} 条）: ${tl}\n`);
  } else {
    // 普通输入：跑一轮 agent。出错不退出，提示后继续对话。
    try {
      await runAgent(session, input);
    } catch (err) {
      console.error(
        `\n❌ 出错: ${err instanceof Error ? err.message : String(err)}\n`
      );
    }
    console.log(); // 答案后空一行
  }

  rl.prompt(); // 下一个提示符
}

rl.close();
console.log("\n👋 再见。");
