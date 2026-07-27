// Skill 领域逻辑（纯函数叶子模块）。
// Skill = 可命名的 system prompt 扩展片段，渐进式披露：
//   第一层（常驻注入）：name + description — 每轮 buildContext 始终带
//   第二层（按需读取）：模型判断匹配后用 read_file 自行读取完整 .md 文件
// 文件格式：markdown + frontmatter（--- 包围的 description）。
// 目录即分类：review.md 扁平，code/review.md 就进了 code 分类。
// 优先级：~/.galaude/skills/（用户）> src/skills/（内置）

import { readFileSync, readdirSync, mkdirSync, existsSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, dirname } from "node:path";

/** 一条 skill 元信息（第一层常驻注入 + /skill 列表用）。 */
export interface SkillMeta {
  name: string;        // 如 "review"、"code/debug"
  description: string;  // 一行话
}

// ——————————————————— 路径 ———————————————————
function resolveBuiltinDir(): string {
  const fromCwd = join(process.cwd(), "src", "skills");
  try { readdirSync(fromCwd); return fromCwd; } catch { /* ignore */ }
  const fromFile = join(dirname(import.meta.filename || __filename), "skills");
  try { readdirSync(fromFile); return fromFile; } catch { /* ignore */ }
  return fromCwd;
}

export function getBuiltinSkillsDir(): string { return resolveBuiltinDir(); }

export function getUserSkillsDir(): string { return join(homedir(), ".galaude", "skills"); }

export function getSkillFile(name: string, userDir?: string, builtinDir?: string): string {
  const u = userDir ?? getUserSkillsDir();
  const b = builtinDir ?? getBuiltinSkillsDir();
  const userFile = join(u, `${name}.md`);
  try { readFileSync(userFile); return userFile; } catch { /* skip */ }
  return join(b, `${name}.md`);
}

/** 内置 skill 复制到用户目录（首次启动幂等）。 */
export function ensureUserSkills(): void {
  const builtinDir = getBuiltinSkillsDir();
  const userDir = getUserSkillsDir();
  mkdirSync(userDir, { recursive: true });
  const names = scanDir(builtinDir);
  for (const name of names) {
    const src = join(builtinDir, `${name}.md`);
    const dst = join(userDir, `${name}.md`);
    if (!existsSync(dst)) {
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
    }
  }
}

// ——————————————————— 扫描 ———————————————————
function scanDir(root: string): string[] {
  const names: string[] = [];
  try { _walk(root, root, names); } catch { /* 目录不存在 */ }
  return names;
}

function _walk(root: string, dir: string, out: string[]): void {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isDirectory()) _walk(root, join(dir, e.name), out);
    else if (e.isFile() && e.name.endsWith(".md")) {
      const rel = relative(root, join(dir, e.name)).replace(/\\/g, "/");
      out.push(rel.replace(/\.md$/, ""));
    }
  }
}

/** 扫描两目录，合并去重（用户优先）。按名排序。 */
export function scanSkills(userDir?: string, builtinDir?: string): SkillMeta[] {
  const u = userDir ?? getUserSkillsDir();
  const b = builtinDir ?? getBuiltinSkillsDir();
  const builtin = scanDir(b);
  const userNames = scanDir(u);
  const map = new Map<string, "builtin" | "user">();
  for (const n of builtin) map.set(n, "builtin");
  for (const n of userNames) map.set(n, "user");

  const result: SkillMeta[] = [];
  for (const name of [...map.keys()].sort()) {
    try {
      const file = getSkillFile(name, u, b);
      const raw = readFileSync(file, "utf8");
      const desc = parseDescription(raw);
      result.push({ name, description: desc });
    } catch { /* 跳过损坏文件 */ }
  }
  return result;
}

// ——————————————————— 加载 ———————————————————
function parseDescription(raw: string): string {
  const lines = raw.split("\n");
  if (lines[0]?.trim() !== "---") return "(无描述)";
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === "---") break;
    const m = line.match(/^description:\s*(.*)/i);
    if (m) return (m[1] ?? "").trim();
  }
  return "(无描述)";
}

// ——————————————————— 渲染 ———————————————————
/**
 * 第一层（常驻注入）：每轮 buildContext 始终注入 skill 索引。
 * 列出 name + description，告知模型用 read_file 读取完整 prompt。
 */
export function renderSkillIndex(skills: SkillMeta[]): string {
  if (!skills.length) return "";
  const userDir = getUserSkillsDir();
  const lines = skills.map(
    (s) => `- ${s.name}: ${s.description}（文件: ${join(userDir, s.name + ".md")}）`
  );
  return `【可用 Skills（需要时用 read_file 读取对应文件加载完整 prompt）】\n${lines.join("\n")}`;
}

// skills 在进程生命周期内不会变，只扫一次盘，避免每轮 buildContext 重复 readdir+readFile。
let _skillIndexCache: string | undefined;
/** 获取已渲染的 skill 索引文本（常驻注入 buildContext，首次调用后缓存）。 */
export function getSkillIndexText(): string {
  if (_skillIndexCache !== undefined) return _skillIndexCache;
  const skills = scanSkills();
  _skillIndexCache = renderSkillIndex(skills);
  return _skillIndexCache;
}

/** UI /skill 命令用：展示 skill 列表（名 + 描述）。 */
export function renderSkillList(skills: SkillMeta[]): string {
  if (!skills.length) return "（未安装任何 skill）";
  const lines = skills.map((s) => `  ${s.name}  ${s.description}`);
  return `🧰 可用 Skills（需要时用 read_file 读取完整 prompt）：\n${lines.join("\n")}`;
}
