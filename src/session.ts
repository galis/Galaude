import type OpenAI from "openai";
import { SYSTEM_PROMPT } from "./system-prompt.js";
import { createRunLogger, type RunLogger } from "./logger.js";
import { newSessionId, saveSession, type StoredSession } from "./store.js";
import { emptyPlan, type TodoPlan } from "./todo.js";
import { ensureUserSkills } from "./skill.js";
import { toolSchemas } from "./tools.js";
import type { SummarySegment } from "./compress.js";

type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/** 一次对话会话：跨多轮用户输入持久保存历史与日志。 */
export interface Session {
  id: string; // 会话 id，对应 sessions/<id>.json
  createdAt: string;
  messages: Message[];
  logger: RunLogger;
  round: number; // 第几次「用户输入」（区别于内部 think-act 轮）
  lastPromptTokens: number; // 上轮模型实际看到的 prompt token（投影大小），驱动压缩触发
  // —— 累积 token / 费用统计（持久化，跨恢复保留）——
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  totalCost: number;
  requestCount: number;
  // —— 压缩状态（投影用，messages 始终完整不动）——
  summaries: SummarySegment[]; // 旧段摘要，append-only
  summarizedUpTo: number; // messages[1..k] 已被 summaries 覆盖
  memory: string[]; // 会话级外置关键事实（P3 自动抽取），豁免压缩
  globalMemory?: string[]; // 全局记忆（~/.galaude/memory.json），每轮注入前读取
  projectMemory?: string[]; // 项目记忆（.galaude/project-memory.json），每轮注入前读取
  plan: TodoPlan; // 任务清单（模型驱动，每轮回注上下文）
}

/** 新建一个会话：装好 system 提示 + 一个会话级日志文件。 */
export function createSession(): Session {
  const logger = createRunLogger();
  logger.section("工具定义 toolSchemas（随每轮一起发给模型）");
  logger.log(JSON.stringify(toolSchemas, null, 2));
  const messages: Message[] = [{ role: "system", content: SYSTEM_PROMPT }];
  // 首次启动：内置 skill 复制到用户目录（幂等，已有则跳过）
  try { ensureUserSkills(); } catch { /* 非致命 */ }
  return {
    id: newSessionId(),
    createdAt: new Date().toISOString(),
    messages,
    logger,
    round: 0,
    lastPromptTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    totalCost: 0,
    requestCount: 0,
    summaries: [],
    summarizedUpTo: 0,
    memory: [],
    plan: emptyPlan(),
  };
}

/**
 * 把 source 会话的【全部】字段装进 target（原地、保持对象引用不变）。
 * UI 层的 /new、/clear、切换会话都必须走这里——曾经三处各自手抄字段列表，
 * 结果压缩状态（summaries/summarizedUpTo/memory）被漏掉：旧会话的摘要挂到
 * 新会话上、水位线越界切空近段、还会把旧摘要持久化进新会话存档。
 */
export function adoptSession(target: Session, source: Session): void {
  target.id = source.id;
  target.createdAt = source.createdAt;
  target.logger = source.logger;
  target.round = source.round;
  target.lastPromptTokens = source.lastPromptTokens;
  target.inputTokens = source.inputTokens;
  target.outputTokens = source.outputTokens;
  target.cacheHitTokens = source.cacheHitTokens;
  target.cacheMissTokens = source.cacheMissTokens;
  target.totalCost = source.totalCost;
  target.requestCount = source.requestCount;
  target.messages.length = 0;
  target.messages.push(...source.messages);
  target.summaries = source.summaries;
  target.summarizedUpTo = source.summarizedUpTo;
  target.memory = source.memory;
  target.projectMemory = source.projectMemory;
  target.plan = source.plan;
}

/** 从存盘记录恢复一个会话：沿用其 id 与历史，重开一份运行日志。 */
export function resumeSession(stored: StoredSession): Session {
  const logger = createRunLogger();
  logger.section(`恢复会话 ${stored.id}（${stored.messages.length} 条历史）`);
  return {
    id: stored.id,
    createdAt: stored.createdAt,
    messages: stored.messages,
    logger,
    round: stored.messages.filter((m) => m.role === "user").length,
    // 恢复时带上 ctx 大小：这样恢复后第一轮就知道要不要裁，不会先发一坨超大上下文
    lastPromptTokens: stored.lastPromptTokens ?? 0,
    // 累积统计恢复（旧存档没有这些字段 → 默认 0）
    inputTokens: stored.inputTokens ?? 0,
    outputTokens: stored.outputTokens ?? 0,
    cacheHitTokens: stored.cacheHitTokens ?? 0,
    cacheMissTokens: stored.cacheMissTokens ?? 0,
    totalCost: stored.totalCost ?? 0,
    requestCount: stored.requestCount ?? 0,
    // 压缩状态直接读回（零重放）：摘要/水位线/记忆都是固化好的
    summaries: stored.summaries ?? [],
    summarizedUpTo: stored.summarizedUpTo ?? 0,
    memory: stored.memory ?? [],
    plan: stored.plan ?? emptyPlan(),
  };
}

/** 把会话当前状态写盘（sessions/<id>.json），每轮结束自动调用。 */
export function persist(session: Session): void {
  const firstUser = session.messages.find((m) => m.role === "user");
  if (!firstUser) return; // 空会话（还没说过话）不必存盘
  const title =
    typeof firstUser.content === "string" ? firstUser.content.slice(0, 50) : "(无标题)";
  saveSession({
    id: session.id,
    createdAt: session.createdAt,
    updatedAt: new Date().toISOString(),
    title,
    messages: session.messages,
    lastPromptTokens: session.lastPromptTokens,
    inputTokens: session.inputTokens,
    outputTokens: session.outputTokens,
    cacheHitTokens: session.cacheHitTokens,
    cacheMissTokens: session.cacheMissTokens,
    totalCost: session.totalCost,
    requestCount: session.requestCount,
    summaries: session.summaries,
    summarizedUpTo: session.summarizedUpTo,
    memory: session.memory,
    plan: session.plan,
  });
}
