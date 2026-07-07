import { describe, it, expect } from "vitest";
import { parseRisk, parseSummary } from "./llmtasks.js";

describe("parseRisk", () => {
  it("标准 JSON", () => {
    expect(parseRisk('{"risky": true, "reason": "会删文件"}')).toEqual({
      risky: true,
      reason: "会删文件",
    });
  });

  it("带 ```json 围栏也能解析", () => {
    expect(parseRisk('```json\n{"risky": false, "reason": "只读"}\n```')).toEqual({
      risky: false,
      reason: "只读",
    });
  });

  it("解析失败 → 保守判有风险（fail-safe）", () => {
    const r = parseRisk("我觉得没什么问题");
    expect(r.risky).toBe(true);
  });

  it("缺 reason 给占位", () => {
    expect(parseRisk('{"risky": true}').reason).toBe("(无说明)");
  });
});

describe("parseSummary", () => {
  it("标准 JSON：summary + facts", () => {
    expect(
      parseSummary('{"summary": "修了 bug", "facts": ["用户偏好中文", ""]}')
    ).toEqual({ summary: "修了 bug", facts: ["用户偏好中文"] }); // 空串 fact 被滤掉
  });

  it("非 JSON → 整段当纯摘要", () => {
    expect(parseSummary("这段对话讲了 A 和 B")).toEqual({
      summary: "这段对话讲了 A 和 B",
      facts: [],
    });
  });

  it("空输入给占位", () => {
    expect(parseSummary("").summary).toBe("(摘要为空)");
  });
});
