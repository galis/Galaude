import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  scanSkills,
  loadSkill,
  renderSkillList,
  renderSkillPrompts,
  type SkillMeta,
} from "./skill.js";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// 每次测试建独立临时目录
let userDir: string;
let builtinDir: string;

function makeSkill(dir: string, name: string, description: string, prompt: string) {
  const dirPart = name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : "";
  const filePart = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
  const target = join(dir, dirPart);
  mkdirSync(target, { recursive: true });
  writeFileSync(
    join(target, `${filePart}.md`),
    `---\ndescription: ${description}\n---\n\n${prompt}`
  );
}

beforeEach(() => {
  const root = join(tmpdir(), `galaude-skill-test-${Date.now()}`);
  userDir = join(root, "user");
  builtinDir = join(root, "builtin");
  mkdirSync(userDir, { recursive: true });
  mkdirSync(builtinDir, { recursive: true });
});

afterEach(() => {
  // 清理（只清我们建的）
  try { rmSync(userDir + "/..", { recursive: true }); } catch { /* ignore */ }
});

describe("scanSkills", () => {
  it("空目录返回空数组", () => {
    expect(scanSkills(userDir, builtinDir)).toEqual([]);
  });

  it("扫描内置目录中的扁平 skill", () => {
    makeSkill(builtinDir, "review", "代码审查", "审查代码。");
    const r = scanSkills(userDir, builtinDir);
    expect(r).toEqual([{ name: "review", description: "代码审查" }]);
  });

  it("扫描子目录 skill（目录即分类）", () => {
    makeSkill(builtinDir, "code/debug", "调试排错", "调试模式。");
    const r = scanSkills(userDir, builtinDir);
    expect(r).toEqual([{ name: "code/debug", description: "调试排错" }]);
  });

  it("用户目录覆盖内置同名 skill", () => {
    makeSkill(builtinDir, "review", "内置审查", "builtin body");
    makeSkill(userDir, "review", "用户审查", "user body");
    const r = scanSkills(userDir, builtinDir);
    expect(r).toEqual([{ name: "review", description: "用户审查" }]);
  });

  it("多 skill 按名字排序", () => {
    makeSkill(builtinDir, "debug", "调试", "d");
    makeSkill(builtinDir, "review", "审查", "r");
    makeSkill(builtinDir, "commit", "提交", "c");
    const names = scanSkills(userDir, builtinDir).map((s) => s.name);
    expect(names).toEqual(["commit", "debug", "review"]);
  });
});

describe("loadSkill", () => {
  it("加载完整 skill（含 frontmatter）", () => {
    makeSkill(builtinDir, "review", "审查代码", "请仔细审查。\n- 检查 bug\n- 检查性能");
    const s = loadSkill("review", userDir, builtinDir);
    expect(s.name).toBe("review");
    expect(s.description).toBe("审查代码");
    expect(s.prompt).toBe("请仔细审查。\n- 检查 bug\n- 检查性能");
  });

  it("用户优先于内置", () => {
    makeSkill(builtinDir, "review", "内置", "B");
    makeSkill(userDir, "review", "用户", "U");
    const s = loadSkill("review", userDir, builtinDir);
    expect(s.description).toBe("用户");
    expect(s.prompt).toBe("U");
  });

  it("不存在则 throw", () => {
    expect(() => loadSkill("nope", userDir, builtinDir)).toThrow("不存在");
  });

  it("无 frontmatter 时整体当 prompt，描述为占位", () => {
    const p = join(builtinDir, "plain.md");
    writeFileSync(p, "就是一段纯文本");
    const s = loadSkill("plain", userDir, builtinDir);
    expect(s.description).toBe("(无描述)");
    expect(s.prompt).toBe("就是一段纯文本");
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
    expect(s).toContain("调试");
  });
});

describe("renderSkillPrompts", () => {
  it("展开为 system 消息内容数组", () => {
    const prompts = renderSkillPrompts([
      { name: "review", description: "d", prompt: "审查原则:\n1. ux\n2. perf" },
    ]);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("【已激活 Skill: review】");
    expect(prompts[0]).toContain("审查原则:");
    expect(prompts[0]).toContain("1. ux");
  });

  it("多个 skill 各一条", () => {
    const prompts = renderSkillPrompts([
      { name: "a", description: "", prompt: "A" },
      { name: "b", description: "", prompt: "B" },
    ]);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("A");
    expect(prompts[1]).toContain("B");
  });
});
