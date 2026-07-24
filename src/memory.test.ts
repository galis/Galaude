import { describe, it, expect } from "vitest";
import { normalizeMemory, renderMemory } from "./memory.js";

describe("normalizeMemory", () => {
  it("合法数组原样返回", () => {
    const r = normalizeMemory(["a", "b", "c"]);
    expect(r.facts).toEqual(["a", "b", "c"]);
    expect(r.dropped).toBe(0);
  });

  it("非数组 throw", () => {
    expect(() => normalizeMemory("not-an-array")).toThrow("数组");
    expect(() => normalizeMemory(null)).toThrow("数组");
  });

  it("非字符串 / 空字符串丢弃", () => {
    const r = normalizeMemory(["a", 123, "", "  ", null, "b"]);
    expect(r.facts).toEqual(["a", "b"]);
    expect(r.dropped).toBe(4);
  });

  it("trim 后去重（大小写不敏感）", () => {
    const r = normalizeMemory(["  Hello ", "hello", "HELLO", "World"]);
    expect(r.facts).toEqual(["Hello", "World"]);
    expect(r.dropped).toBe(2);
  });

  it("单条 > 200 字符截断", () => {
    const long = "x".repeat(250);
    const r = normalizeMemory([long]);
    expect(r.facts[0]).toBe("x".repeat(200) + "…");
    expect(r.facts[0]!.length).toBe(201); // 200 + "…"
  });

  it("超出 30 条丢弃尾部", () => {
    const arr = Array.from({ length: 35 }, (_, i) => `fact-${i}`);
    const r = normalizeMemory(arr);
    expect(r.facts.length).toBe(30);
    expect(r.dropped).toBe(5);
    expect(r.facts[0]).toBe("fact-0");
    expect(r.facts[29]).toBe("fact-29");
  });
});

describe("renderMemory", () => {
  it("空记忆有占位文案", () => {
    expect(renderMemory([])).toContain("空");
  });

  it("带计数和列表", () => {
    const s = renderMemory(["用户叫 Junqian", "偏好用 pnpm"]);
    expect(s).toContain("（2 条");
    expect(s).toContain("- 用户叫 Junqian");
    expect(s).toContain("- 偏好用 pnpm");
  });
});
