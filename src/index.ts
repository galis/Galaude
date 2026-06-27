import "dotenv/config";
import { runAgent } from "./agent.js";

// 命令行可传入问题：npm run dev -- "帮我算 (12+7)*3"
// 不传则用默认示例（一个需要工具、且不止一步的问题）。
const userInput =
  process.argv.slice(2).join(" ").trim() ||
  "先算 (12 + 7) * 3，再把结果加上 2 的 10 次方，告诉我最终是多少。";

console.log(`\n💬 用户输入: ${userInput}`);

const answer = await runAgent(userInput);

console.log(`\n✅ 最终答案:\n${answer}\n`);
