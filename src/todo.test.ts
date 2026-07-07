import { describe, it, expect } from "vitest";
import { normalizeTodos, renderTodos, type Todo } from "./todo.js";

const t = (id: number, content: string, status: Todo["status"]): Todo => ({
  id,
  content,
  status,
});

describe("normalizeTodos", () => {
  it("新项（无 id）按 startId 顺序发号", () => {
    const r = normalizeTodos(
      [],
      [
        { content: "a", status: "pending" },
        { content: "b", status: "in_progress" },
      ],
      1
    );
    expect(r.todos.map((x) => x.id)).toEqual([1, 2]);
    expect(r.nextId).toBe(3);
    expect(r.demoted).toBe(0);
    expect(r.healed).toBe(0);
  });

  it("已知 id：content 以存档为准（自愈漂移），只取新 status", () => {
    const prev = [t(1, "原始描述", "pending")];
    const r = normalizeTodos(
      prev,
      [{ id: 1, content: "模型改写过的描述", status: "completed" }],
      2
    );
    expect(r.todos[0]).toEqual(t(1, "原始描述", "completed"));
    expect(r.healed).toBe(1);
  });

  it("未知 id 当新项重新发号", () => {
    const r = normalizeTodos([], [{ id: 99, content: "x", status: "pending" }], 5);
    expect(r.todos[0]!.id).toBe(5);
    expect(r.nextId).toBe(6);
  });

  it("多个 in_progress 只保留第一个，其余降级 pending", () => {
    const r = normalizeTodos(
      [],
      [
        { content: "a", status: "in_progress" },
        { content: "b", status: "in_progress" },
        { content: "c", status: "in_progress" },
      ],
      1
    );
    expect(r.todos.map((x) => x.status)).toEqual([
      "in_progress",
      "pending",
      "pending",
    ]);
    expect(r.demoted).toBe(2);
  });

  it("非法输入直接 throw（回喂模型自纠）", () => {
    expect(() => normalizeTodos([], "not-an-array", 1)).toThrow();
    expect(() => normalizeTodos([], [{ content: "", status: "pending" }], 1)).toThrow();
    expect(() => normalizeTodos([], [{ content: "a", status: "doing" }], 1)).toThrow();
  });
});

describe("renderTodos", () => {
  it("空清单有占位文案", () => {
    expect(renderTodos([])).toContain("空");
  });

  it("带完成计数与 #id 标记", () => {
    const s = renderTodos([t(1, "a", "completed"), t(2, "b", "in_progress")]);
    expect(s).toContain("(1/2 完成)");
    expect(s).toContain("- [x] #1 a");
    expect(s).toContain("- [~] #2 b");
  });
});
