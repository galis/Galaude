// 依赖 config 默认值：keepRecentTurns=3、foldGroupSize=4（跑测试时别设 CTX_* 环境变量）。
import { describe, it, expect } from "vitest";
import type OpenAI from "openai";
import { HumanMessage, SystemMessage, AIMessage } from "@langchain/core/messages";
import {
  headTail,
  buildContext,
  buildContextWith,
  pickCompactionRange,
  pickCompactionRangeWith,
  applyCompaction,
  pickFoldGroup,
  applyFold,
  maxSummaryLevel,
  type CompressState,
  type SummarySegment,
} from "./compress.js";
import { lcOps } from "./lgraph/messages.js";

type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;

const sys: Message = { role: "system", content: "system prompt" };
const user = (s: string): Message => ({ role: "user", content: s });
const asst = (s: string): Message => ({ role: "assistant", content: s });

const state = (over: Partial<CompressState> = {}): CompressState => ({
  messages: [sys],
  summaries: [],
  summarizedUpTo: 0,
  memory: [],
  lastPromptTokens: 0,
  ...over,
});

const seg = (a: number, b: number, level = 1, text = `s${a}-${b}`): SummarySegment => ({
  range: [a, b],
  level,
  text,
});

describe("headTail", () => {
  it("行数不多时原样返回", () => {
    const s = "1\n2\n3\n4\n5";
    expect(headTail(s)).toBe(s);
  });

  it("长输出裁成头4行+省略提示+尾4行", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `L${i + 1}`);
    const out = headTail(lines.join("\n")).split("\n");
    expect(out).toHaveLength(9);
    expect(out[0]).toBe("L1");
    expect(out[4]).toContain("中间 12 行已省略");
    expect(out[8]).toBe("L20");
  });
});

describe("pickCompactionRange", () => {
  it("轮数不足 keepRecentTurns 时不折", () => {
    const s = state({
      messages: [sys, user("u1"), asst("a1"), user("u2"), asst("a2"), user("u3")],
    });
    expect(pickCompactionRange(s)).toBeNull();
  });

  it("折掉最近窗口之前的完整轮（start=user，end=窗口起点前一条）", () => {
    // 4 轮：保最近 3 轮 → 折第 1 轮 [1..2]
    const s = state({
      messages: [
        sys,
        user("u1"), asst("a1"),
        user("u2"), asst("a2"),
        user("u3"), asst("a3"),
        user("u4"), asst("a4"),
      ],
    });
    expect(pickCompactionRange(s)).toEqual([1, 2]);
  });

  it("水位线之后没有新的可折时返回 null", () => {
    const s = state({
      messages: [
        sys,
        user("u1"), asst("a1"),
        user("u2"), asst("a2"),
        user("u3"), asst("a3"),
        user("u4"), asst("a4"),
      ],
      summarizedUpTo: 2, // [1..2] 已折过
    });
    expect(pickCompactionRange(s)).toBeNull();
  });
});

describe("applyCompaction / buildContext", () => {
  it("折叠后投影 = system + 摘要块 + 近段原文，messages 原文不动", () => {
    const messages = [
      sys,
      user("u1"), asst("a1"),
      user("u2"), asst("a2"),
      user("u3"), asst("a3"),
      user("u4"), asst("a4"),
    ];
    const s = state({ messages: [...messages] });
    applyCompaction(s, [1, 2], "第一轮摘要");
    expect(s.summarizedUpTo).toBe(2);

    const ctx = buildContext(s);
    expect(s.messages).toHaveLength(messages.length); // 真相源没被删
    expect(ctx[0]).toBe(s.messages[0]); // system 原样在最前（缓存根）
    // ctx[1] = skill hint（buildContext 始终注入），ctx[2] = 摘要
    expect(String(ctx[2]!.content)).toContain("第一轮摘要");
    expect(ctx).toHaveLength(1 + 1 + 1 + 6); // system + skill hint + 摘要 + 近段 [3..8]
    expect(ctx[3]).toEqual(user("u2")); // 近段从水位线后第一条（轮边界 user）开始
  });

  it("外置记忆豁免压缩、排在摘要前", () => {
    const s = state({
      messages: [sys, user("u1")],
      memory: ["用户偏好中文回答"],
      summaries: [seg(1, 2)],
      summarizedUpTo: 0,
    });
    const ctx = buildContext(s);
    // ctx[0]=system, ctx[1]=skill hint, ctx[2]=memory, ctx[3]=summary
    expect(String(ctx[2]!.content)).toContain("用户偏好中文回答");
    expect(String(ctx[3]!.content)).toContain("s1-2");
  });
});

describe("LC 方言（LangGraph 引擎走同一套压缩逻辑）", () => {
  // 与上面 OpenAI 方言的场景同构：同一套断言，换一种消息表示。
  const lcMessages = () => [
    new SystemMessage("system prompt"),
    new HumanMessage("u1"), new AIMessage("a1"),
    new HumanMessage("u2"), new AIMessage("a2"),
    new HumanMessage("u3"), new AIMessage("a3"),
    new HumanMessage("u4"), new AIMessage("a4"),
  ];

  it("pickCompactionRangeWith：折掉最近窗口之前的完整轮", () => {
    const s = {
      messages: lcMessages(),
      summaries: [],
      summarizedUpTo: 0,
      memory: [],
      lastPromptTokens: 0,
    };
    expect(pickCompactionRangeWith(lcOps, s)).toEqual([1, 2]);
  });

  it("buildContextWith：system 缓存根 + 摘要块 + 近段，真相源不动", () => {
    const s = {
      messages: lcMessages(),
      summaries: [{ range: [1, 2] as [number, number], level: 1, text: "第一轮摘要" }],
      summarizedUpTo: 2,
      memory: ["用户偏好中文回答"],
      lastPromptTokens: 0,
    };
    const ctx = buildContextWith(lcOps, s);
    expect(s.messages).toHaveLength(9);
    expect(ctx[0]).toBe(s.messages[0]);
    // ctx[0]=system, ctx[1]=skill hint, ctx[2]=memory, ctx[3]=summary, ctx[4..9]=近段
    expect(String(ctx[2]!.content)).toContain("用户偏好中文回答"); // 记忆在摘要前
    expect(String(ctx[3]!.content)).toContain("第一轮摘要");
    expect(ctx).toHaveLength(1 + 1 + 2 + 6); // system + skill hint + 记忆/摘要 + 近段 [3..8]
    expect(String(ctx[4]!.content)).toBe("u2"); // 近段从轮边界(user)开始
  });
});

describe("pickFoldGroup / applyFold", () => {
  it("摘要段不足 foldGroupSize 时不折", () => {
    const s = state({ summaries: [seg(1, 2), seg(3, 4), seg(5, 6)] });
    expect(pickFoldGroup(s)).toBeNull();
  });

  it("选出最旧、连续、同最低层级的一组", () => {
    const s = state({
      summaries: [seg(1, 2, 2), seg(3, 4, 1), seg(5, 6, 1), seg(7, 8, 1), seg(9, 10, 1)],
    });
    expect(pickFoldGroup(s)).toEqual([1, 4]);
  });

  it("applyFold 把一组替换成一条更高层级的段", () => {
    const s = state({
      summaries: [seg(1, 2, 1), seg(3, 4, 1), seg(5, 6, 1), seg(7, 8, 1)],
    });
    applyFold(s, [0, 3], "合并摘要");
    expect(s.summaries).toHaveLength(1);
    expect(s.summaries[0]).toEqual({ range: [1, 8], level: 2, text: "合并摘要" });
    expect(maxSummaryLevel(s)).toBe(2);
  });
});
