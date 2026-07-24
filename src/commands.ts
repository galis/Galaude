// Command 领域逻辑（纯函数叶子模块）。
// Command = 用户自定义的 / 快捷指令，背后是 prompt 模板文件。
// 输入 `/review src/tools.ts` 时，自动加载模板、替换 {{input}}、展开发送给模型。
// 文件格式：markdown + frontmatter（--- 包围的 description）。
// 项目级 .galaude/commands/ 覆盖用户级 ~/.galaude/commands/ 同名文件。
// 优先级：.galaude/commands/（项目）> ~/.galaude/commands/（用户）

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 一条命令元信息（/help 列表 + 斜杠菜单用）。 */
export interface CommandMeta {
  name: string;        // 如 "review"
  description: string;  // 一行话
}

// ——————————————————— 路径 ———————————————————
function getUserCommandsDir(): string {
  return join(homedir(), ".galaude", "commands");
}

function getProjectCommandsDir(): string {
  return join(process.cwd(), ".galaude", "commands");
}

// ——————————————————— 扫描 ———————————————————
function scanDir(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""));
  } catch {
    return [];
  }
}

/**
 * 扫描用户级和项目级命令目录，合并去重（项目优先）。
 * 按名排序。
 */
export function scanCommands(
  userDir?: string,
  projectDir?: string
): CommandMeta[] {
  const u = userDir ?? getUserCommandsDir();
  const p = projectDir ?? getProjectCommandsDir();
  const userNames = scanDir(u);
  const projectNames = scanDir(p);
  const map = new Map<string, "user" | "project">();
  for (const n of userNames) map.set(n, "user");
  for (const n of projectNames) map.set(n, "project"); // 项目覆盖

  const result: CommandMeta[] = [];
  for (const name of [...map.keys()].sort()) {
    try {
      const src = map.get(name);
      const dir = src === "project" ? p : u;
      const raw = readFileSync(join(dir, `${name}.md`), "utf8");
      const desc = parseDescription(raw);
      result.push({ name, description: desc });
    } catch {
      /* 跳过损坏文件 */
    }
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

/** 去掉 frontmatter，返回模板正文。 */
function parseTemplate(raw: string): string {
  const lines = raw.split("\n");
  if (lines[0]?.trim() !== "---") return raw.trim();
  let i = 1;
  while (i < lines.length && lines[i]!.trim() !== "---") i++;
  return lines.slice(i + 1).join("\n").trim();
}

/**
 * 加载指定命令模板并把 {{input}} 替换为 arg。
 * 返回展开后的 prompt；找不到命令返回 null。
 */
export function expandCommand(
  name: string,
  arg: string,
  userDir?: string,
  projectDir?: string
): string | null {
  const u = userDir ?? getUserCommandsDir();
  const p = projectDir ?? getProjectCommandsDir();
  const projectFile = join(p, `${name}.md`);
  const userFile = join(u, `${name}.md`);

  let file: string;
  if (existsSync(projectFile)) file = projectFile;
  else if (existsSync(userFile)) file = userFile;
  else return null;

  const raw = readFileSync(file, "utf8");
  const template = parseTemplate(raw);
  return template.replace(/\{\{input\}\}/g, arg);
}
