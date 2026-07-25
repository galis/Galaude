import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type OpenAI from "openai";
import type { SummarySegment } from "./compress.js";
import type { TodoPlan } from "./todo.js";

type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;

// 会话存盘目录（与 logs 同级，放在运行目录下）。
const DIR = join(process.cwd(), "sessions");
// 轻量索引：只存每个会话的元信息。列表/前缀匹配/取最新都查它，
// 不必把所有会话的完整 messages JSON 全部读进来（会话多了以后那样很慢）。
const INDEX = join(DIR, "index.json");

/** 会话元信息（索引里的一条；/sessions、选择器只需要这些）。 */
export interface SessionMeta {
  id: string;
  createdAt: string;
  updatedAt: string;
  title: string; // 取首条用户消息，方便 /sessions 里辨认
}

/** 落盘的会话结构。messages 就是喂给模型的完整历史，可直接恢复继续聊。 */
export interface StoredSession extends SessionMeta {
  messages: Message[];
  lastPromptTokens?: number; // 上轮投影大小；恢复后据此立刻判断是否要裁
  // —— 累积 token / 费用统计（所有字段可选，兼容旧存档）——
  inputTokens?: number;
  outputTokens?: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
  totalCost?: number;
  requestCount?: number;
  // —— 压缩状态（贵的产物缓存进 JSON → 恢复零重放）——
  summaries?: SummarySegment[];
  summarizedUpTo?: number;
  memory?: string[];
  // —— 任务清单（模型驱动，恢复零重放）——
  plan?: TodoPlan;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** 生成会话 id：YYYYMMDD-HHmmss（够唯一、也方便 --resume 输入前缀）。 */
export function newSessionId(): string {
  const d = new Date();
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

const fileOf = (id: string) => join(DIR, `${id}.json`);

const metaOf = (s: StoredSession): SessionMeta => ({
  id: s.id,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
  title: s.title,
});

// 同目录 tmp+rename 原子写（会话文件和索引共用）：崩溃/断电时要么旧档完好、
// 要么新档完整，杜绝半截坏 JSON。残留 .tmp 无害，下次写覆盖。
function atomicWrite(target: string, data: string): void {
  mkdirSync(DIR, { recursive: true });
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, target);
}

/** 扫一遍目录重建索引（索引缺失/损坏时的兜底；老仓库首次升级也走这里）。 */
function rebuildIndex(): SessionMeta[] {
  let files: string[];
  try {
    files = readdirSync(DIR).filter(
      (f) => f.endsWith(".json") && f !== "index.json"
    );
  } catch {
    return [];
  }
  const metas: SessionMeta[] = [];
  for (const f of files) {
    try {
      metas.push(metaOf(JSON.parse(readFileSync(join(DIR, f), "utf8"))));
    } catch {
      /* 跳过坏文件 */
    }
  }
  metas.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  atomicWrite(INDEX, JSON.stringify(metas, null, 2));
  return metas;
}

function readIndex(): SessionMeta[] {
  try {
    const arr = JSON.parse(readFileSync(INDEX, "utf8")) as SessionMeta[];
    if (Array.isArray(arr)) return arr;
  } catch {
    /* 缺失或损坏 → 重建 */
  }
  return rebuildIndex();
}

export function saveSession(s: StoredSession): void {
  atomicWrite(fileOf(s.id), JSON.stringify(s, null, 2));
  // 更新索引里这条的元信息，保持按 updatedAt 倒序。
  const metas = [metaOf(s), ...readIndex().filter((m) => m.id !== s.id)];
  metas.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  atomicWrite(INDEX, JSON.stringify(metas, null, 2));
}

/** 列出所有会话的元信息，按 updatedAt 倒序（最近的在前）。只读索引，很快。 */
export function listSessions(): SessionMeta[] {
  return readIndex();
}

/** 按 id 精确或「前缀」加载一个会话（方便只敲前几位）。id 走索引找，只读一个文件。 */
export function loadSession(idOrPrefix: string): StoredSession | null {
  const metas = readIndex();
  const meta =
    metas.find((m) => m.id === idOrPrefix) ??
    metas.find((m) => m.id.startsWith(idOrPrefix));
  if (!meta) return null;
  try {
    return JSON.parse(readFileSync(fileOf(meta.id), "utf8")) as StoredSession;
  } catch {
    return null; // 索引里有但文件坏了/被删了
  }
}

export function latestSession(): StoredSession | null {
  const m = readIndex()[0];
  return m ? loadSession(m.id) : null;
}

// —— 全局长期记忆（~/.galaude/memory.json），跨会话共享 ——

const GLOBAL_DIR = join(homedir(), ".galaude");
const GLOBAL_MEMORY = join(GLOBAL_DIR, "memory.json");

function atomicWriteGlobal(target: string, data: string): void {
  mkdirSync(GLOBAL_DIR, { recursive: true });
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, target);
}

/** 加载全局长期记忆（跨会话共享的用户偏好、项目约定等）。文件不存在返回 []。 */
export function loadGlobalMemory(): string[] {
  try {
    const raw = JSON.parse(readFileSync(GLOBAL_MEMORY, "utf8"));
    if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === "string");
  } catch {
    /* 文件不存在或损坏 */
  }
  return [];
}

/** 保存全局长期记忆（原子 temp+rename，同会话落盘机制）。 */
export function saveGlobalMemory(facts: string[]): void {
  atomicWriteGlobal(GLOBAL_MEMORY, JSON.stringify(facts, null, 2));
}
