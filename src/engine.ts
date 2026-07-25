// 引擎接缝：UI / 入口只 import 这里的 runAgent，底下跑哪个引擎由 config.engine 决定
//（env: ENGINE=langgraph 切换）。两个引擎同签名、同事件协议（AgentEvent）、同会话
// 存档格式——这正是 Phase 3「对照手写逻辑」的支点：同一个界面，两套实现可逐项对比。
import { config } from "./config.js";
import { runAgent as runHandwritten } from "./agent.js";
import { type Session } from "./session.js";
import { type Emitter, type ToolApprover } from "./events.js";

// 启动时立刻触发 LangGraph 的后台预加载（不阻塞 UI 渲染）。
// 首次请求只需 await 这个 promise，而不是现场 import 全家桶。
let _lgReady: Promise<typeof import("./lgraph/engine.js")> | undefined;
if (config.engine === "langgraph") {
  _lgReady = import("./lgraph/engine.js");
}

export async function runAgent(
  session: Session,
  userInput: string,
  emit?: Emitter,
  signal?: AbortSignal,
  approve?: ToolApprover
): Promise<string> {
  if (config.engine === "langgraph") {
    const { runAgentLG } = await _lgReady!;
    return runAgentLG(session, userInput, emit, signal, approve);
  }
  // 注意透传 undefined 而不是自己填默认值：手写引擎靠「approve === autoApprove
  //（默认参数）」判断是否无人值守，替它包一层会破坏这个身份判断。
  return runHandwritten(session, userInput, emit, signal, approve);
}
