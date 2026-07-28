// LangGraph 引擎的对外入口：runAgentLG —— ui.tsx / index.ts 经 src/engine.ts 调用。
//
// 注：本目录的注释里多处写「与手写引擎一致 / 逐块对应」。那个手写循环（src/agent.ts）
// 曾是本项目的对照基线，现已删除，只留设计对照笔记 docs/langgraph-vs-handwritten.md。
// 这些注释保留下来是因为它们记录了「为什么这么设计」，不是说还有第二个引擎可切。
//
// 持久化设计（刻意与「教科书做法」不同，见 docs/langgraph-vs-handwritten.md）：
//
// sessions/<id>.json 是【唯一】真相源，而且是【只增】的。图不持有跨轮的对话状态——
// 每次运行都把完整对话当【入参】传进去，跑完只把新产生的消息【追加】回真相源。
// thread_id 带上轮次，所以一个线程 = 一次运行的作用域，不跨轮。
//
// checkpointer（进程内 MemorySaver）因此只剩它本来该干的那件事：一次运行【内部】的
// 挂起/恢复，也就是确认门的 interrupt。它不再兼职「跨轮记着对话」。
//
// 为什么不让它兼职：那等于给同一份对话立两个权威，还互相覆盖。实测踩过——getState()
// 报告线程有 5 条、stream() 却从空状态起跑，跑完拿 2 条整份覆盖掉 6 条历史，那一轮
// 的问答直接从存档里消失。危险不来自「持久化」，来自双向同步 + 整份覆盖；哪怕
// checkpointer 只在内存里，一样会咬人。现在这条路径在结构上不存在了。
import { Command } from "@langchain/langgraph";
import { HumanMessage, ToolMessage } from "@langchain/core/messages";
import { config } from "../config.js";
import { makeConsoleEmitter, SUBAGENT_STATUS_LABEL, type Emitter, type ToolApprover, type ApprovalRequest } from "../events.js";
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
import { subagentRuntime, formatTaskNotification } from "../subagent.js";

const CAP_ANSWER = () =>
  `已达到最大轮数上限（${config.maxTurns}），未得到最终答案。`;

// 进程内自增，给每次运行发一个独一无二的 thread_id。
//
// 不要用 session.id 拼：newSessionId() 是秒级时间戳，同一秒里建的两个会话 id 相同，
// 线程也就撞上了——后建的那次运行会接着前一个会话的线程跑，把别人的历史当成自己的
// 新产出追加进来。线程既然只是「一次运行的作用域」，就不该跟会话身份有任何关系。
let _runSeq = 0;

/**
 * 图状态 → 会话（原地写，保持对象引用，UI 才能继续用同一个 session）。
 *
 * 【只追加，绝不覆盖】。baseLen 是本次运行传进图的消息条数，图只会往后 append
 * （只有 agent/tools 两个节点动 messages，compact 只动摘要通道），所以 baseLen
 * 之后的就是这一轮新产生的。
 *
 * 这样即使图状态出任何偏差，最坏也只是这一轮没东西可追加，历史一条都少不了——
 * 之前那种「拿 2 条覆盖 6 条」的事在结构上就不可能发生。
 */
function syncSession(session: Session, values: GState, baseLen: number): void {
  const produced = values.messages.slice(baseLen);
  const appended = fromLC(produced);
  // 悬挂修补：确认框挂着时被中断，最后是一条带 tool_calls 的 assistant。
  // 补占位结果，否则这份存档下次再喂给 API 会因 tool_call 配对不完整被拒。
  for (const tc of danglingToolCalls(values.messages))
    appended.push({ role: "tool", tool_call_id: tc.id, content: INTERRUPTED_TOOL_RESULT });
  session.messages.push(...appended);

  // 派生状态（不是历史，整值同步没有「丢」的风险）
  session.lastPromptTokens = values.lastPromptTokens;
  session.summaries = values.summaries;
  session.summarizedUpTo = values.summarizedUpTo;
  session.memory = values.memory;
  session.plan.todos = values.plan.todos;
  session.plan.nextId = values.plan.nextId;
}

/**
 * 处理「一次用户输入」（LangGraph 版）。流程：
 *   完整对话作为入参 → graph.stream 循环（interrupt → 现有确认门 approve → resume）
 *   → 把新产生的消息追加回 session 并落盘 → 返回最终答案。
 */
export async function runAgentLG(
  session: Session,
  userInput: string,
  emit: Emitter = makeConsoleEmitter(),
  signal?: AbortSignal,
  approve?: ToolApprover
): Promise<string> {
  const graph = getGraph();

  session.round++;
  session.logger.section(
    `========== 用户输入 #${session.round}（langgraph 引擎） ==========`
  );
  session.logger.log(userInput);
  if (config.traceStream) setTraceLogger(session.logger); // 协议研究：原始 SSE 落进本会话日志

  // 一个线程 = 一次运行的作用域。每次运行都是全新线程，checkpointer 只服务
  // 这一次运行内部的 interrupt/resume（确认门），不跨轮记任何东西。
  const cfg = {
    configurable: {
      thread_id: `${session.id}#run${++_runSeq}`,
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

  // 轮边界：取出已完成的子Agent 通知。必须在拼 input 之前取——通知要跟用户输入一样
  // 作为这一轮的入参进图，而不只是记进 session（那样模型根本看不到它）。
  subagentRuntime.bindSession(session.id);
  const notifications = subagentRuntime.pollResults().map((r) => {
    const text = formatTaskNotification(r);
    session.logger.section(`子Agent 通知: ${r.agentId} (${r.status})`);
    session.logger.log(text);
    emit({ type: "note", text: `📬 子Agent "${r.description}" ${SUBAGENT_STATUS_LABEL[r.status]}` });
    return text;
  });

  // 入参 = 真相源里已有的完整对话 + 这一轮的新输入。
  const convo: BaseMessage[] = toLC(session.messages);
  // 悬挂修补：上次跑到一半被中断，真相源尾部可能残留没答复的 tool_calls，
  // 直接喂给 API 会因配对不完整被拒。这里补占位结果（同时补进真相源，一次修干净）。
  const dangling = danglingToolCalls(convo);
  if (dangling.length) {
    for (const tc of dangling) {
      convo.push(new ToolMessage({ content: INTERRUPTED_TOOL_RESULT, tool_call_id: tc.id }));
      session.messages.push({ role: "tool", tool_call_id: tc.id, content: INTERRUPTED_TOOL_RESULT });
    }
    emit({ type: "debug", text: `🩹 修补了 ${dangling.length} 个上次中断残留的未答复 tool_call` });
  }

  const inputMessages: BaseMessage[] = [
    ...convo,
    new HumanMessage(userInput),
    ...notifications.map((t) => new HumanMessage(t)),
  ];
  // 图跑完后，messages 的前 baseLen 条就是这里传进去的，之后的才是本轮新产出。
  const baseLen = inputMessages.length;

  let input: Parameters<typeof graph.stream>[0] = {
    messages: inputMessages,
    turn: 0, // 每次用户输入把轮数归零（think→act 轮上限是「单次输入内」的）
    // 线程每轮全新，压缩/记忆这些派生通道也就每轮都要给
    summaries: session.summaries,
    summarizedUpTo: session.summarizedUpTo,
    memory: session.memory,
    plan: session.plan,
    lastPromptTokens: session.lastPromptTokens,
  };

  // 先把这一轮的输入记进真相源并落盘（中途被打断也不丢）。顺序与 inputMessages 一致。
  session.messages.push({ role: "user", content: userInput });
  for (const t of notifications) session.messages.push({ role: "user", content: t });
  persist(session);

  // 本次运行自己产出的终态。
  //
  // 为什么不在跑完之后 graph.getState() 再读一遍：实测出现过「stream 从空状态起跑、
  // 跑完 getState 却返回上一轮的旧状态」——两者对不上。后果是这一轮的回答被丢弃、
  // 返回上一轮的旧答案（UI 上表现为同一段话打印两遍），镜像回写也把这一轮整个吞掉、
  // 存档里根本没有这轮对话。所以改成只认这次 stream 自己吐出来的 values：
  // 「我刚产出了什么」必须来自本次运行，不能靠事后去外部再查一次。
  let finalValues: GState | null = null;

  try {
    // —— 主循环：跑到 interrupt 就把确认请求接回 UI 的确认门，拿到 y/n 再 resume。
    // 一次 resume 只回答一个确认（approve 节点重放时已答的走缓存、下一个再挂起），
    // 所以这个 while 正好实现了「审批串行」的语义。
    while (true) {
      // values：每个 super-step 后的整份状态（拿终态用）
      // updates：节点增量，interrupt 从这里冒出来
      const stream = await graph.stream(input, {
        ...cfg,
        streamMode: ["values", "updates"],
      });
      let pending: ApprovalRequest | null = null;
      for await (const part of stream) {
        // 多 streamMode 时 chunk 是 [mode, payload] 元组；单模式时是裸 payload。
        // 两种形状都兜住，免得日后调整 streamMode 时这里静默失灵。
        const [mode, payload] = Array.isArray(part)
          ? (part as [string, unknown])
          : ["updates", part as unknown];
        if (mode === "values") {
          finalValues = payload as GState;
          continue;
        }
        const intr = (payload as Record<string, unknown>).__interrupt__ as
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
    // 无论正常结束还是被 Ctrl+C 打断：把本轮【新产生】的消息追加回真相源并落盘。
    // 被打断时 finalValues 是中断前最后一个 super-step 的状态，正是我们要保的。
    //
    // 这里不再需要「图状态比历史短就跳过」那道护栏了：追加的是 slice(baseLen)，
    // 图状态再怎么异常，最坏也只是切出空数组、这轮没东西可追加，历史一条都少不了。
    try {
      if (finalValues?.messages?.length) {
        syncSession(session, finalValues, baseLen);
        persist(session);
      }
    } catch {
      /* 同步失败不掩盖原始错误 */
    }
  }

  const msgs = finalValues?.messages ?? [];
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
