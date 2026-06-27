import "dotenv/config";
import { runAgent } from "./agent.js";

// 命令行可传入问题：npm run dev -- "帮我算 (12+7)*3"
// 不传则用默认示例（一个需要工具、且不止一步的问题）。
const userInput =
  process.argv.slice(2).join(" ").trim() ||
  "先算 (12 + 7) * 3，再把结果加上 2 的 10 次方，告诉我最终是多少。";

console.log(`\n💬 用户输入: ${userInput}`);

// 注意：最终答案现在是「流式」边生成边打印的（见 agent.ts 的 🤖 输出），
// 所以这里不再整段重复，只给个完成标记；完整记录在 logs/last.log。
await runAgent(userInput);

console.log(`\n✅ 完成。完整 prompt/响应见 logs/last.log\n`);
