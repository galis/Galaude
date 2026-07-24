import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  scanSkills,
  renderSkillList,
  renderSkillIndex,
  getSkillFile,
  type SkillMeta,
} from "./skill.js";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let userDir: string;
let builtinDir: string;

function makeSkill(dir: string, name: string, description: string) {
  const dirPart = name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : "";
  const filePart = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
  const target = join(dir, dirPart);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, `${filePart}.md`), `---\ndescription: ${description}\n---\n\nprompt body`);
}

beforeEach(() => {
  const root = join(tmpdir(), `galaude-skill-test-${Date.now()}`);
  userDir = join(root, "user");
  builtinDir = join(root, "builtin");
  mkdirSync(userDir, { recursive: true });
  mkdirSync(builtinDir, { recursive: true });
});

afterEach(() => {
  try { rmSync(userDir + "/..", { recursive: true }); } catch { /* ignore */ }
});

describe("scanSkills", () => {
  it("空目录返回空数组", () => {
    expect(scanSkills(userDir, builtinDir)).toEqual([]);
  });

  it("扫描内置目录中的扁平 skill", () => {
    makeSkill(builtinDir, "review", "代码审查");
    const r = scanSkills(userDir, builtinDir);
    expect(r).toEqual([{ name: "review", description: "代码审查" }]);
  });

  it("扫描子目录 skill（目录即分类）", () => {
    makeSkill(builtinDir, "code/debug", "调试排错");
    const r = scanSkills(userDir, builtinDir);
    expect(r).toEqual([{ name: "code/debug", description: "调试排错" }]);
  });

  it("用户目录覆盖内置同名 skill", () => {
    makeSkill(builtinDir, "review", "内置审查");
    makeSkill(userDir, "review", "用户审查");
    const r = scanSkills(userDir, builtinDir);
    expect(r).toEqual([{ name: "review", description: "用户审查" }]);
  });

  it("多 skill 按名字排序", () => {
    makeSkill(builtinDir, "debug", "调试");
    makeSkill(builtinDir, "review", "审查");
    makeSkill(builtinDir, "commit", "提交");
    const names = scanSkills(userDir, builtinDir).map((s) => s.name);
    expect(names).toEqual(["commit", "debug", "review"]);
  });

  it("无 frontmatter 时描述为占位", () => {
    const p = join(builtinDir, "plain.md");
    writeFileSync(p, "就是一段纯文本");
    const r = scanSkills(userDir, builtinDir);
    expect(r[0]!.description).toBe("(无描述)");
  });
});

describe("getSkillFile", () => {
  it("返回用户目录路径（优先）", () => {
    makeSkill(builtinDir, "review", "内置");
    makeSkill(userDir, "review", "用户");
    expect(getSkillFile("review", userDir, builtinDir)).toBe(join(userDir, "review.md"));
  });

  it("用户不存在时回退到内置", () => {
    makeSkill(builtinDir, "review", "内置");
    expect(getSkillFile("review", userDir, builtinDir)).toBe(join(builtinDir, "review.md"));
  });
});

describe("renderSkillList", () => {
  it("空列表有占位文案", () => {
    expect(renderSkillList([])).toContain("未安装");
  });

  it("展示名 + 描述", () => {
    const list: SkillMeta[] = [
      { name: "review", description: "审查代码" },
      { name: "debug", description: "调试" },
    ];
    const s = renderSkillList(list);
    expect(s).toContain("review");
    expect(s).toContain("审查代码");
    expect(s).toContain("debug");
  });
});

describe("renderSkillIndex", () => {
  it("空列表返回空字符串", () => {
    expect(renderSkillIndex([])).toBe("");
  });

  it("每条含名 + 描述 + 文件路径", () => {
    const list: SkillMeta[] = [
      { name: "review", description: "审查代码" },
    ];
    const s = renderSkillIndex(list);
    expect(s).toContain("review");
    expect(s).toContain("审查代码");
    expect(s).toContain("read_file");
    expect(s).toContain("review.md");
  });
});
