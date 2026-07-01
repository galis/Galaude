import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type OpenAI from "openai";
import type { SummarySegment } from "./compress.js";
import type { TodoPlan } from "./todo.js";

type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;

// 会话存盘目录（与 logs 同级，放在运行目录下）。
const DIR = join(process.cwd(), "sessions");

/** 落盘的会话结构。messages 就是喂给模型的完整历史，可直接恢复继续聊。 */
export interface StoredSession {
  id: string;
  createdAt: string;
  updatedAt: string;
  title: string; // 取首条用户消息，方便 /sessions 里辨认
  messages: Message[];
  lastPromptTokens?: number; // 上轮投影大小；恢复后据此立刻判断是否要裁
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

export function saveSession(s: StoredSession): void {
  mkdirSync(DIR, { recursive: true });
  const target = fileOf(s.id);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2)); // 先写临时文件
  // 同目录 rename 原子替换：崩溃/断电时要么旧档完好、要么新档完整，杜绝半截坏 JSON。
  // （write 与 rename 之间崩溃留下的 .tmp 无害，下次保存覆盖；不额外清理。）
  renameSync(tmp, target);
}

/** 读取所有会话，按 updatedAt 倒序（最近的在前）。 */
export function listSessions(): StoredSession[] {
  let files: string[];
  try {
    files = readdirSync(DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: StoredSession[] = [];
  for (const f of files) {
    try {
      out.push(JSON.parse(readFileSync(join(DIR, f), "utf8")) as StoredSession);
    } catch {
      /* 跳过坏文件 */
    }
  }
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

/** 按 id 精确或「前缀」加载一个会话（方便只敲前几位）。 */
export function loadSession(idOrPrefix: string): StoredSession | null {
  const all = listSessions();
  return (
    all.find((s) => s.id === idOrPrefix) ??
    all.find((s) => s.id.startsWith(idOrPrefix)) ??
    null
  );
}

export function latestSession(): StoredSession | null {
  return listSessions()[0] ?? null;
}
