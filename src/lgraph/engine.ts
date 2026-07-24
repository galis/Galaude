// LangGraph 引擎的对外入口：runAgentLG —— 与手写引擎 runAgent 完全同签名，
// ui.tsx / index.ts 经 src/engine.ts 的接缝无感切换（ENGINE=langgraph）。
//
// 持久化设计（刻意与「教科书做法」不同，见 docs/langgraph-vs-handwritten.md）：
// 两个引擎共享 sessions/<id>.json 这【一个】真相源。LangGraph 的 checkpointer 用
// 进程内 MemorySaver：线程只是真相源的运行时视图——首次用到某会话时从 JSON 播种，
// 每轮结束把图状态镜像回 session 并落盘。若再挂一个 sqlite 持久 checkpointer，
// 等于给同一份对话立两个真相源，两个引擎交替使用时必然分叉。
import { Command, type StateSnapshot } from "@langchain/langgraph";
import { HumanMessage, ToolMessage } from "@langchain/core/messages";
import { config } from "../config.js";
import { makeConsoleEmitter, type Emitter, type ToolApprover, type ApprovalRequest } from "../events.js";
import { persist, type Session } from "../session.js";
import { getGraph, setTraceLogger, type GState } from "./graph.js";
import {
  toLC,
  fromLC,
  lcText,
  danglingToolCalls,
  INTERRUPTED_TOOL_RESULT,
} from "./messages.js";
import { isAIMessage, type BaseMessage } from "@langchain/core/messages";

const CAP_ANSWER = () =>
  `已达到最大轮数上限（${config.maxTurns}），未得到最终答案。`;

/** 图状态 → 会话镜像（原地写，保持对象引用，UI 才能继续用同一个 session）。 */
function syncSession(session: Session, values: GState): void {
  const mirrored = fromLC(values.messages);
  // 悬挂修补（镜像侧）：确认框挂着时被中断，最后是一条带 tool_calls 的 assistant。
  // 镜像里补占位结果，这样【手写引擎】接手这份存档时也不会因配对不完整被 API 拒。
  for (const tc of danglingToolCalls(values.messages))
    mirrored.push({ role: "tool", tool_call_id: tc.id, content: INTERRUPTED_TOOL_RESULT });
  session.messages.length = 0;
  session.messages.push(...mirrored);
  session.lastPromptTokens = values.lastPromptTokens;
  session.summaries = values.summaries;
  session.summarizedUpTo = values.summarizedUpTo;
  session.memory = values.memory;
  session.plan.todos = values.plan.todos;
  session.plan.nextId = values.plan.nextId;
}

/**
 * 处理「一次用户输入」（LangGraph 版）。流程：
 *   播种/修补线程 → graph.stream 循环（interrupt → 现有确认门 approve → resume）
 *   → 终态镜像回 session 并落盘 → 返回最终答案。
 */
export async function runAgentLG(
  session: Session,
  userInput: string,
  emit: Emitter = makeConsoleEmitter(),
  signal?: AbortSignal,
  approve?: ToolApprover
): Promise<string> {
  const graph = getGraph();
  const cfg = {
    configurable: {
      thread_id: session.id,
      emit,
      logger: session.logger,
      interactive: !!approve,
      __signal: signal, // 节点内模型调用取用（config.signal 是否透传进节点因版本而异，自带一份稳妥）
    },
    signal,
    // recursionLimit 数的是 super-step（一轮 ≈ agent+judge+approve+tools 4 步），
    // 真正的轮数出口在 routeAfterTools；这里只是防御性兜底。
    recursionLimit: config.maxTurns * 4 + 8,
  };

  session.round++;
  session.logger.section(
    `========== 用户输入 #${session.round}（langgraph 引擎） ==========`
  );
  session.logger.log(userInput);
  if (config.traceStream) setTraceLogger(session.logger); // 协议研究：原始 SSE 落进本会话日志

  // —— 播种：本进程首次用到这个会话 → 把 JSON 真相源灌进线程。
  //（MemorySaver 进程内有效：重启后线程为空，从最新镜像重新播种，天然衔接。）
  const snap = await graph.getState(cfg);
  const threadMsgs = (snap.values as Partial<GState>).messages ?? [];
  const seeding = threadMsgs.length === 0;

  // —— 悬挂修补（线程侧）：上次确认框挂着被中断，线程尾部残留未答复的 tool_calls。
  if (!seeding) {
    const dangling = danglingToolCalls(threadMsgs);
    if (dangling.length) {
      await graph.updateState(cfg, {
        messages: dangling.map(
          (tc) =>
            new ToolMessage({ content: INTERRUPTED_TOOL_RESULT, tool_call_id: tc.id })
        ),
      });
      emit({
        type: "debug",
        text: `🩹 修补了 ${dangling.length} 个上次中断残留的未答复 tool_call`,
      });
    }
  }

  const seedMsgs: BaseMessage[] = seeding ? toLC(session.messages) : [];
  let input: Parameters<typeof graph.stream>[0] = {
    messages: [...seedMsgs, new HumanMessage(userInput)],
    turn: 0, // 每次用户输入把轮数归零（think→act 轮上限是「单次输入内」的）
    ...(seeding
      ? {
          summaries: session.summaries,
          summarizedUpTo: session.summarizedUpTo,
          memory: session.memory,
          plan: session.plan,
          lastPromptTokens: session.lastPromptTokens,
        }
      : {}),
  };

  // 与手写引擎同语义：先把用户这轮记进镜像并落盘（中途被打断也不丢这句话）。
  session.messages.push({ role: "user", content: userInput });
  persist(session);

  try {
    // —— 主循环：跑到 interrupt 就把确认请求接回 UI 的确认门，拿到 y/n 再 resume。
    // 一次 resume 只回答一个确认（approve 节点重放时已答的走缓存、下一个再挂起），
    // 所以这个 while 正好实现了手写引擎「审批串行」的语义。
    while (true) {
      const stream = await graph.stream(input, { ...cfg, streamMode: "updates" });
      let pending: ApprovalRequest | null = null;
      for await (const chunk of stream) {
        const intr = (chunk as Record<string, unknown>).__interrupt__ as
          | { value?: unknown }[]
          | undefined;
        if (intr?.[0]) pending = intr[0].value as ApprovalRequest;
      }
      if (!pending) break;
      const ok = approve ? await approve(pending) : true;
      // 包成对象再 resume：Command({resume: false}) 会被 LangGraph 的
      // 空值检查误判为「空 Command 输入」直接抛错（v1.4.7 实测）。
      input = new Command({ resume: { ok } });
    }
  } finally {
    // 无论正常结束还是被 Ctrl+C 打断：把已推进到的图状态镜像回 session 并落盘
    //（checkpointer 以 super-step 为粒度，比手写引擎的每轮落盘还细一档）。
    try {
      const end = await graph.getState(cfg);
      if ((end.values as Partial<GState>).messages?.length) {
        syncSession(session, end.values as GState);
        persist(session);
      }
    } catch {
      /* 同步失败不掩盖原始错误 */
    }
  }

  const end: StateSnapshot = await graph.getState(cfg);
  const msgs = (end.values as GState).messages;
  const last = msgs[msgs.length - 1];
  const answer =
    last && isAIMessage(last) && !(last.tool_calls?.length ?? 0)
      ? lcText(last) || "(模型没有返回文本内容)"
      : CAP_ANSWER(); // 尾巴不是纯文本回答 → 是 routeAfterTools 在轮数上限出的口

  emit({
    type: "debug",
    text: `🏁 退出循环（最终历史 ${msgs.length} 条，langgraph）`,
  });
  session.logger.section("最终答案");
  session.logger.log(answer);
  return answer;
}
