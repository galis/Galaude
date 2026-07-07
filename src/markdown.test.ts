import { describe, it, expect } from "vitest";
import { dispWidth, wrapSpans, parseInline, mdToLines, type Line } from "./markdown.js";

const lineText = (l: Line) => l.map((sp) => sp.text).join("");

describe("dispWidth", () => {
  it("ASCII 每字符宽 1", () => {
    expect(dispWidth("abc")).toBe(3);
  });
  it("CJK 每字符宽 2", () => {
    expect(dispWidth("中文")).toBe(4);
    expect(dispWidth("a中")).toBe(3);
  });
  it("控制字符宽 0", () => {
    expect(dispWidth("\x1b")).toBe(0);
  });
});

describe("wrapSpans", () => {
  it("按显示宽度折行（CJK 占 2 列）", () => {
    const lines = wrapSpans([{ text: "一二三四五" }], 4); // 每行最多 2 个汉字
    expect(lines.map(lineText)).toEqual(["一二", "三四", "五"]);
  });
  it("折行保留样式", () => {
    const lines = wrapSpans([{ text: "aaaa", bold: true }], 2);
    expect(lines).toHaveLength(2);
    expect(lines[0]![0]!.bold).toBe(true);
  });
});

describe("parseInline", () => {
  it("**粗体**", () => {
    const spans = parseInline("x **b** y");
    expect(spans.find((s) => s.bold)?.text).toBe("b");
  });
  it("`行内代码` 上色", () => {
    const spans = parseInline("run `npm test` now");
    expect(spans.find((s) => s.color === "cyan")?.text).toBe("npm test");
  });
  it("*斜体* 和 _斜体_", () => {
    expect(parseInline("*i*").find((s) => s.italic)?.text).toBe("i");
    expect(parseInline("_i_").find((s) => s.italic)?.text).toBe("i");
  });
});

describe("mdToLines", () => {
  it("标题加粗", () => {
    const lines = mdToLines("## 标题", 80);
    expect(lines[0]![0]!.bold).toBe(true);
    expect(lineText(lines[0]!)).toBe("标题");
  });

  it("无序列表转 • ", () => {
    expect(lineText(mdToLines("- item", 80)[0]!)).toBe("• item");
  });

  it("代码块围栏内不做行内解析", () => {
    const lines = mdToLines("```\n**raw**\n```", 80);
    const code = lines[1]!;
    expect(lineText(code)).toBe("**raw**"); // 星号原样保留
    expect(code[0]!.color).toBe("green");
  });

  it("表格按内容宽度对齐（含 CJK），分隔线带 ┼", () => {
    const md = "| 名称 | n |\n| --- | --- |\n| ab | 1 |\n| 中文字 | 22 |";
    const lines = mdToLines(md, 80).map(lineText);
    expect(lines[1]).toContain("┼");
    // 所有行的 │ 应落在同一显示列
    const cols = [lines[0]!, lines[2]!, lines[3]!].map((l) =>
      dispWidth(l.slice(0, l.indexOf("│")))
    );
    expect(new Set(cols).size).toBe(1);
  });
});
