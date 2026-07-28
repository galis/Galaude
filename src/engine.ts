// 引擎入口：UI / index 只 import 这里的 runAgent。
//
// 这一层现在只剩一个职责——把 LangGraph 全家桶的加载挪到后台。直接在 ui.tsx 里
// import src/lgraph/ 会让首屏渲染等在那堆依赖上；这里在模块加载时就把 import()
// 发出去，首次请求只 await 这个早已在跑的 promise。
//
// （曾经这里还负责在「手写引擎」和 LangGraph 之间按 ENGINE 分派，手写引擎已移除，
//   对照笔记留在 docs/langgraph-vs-handwritten.md。）
import { type Session } from "./session.js";
import { type Emitter, type ToolApprover } from "./events.js";

const _lgReady = import("./lgraph/engine.js");

export async function runAgent(
  session: Session,
  userInput: string,
  emit?: Emitter,
  signal?: AbortSignal,
  approve?: ToolApprover
): Promise<string> {
  const { runAgentLG } = await _lgReady;
  // 注意透传 undefined 而不是自己填默认值：引擎靠「approve === autoApprove
  //（默认参数）」判断是否无人值守，替它包一层会破坏这个身份判断。
  return runAgentLG(session, userInput, emit, signal, approve);
}
