# Galaude — 从零手写的 Agent 编排器（学习向）

不用任何框架，用 TypeScript 实现 `think → act → observe` 循环，吃透 function calling 和 agent 编排的底层原理。模型用 DeepSeek（OpenAI 兼容协议）。

## 快速开始

```bash
npm install
cp .env.example .env        # 然后填入你的 DEEPSEEK_API_KEY

npm run dev                 # 进入多轮对话（终端 REPL，像 Claude Code）
npm run dev -- "帮我算 (3+4)*5"   # 一次性模式：跑一句就退出
```

进入 REPL 后输入问题即可，多轮之间自动保留上下文。命令：

```
/exit, /quit   退出
/clear         清空上下文（开新对话）
/history       看当前历史的 role 时间线
/help          帮助
```

## 目录结构

```
src/
  config.ts   # 集中配置（model / debug / traceStream），文件默认值 ← env 覆盖
  llm.ts      # DeepSeek 客户端（openai SDK + baseURL）、模型名
  tools.ts    # 工具的「声明」(JSON schema) + 「实现」(本地函数注册表)
  logger.ts   # 会话日志（每次运行一个 logs/run-*.log，last.log 软链最新）
  agent.ts    # 核心 think→act→observe 循环 + 流式 + 会话(Session)
  index.ts    # 入口：终端 REPL / 一次性模式
```

## 核心原理（看代码时重点理解）

- **模型只「请求」工具，代码才真正执行**：`agent.ts` 里检测 `tool_calls`，本地跑 `toolRegistry[name](args)`。
- **API 无状态**：每一轮都把完整 `messages` 历史重新传给模型。
- **observation 回传规则**：工具结果用 `role:"tool"`，且 `tool_call_id` 必须和模型的请求一一对应。
- **循环出口**：模型某轮不再返回 `tool_calls` → 那就是最终自然语言答案。

## 模型说明

默认 `deepseek-v4-pro`（可用 `.env` 里的 `DEEPSEEK_MODEL` 覆盖，例如换成 `deepseek-v4-flash`）。
旧别名 `deepseek-chat` / `deepseek-reasoner` 已下线，不要用。

## 路线图

- **Phase 1（已完成）**：最小可运行循环 + 一个示例工具（`calculate`）。
- **Phase 2**：多工具自动选择、工具报错当 observation 喂回、最大轮数上限（已内置 `MAX_TURNS=10`）、`stream: true` 流式输出。
- **Phase 3**：迁移到 LangGraph，对照手写逻辑；接 LangSmith 做可观测性。
