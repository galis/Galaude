// Skill 领域逻辑（纯函数叶子模块）。
// Skill = 可命名的 system prompt 扩展片段，渐进式披露：
//   发现层：skillread → 只看 name + description
//   激活层：skillactivate → 完整 prompt 注入上下文
// 文件格式：markdown + frontmatter（--- 包围的 description/tools）。
// 目录即分类：review.md 扁平，code/review.md 就进了 code 分类。
// 优先级：~/.galaude/skills/（用户）> src/skills/（内置）

import { readFileSync, readdirSync, mkdirSync, existsSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, dirname } from "node:path";

/** 一条已安装的 skill 元信息（发现层展示用）。 */
export interface SkillMeta {
  name: string;       // 如 "review"、"code/debug"
  description: string; // 一行话
  invocation: "model" | "user" | "both"; // 触发方式
}

/** 一条完整的 skill（激活后缓存用）。 */
export interface Skill extends SkillMeta {
  prompt: string;     // 注入上下文的 prompt 正文
}

// ——————————————————— 路径 ———————————————————
function resolveBuiltinDir(): string {
  // 优先：cwd/src/skills（tsx 直接跑开发时）
  const fromCwd = join(process.cwd(), "src", "skills");
  try { readdirSync(fromCwd); return fromCwd; } catch { /* ignore */ }
  // 回退：本文件同级 skills/ 目录
  const fromFile = join(dirname(import.meta.filename || __filename), "skills");
  try { readdirSync(fromFile); return fromFile; } catch { /* ignore */ }
  return fromCwd;
}

export function getBuiltinSkillsDir(): string {
  return resolveBuiltinDir();
}

export function getUserSkillsDir(): string {
  return join(homedir(), ".galaude", "skills");
}

/** 确保内置 skill 复制到用户目录（若用户目录还不存在该 skill）。首次启动调用一次即可。 */
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

// ——————————————————— 扫描（可注入目录用于测试）———————————————————
function scanDir(root: string): string[] {
  const names: string[] = [];
  try {
    _walk(root, root, names);
  } catch { /* 目录不存在 */ }
  return names;
}

function _walk(root: string, dir: string, out: string[]): void {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isDirectory()) {
      _walk(root, join(dir, e.name), out);
    } else if (e.isFile() && e.name.endsWith(".md")) {
      const rel = relative(root, join(dir, e.name)).replace(/\\/g, "/"); // win 兼容
      out.push(rel.replace(/\.md$/, ""));
    }
  }
}

/**
 * 扫描两目录，合并去重。用户目录优先（同名覆盖内置）。
 * @param userDir 用户 skill 目录，默认 ~/.galaude/skills/
 * @param builtinDir 内置 skill 目录，默认 src/skills/
 */
export function scanSkills(
  userDir?: string,
  builtinDir?: string
): SkillMeta[] {
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
      const skill = loadSkill(name, u, b);
      result.push({ name: skill.name, description: skill.description, invocation: skill.invocation });
    } catch {
      // 文件损坏，跳过
    }
  }
  return result;
}

// ——————————————————— 加载 ———————————————————
function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const lines = raw.split("\n");
  if (lines[0]?.trim() !== "---") return { meta: {}, body: raw };
  const end = lines.slice(1).findIndex((l) => l.trim() === "---");
  if (end === -1) return { meta: {}, body: raw };
  const fmLines = lines.slice(1, end + 1);
  const body = lines.slice(end + 2).join("\n").trim();
  const meta: Record<string, string> = {};
  for (const line of fmLines) {
    const m = line.match(/^(\w[\w-]*):\s*(.*)/);
    if (m) meta[m[1]!] = (m[2] ?? "").trim();
  }
  // 向后兼容：tools 别名 → allowed-tools
  if (meta["tools"] && !meta["allowed-tools"]) meta["allowed-tools"] = meta["tools"];
  return { meta, body };
}

/**
 * 加载一个 skill 的完整内容。优先级：userDir > builtinDir。
 * name 格式如 "review" 或 "code/review"。
 */
export function loadSkill(
  name: string,
  userDir?: string,
  builtinDir?: string
): Skill {
  const u = userDir ?? getUserSkillsDir();
  const b = builtinDir ?? getBuiltinSkillsDir();
  const paths = [join(u, `${name}.md`), join(b, `${name}.md`)];
  let raw: string | null = null;
  for (const p of paths) {
    try { raw = readFileSync(p, "utf8"); break; } catch { /* skip */ }
  }
  if (raw === null) throw new Error(`skill ${name} 不存在（已搜索 ${paths.join("、")}）`);

  const { meta, body } = parseFrontmatter(raw);
  const description = meta.description || "(无描述)";
  const prompt = body || description;
  const invocation = meta.invocation === "model" || meta.invocation === "user"
    ? meta.invocation : "both";

  return { name, description, invocation, prompt };
}

// ——————————————————— 渲染 ———————————————————
export function renderSkillList(skills: SkillMeta[]): string {
  if (!skills.length) return "（未安装任何 skill）";
  const lines = skills.map((s) => `  ${s.name}  ${s.description}`);
  return `🧰 可用 Skills（渐进式披露 — 用 skillactivate <name> 激活后才加载完整 prompt）：\n${lines.join("\n")}`;
}

/** 把已激活 skill 的 prompt 展开成 system 消息内容列表（每条一个 skill）。 */
export function renderSkillPrompts(skills: Skill[]): string[] {
  return skills.map((s) => `【已激活 Skill: ${s.name}】\n${s.prompt}`);
}

/**
 * 发现层始终注入：一行提示列出所有 skill 名（不含激活的 prompt）。
 * 极轻量（~20 token/skill），让模型无需调用 skillread 也知道有哪些可用。
 */
export function renderSkillHint(skills: SkillMeta[]): string {
  if (!skills.length) return "";
  const names = skills.map((s) => s.name).join(", ");
  return `【可用 Skills】${names} | 用 skillactivate <name> 激活 | skillread 查看详情`;
}

/**
 * 获取 skill 的参考文件目录路径。
 * 如 skill "code/review"，返回 skill 文件所在目录，
 * body 中可引用相对路径如 `./references/forms.md`。
 */
export function getSkillDir(name: string): string {
  const userFile = join(getUserSkillsDir(), `${name}.md`);
  const builtinFile = join(getBuiltinSkillsDir(), `${name}.md`);
  try { readFileSync(userFile); return dirname(userFile); } catch { /* skip */ }
  try { readFileSync(builtinFile); return dirname(builtinFile); } catch { /* skip */ }
  return dirname(builtinFile); // 回退
}
