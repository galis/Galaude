// 引擎接缝：UI / 入口只 import 这里的 runAgent，底下跑哪个引擎由 config.engine 决定
//（env: ENGINE=langgraph 切换）。两个引擎同签名、同事件协议（AgentEvent）、同会话
// 存档格式——这正是 Phase 3「对照手写逻辑」的支点：同一个界面，两套实现可逐项对比。
import { config } from "./config.js";
import {
  runAgent as runHandwritten,
  type Session,
  type Emitter,
  type ToolApprover,
} from "./agent.js";

export async function runAgent(
  session: Session,
  userInput: string,
  emit?: Emitter,
  signal?: AbortSignal,
  approve?: ToolApprover
): Promise<string> {
  if (config.engine === "langgraph") {
    // 惰性加载：手写引擎不用背 LangChain 全家桶的启动开销
    const { runAgentLG } = await import("./lgraph/engine.js");
    return runAgentLG(session, userInput, emit, signal, approve);
  }
  // 注意透传 undefined 而不是自己填默认值：手写引擎靠「approve === autoApprove
  //（默认参数）」判断是否无人值守，替它包一层会破坏这个身份判断。
  return runHandwritten(session, userInput, emit, signal, approve);
}
