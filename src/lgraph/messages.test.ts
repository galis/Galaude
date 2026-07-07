import { describe, it, expect } from "vitest";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import type OpenAI from "openai";
import {
  toLC,
  fromLC,
  lcOps,
  danglingToolCalls,
  renderTranscriptLC,
} from "./messages.js";

type OAIMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

const sample: OAIMessage[] = [
  { role: "system", content: "系统提示" },
  { role: "user", content: "帮我算 1+1" },
  {
    role: "assistant",
    content: "",
    tool_calls: [
      {
        id: "call_1",
        type: "function",
        function: { name: "calculate", arguments: '{"expression":"1+1"}' },
      },
    ],
  },
  { role: "tool", tool_call_id: "call_1", content: "1+1 = 2" },
  { role: "assistant", content: "等于 2" },
];

describe("toLC / fromLC 往返", () => {
  it("OpenAI → LC → OpenAI 结构保持（角色/内容/tool_calls 配对）", () => {
    const round = fromLC(toLC(sample));
    expect(round).toEqual(sample);
  });

  it("坏 JSON 参数退化成 {} 不炸", () => {
    const bad: OAIMessage[] = [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "c", type: "function", function: { name: "t", arguments: "{oops" } },
        ],
      },
    ];
    const lc = toLC(bad);
    expect((lc[0] as AIMessage).tool_calls![0]!.args).toEqual({});
  });
});

describe("lcOps（compress 的 LC 方言）", () => {
  it("role 映射", () => {
    expect(lcOps.role(new SystemMessage("s"))).toBe("system");
    expect(lcOps.role(new HumanMessage("u"))).toBe("user");
    expect(lcOps.role(new AIMessage("a"))).toBe("assistant");
    expect(lcOps.role(new ToolMessage({ content: "t", tool_call_id: "1" }))).toBe("tool");
  });

  it("withText 只克隆替换 content，tool_call_id 保留", () => {
    const t = new ToolMessage({ content: "很长的输出", tool_call_id: "x1" });
    const cut = lcOps.withText(t, "裁剪后") as ToolMessage;
    expect(cut.tool_call_id).toBe("x1");
    expect(cut.content).toBe("裁剪后");
    expect(t.content).toBe("很长的输出"); // 原消息不动
  });
});

describe("danglingToolCalls（中断残留检测）", () => {
  it("尾部 assistant 带未答复 tool_calls → 检出", () => {
    const msgs = toLC(sample.slice(0, 3)); // 停在 tool_calls 那条
    expect(danglingToolCalls(msgs)).toEqual([{ id: "call_1", name: "calculate" }]);
  });

  it("配对完整 / 尾部非 AI → 不误报", () => {
    expect(danglingToolCalls(toLC(sample))).toEqual([]); // 尾部是纯文本回答
    expect(danglingToolCalls(toLC(sample.slice(0, 4)))).toEqual([]); // 尾部是 tool 结果
    expect(danglingToolCalls([])).toEqual([]);
  });
});

describe("renderTranscriptLC", () => {
  it("用户/助手/工具三种行都渲染，调用带参数", () => {
    const s = renderTranscriptLC(toLC(sample));
    expect(s).toContain("用户: 帮我算 1+1");
    expect(s).toContain('〔调用 calculate({"expression":"1+1"})〕');
    expect(s).toContain("工具结果: 1+1 = 2");
    expect(s).toContain("助手: 等于 2");
  });
});
