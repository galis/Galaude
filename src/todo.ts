// 任务清单领域逻辑（纯函数、无依赖的叶子模块）。
// 数据结构 + 渲染 + 归一化（校验/软归一/按 id 自愈），供 tools/compress/agent/store 共用。
// 设计见 docs/todo-list.md。

export type TodoStatus = "pending" | "in_progress" | "completed";

/** 单条任务。id 是系统分配的稳定标签——模型只照抄、不自己管理（见设计 D2/D4）。 */
export interface Todo {
  id: number;
  content: string;
  status: TodoStatus;
}

/** 一个会话的任务计划：清单 + 发号计数器。 */
export interface TodoPlan {
  todos: Todo[];
  nextId: number;
}

export const emptyPlan = (): TodoPlan => ({ todos: [], nextId: 1 });

const STATUSES: TodoStatus[] = ["pending", "in_progress", "completed"];
const MARK: Record<TodoStatus, string> = {
  pending: "[ ]",
  in_progress: "[~]",
  completed: "[x]",
};

/**
 * 模型侧渲染（也用于回注上下文）：markdown 复选框 + #id + 内容。
 * 纯 ASCII 标记，避开 emoji 列宽坑；带 #id 让模型能照抄回来（回注 → 照抄，防漂移）。
 */
export function renderTodos(todos: Todo[]): string {
  if (!todos.length) return "（任务清单为空）";
  const done = todos.filter((t) => t.status === "completed").length;
  const lines = todos.map((t) => `- ${MARK[t.status]} #${t.id} ${t.content}`);
  return `任务清单 (${done}/${todos.length} 完成):\n${lines.join("\n")}`;
}

export interface NormalizeResult {
  todos: Todo[];
  nextId: number;
  demoted: number; // 软归一降级的多余 in_progress 数
  healed: number; // 已知 id 上被自愈的 content 漂移数
}

/**
 * 把模型传来的（不可信）整表 incoming 归一成合法清单。全量替换语义。
 * - 校验：每项 content 非空、status 合法；不合法直接 throw（→ 工具错误回喂模型自纠，F3）。
 * - 身份/自愈（F2）：已知 id → content 以存档为准（按 id 冻结、自愈漂移）、只取新 status；
 *   无 id / 未知 id → 当新项发号。
 * - 软归一（D5）：最多一个 in_progress，多出的降级 pending。
 * 纯函数：不碰 session，结果由调用方写回。
 */
export function normalizeTodos(
  prev: Todo[],
  incoming: unknown,
  startId: number
): NormalizeResult {
  if (!Array.isArray(incoming)) throw new Error("todos 必须是数组");
  const prevById = new Map(prev.map((t) => [t.id, t]));
  let nextId = startId;
  let healed = 0;

  const todos: Todo[] = incoming.map((raw, i) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const content = typeof r.content === "string" ? r.content.trim() : "";
    const status = r.status as TodoStatus;
    if (!content) throw new Error(`第 ${i + 1} 项 content 为空或非字符串`);
    if (!STATUSES.includes(status))
      throw new Error(
        `第 ${i + 1} 项 status 非法：${JSON.stringify(
          r.status
        )}（应为 pending/in_progress/completed）`
      );
    const rawId = r.id;
    const id =
      typeof rawId === "number" && Number.isFinite(rawId) ? rawId : undefined;
    if (id !== undefined && prevById.has(id)) {
      const canonical = prevById.get(id)!.content; // content 按 id 冻结 → 自愈漂移
      if (canonical !== content) healed++;
      return { id, content: canonical, status };
    }
    return { id: nextId++, content, status }; // 无 id / 未知 id → 新项发号
  });

  // 软归一：最多一个 in_progress，多出的降级 pending（返回里会说明，让模型下轮自纠）。
  let seen = false;
  let demoted = 0;
  for (const t of todos) {
    if (t.status === "in_progress") {
      if (seen) {
        t.status = "pending";
        demoted++;
      } else seen = true;
    }
  }

  return { todos, nextId, demoted, healed };
}
