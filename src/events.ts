import { config } from "./config.js";
import type { Todo } from "./todo.js";

const DEBUG = config.debug;

/**
 * agent 把「该显示给用户的东西」抽象成事件，由外层（控制台 or Ink UI）决定怎么渲染。
 * 这样 agent 核心不直接写屏，Ink 接管屏幕时才不会被 console.log 冲乱。
 * 文件日志（logger）与此独立，照常写。
 */
export type AgentEvent =
  | { type: "reasoning"; text: string } // 思维链增量
  | { type: "assistant"; text: string } // 回答正文增量
  | { type: "tool_call"; name: string; argsText: string }
  | { type: "tool_result"; name: string; result: string }
  | { type: "usage"; promptTokens: number; completionTokens: number; cacheHitTokens?: number; cacheMissTokens?: number; timestamp?: string } // 本轮模型实际看到的 prompt token（=投影大小）与输出 token，及缓存命中/未命中细分；timestamp 用于高峰/非高峰计费
  | { type: "note"; text: string } // 系统提示（如「已折叠」），界面当一条 note 显示
  | { type: "todos"; todos: Todo[] } // 任务清单变更，界面据此刷新面板
  | { type: "debug"; text: string };
export type Emitter = (ev: AgentEvent) => void;

// 工具确认门（human-in-the-loop）：危险工具执行前问用户要不要跑。
// 返回 true 执行、false 拒绝。默认放行（一次性/管道模式无人值守）。
export type ApprovalRequest = {
  name: string;
  argsText: string;
  preview: string; // 给用户看的可读预览（命令 / diff）
};
export type ToolApprover = (req: ApprovalRequest) => Promise<boolean>;

// 确认门模式（进程级运行时设置，默认取 config，可用 /mode 切换）。
export type ApprovalMode = "auto" | "strict";
let approvalMode: ApprovalMode = config.approvalMode;
export const getApprovalMode = (): ApprovalMode => approvalMode;
export const setApprovalMode = (m: ApprovalMode): void => {
  approvalMode = m;
};

/** 默认事件渲染：写到控制台（一次性 / 管道模式用），尽量还原老输出。 */
export function makeConsoleEmitter(): Emitter {
  let answerStarted = false;
  return (ev) => {
    switch (ev.type) {
      case "reasoning":
        if (DEBUG) process.stdout.write(ev.text);
        break;
      case "assistant":
        if (!answerStarted)
          (process.stdout.write("\n🤖 "), (answerStarted = true));
        process.stdout.write(ev.text);
        break;
      case "tool_call":
        answerStarted = false;
        console.log(`\n🔧 模型请求工具: ${ev.name}(${ev.argsText})`);
        break;
      case "tool_result":
        console.log(`   ↳ 结果: ${ev.result}`);
        break;
      case "usage":
        break; // 控制台模式不显示 ctx 占比
      case "note":
        console.log(ev.text);
        break;
      case "debug":
        if (DEBUG) console.log(ev.text);
        break;
    }
  };
}
