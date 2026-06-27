import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { basename, join } from "node:path";

/**
 * 文件日志：每次运行生成一个带时间戳的 .log，记录每轮发给模型的
 * 完整 messages（真正的 prompt 正文）、模型响应、工具执行。
 * 只保留最新的 MAX_LOGS 个，超出自动删最旧的。
 */

const LOG_DIR = join(process.cwd(), "logs");
const MAX_LOGS = 100;
const LATEST_LINK = join(LOG_DIR, "last.log"); // 始终指向最新一次运行的日志

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

// 文件名用 YYYYMMDD-HHmmss-mmm，按字典序排正好就是按时间排。
function timestamp(): string {
  const d = new Date();
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}` +
    `-${pad(d.getMilliseconds(), 3)}`
  );
}

// 新建本次运行的日志前，先清理：让加上这一个后总数不超过 MAX_LOGS。
function pruneOldLogs(): void {
  let files: string[];
  try {
    files = readdirSync(LOG_DIR).filter(
      (f) => f.startsWith("run-") && f.endsWith(".log")
    );
  } catch {
    return;
  }
  files.sort(); // 文件名即时间，升序 = 旧在前
  const removeCount = files.length - (MAX_LOGS - 1);
  for (let i = 0; i < removeCount; i++) {
    try {
      unlinkSync(join(LOG_DIR, files[i]!));
    } catch {
      /* 删不掉就算了，不影响主流程 */
    }
  }
}

// 把 logs/last.log 指到本次日志（相对软链，可移植）。
// `tail -f logs/last.log` 就能一直跟着最新一次运行看。
function updateLatestLink(target: string): void {
  try {
    unlinkSync(LATEST_LINK);
  } catch {
    /* 不存在就算了 */
  }
  try {
    symlinkSync(basename(target), LATEST_LINK); // 相对目标，只存文件名
  } catch {
    /* 个别文件系统不支持软链就跳过，不影响主流程 */
  }
}

export interface RunLogger {
  path: string;
  log(text: string): void;
  section(title: string): void;
}

export function createRunLogger(): RunLogger {
  mkdirSync(LOG_DIR, { recursive: true });
  pruneOldLogs();
  const path = join(LOG_DIR, `run-${timestamp()}.log`);
  appendFileSync(path, `# Galaude run @ ${new Date().toISOString()}\n`);
  updateLatestLink(path);
  return {
    path,
    log(text: string) {
      appendFileSync(path, text + "\n");
    },
    section(title: string) {
      appendFileSync(path, `\n${"=".repeat(64)}\n${title}\n${"=".repeat(64)}\n`);
    },
  };
}
