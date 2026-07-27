# Claude Code Agent/SubAgent 架构设计

> 源码来源: [galis/claude-code](https://github.com/galis/claude-code)  
> 核心模块: `src/tools/AgentTool/`, `src/utils/forkedAgent.ts`, `src/coordinator/`, `src/tasks/LocalAgentTask/`

---

## 1. 总体架构

Claude Code 的 Agent 系统是一个**分层代理架构**，主 Agent 通过子 Agent 编排工作。核心分为三个角色：

```
┌─────────────────────────────────────────────────────────────────┐
│                     主 Agent (Main / Parent)                    │
│  用户直接对话，持有完整 System Prompt + CLAUDE.md + 全工具集    │
│                                                                  │
│  ┌──────────────────────┐  ┌──────────────────────┐             │
│  │   同步子 Agent        │  │   异步子 Agent        │             │
│  │   (Foreground)       │  │   (Background)        │             │
│  │                       │  │                       │             │
│  │  共享 abortController │  │  独立 abortController  │             │
│  │  结果直接返回主 Agent  │  │  通过 task-notification│             │
│  │  主 Agent 等待完成    │  │  异步通知主 Agent      │             │
│  └──────────────────────┘  └──────────────────────┘             │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              Fork Agent (上下文继承)                       │   │
│  │  继承父 Agent 的完整对话上下文 + System Prompt + 工具集    │   │
│  │  共享父 Agent 的 Prompt Cache                             │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. 核心类型定义

### 2.1 AgentId — 品牌类型

```typescript
// src/types/ids.ts
export type AgentId = string & { readonly __brand: 'AgentId' }
export type SessionId = string & { readonly __brand: 'SessionId' }

// AgentId 格式: `a` + 可选的 `<label>-` + 16 位 hex
// 例如: "a-fork-1a2b3c4d5e6f7g8h"
const AGENT_ID_PATTERN = /^a(?:.+-)?[0-9a-f]{16}$/

// SessionId 用于主会话，AgentId 用于子 Agent
// 主 Agent (非子 Agent 上下文) 的 agentId 为 undefined
```

### 2.2 AgentDefinition — Agent 定义

```typescript
// src/tools/AgentTool/loadAgentsDir.ts
export type AgentDefinition = {
  agentType: string           // 类型标识符，如 "general-purpose", "Explore", "Plan"
  whenToUse: string           // 使用场景描述，注入到 Agent Tool 的 prompt 中
  tools?: string[]            // 允许的工具列表，['*'] 表示全部
  disallowedTools?: string[]  // 禁止的工具列表
  skills?: string[]           // 预加载的 skill 名称
  mcpServers?: AgentMcpServerSpec[]  // Agent 专属 MCP 服务器
  hooks?: HooksSettings       // Agent 生命周期 hooks (SubagentStop)
  color?: AgentColorName      // UI 颜色
  model?: string              // 模型：'inherit' 继承父 Agent，或具体模型名
  effort?: EffortValue        // 推理努力级别
  permissionMode?: PermissionMode  // 权限模式 (default/bubble/plan/acceptEdits/bypassPermissions)
  maxTurns?: number           // 最大 API round 数限制
  source: 'built-in' | 'user' | 'project' | 'plugin' | 'managed'  // 来源
  baseDir?: string            // Agent 定义所在目录
  memory?: AgentMemoryScope   // 记忆作用域 (user/project/local)
  background?: boolean        // 强制后台运行
  isolation?: 'worktree' | 'remote'  // 隔离模式

  getSystemPrompt(ctx): string | Promise<string>  // Agent 的 System Prompt
}
```

### 2.3 CacheSafeParams — 缓存共享参数

```typescript
// src/utils/forkedAgent.ts
export type CacheSafeParams = {
  systemPrompt: SystemPrompt      // 必须与父请求一致 → 缓存命中
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
  toolUseContext: ToolUseContext   // 包含 tools, model, thinkingConfig
  forkContextMessages: Message[]   // 父上下文消息（前缀）
}
// Anthropic API 的缓存 key = system + tools + model + messages prefix + thinking config
// 这五个参数决定了是否命中缓存
```

---

## 3. Agent 生命周期

### 3.1 启动流程 (`runAgent.ts`)

```
主 Agent 调用 AgentTool
  │
  ├── 1. 解析参数 (subagent_type, description, prompt, model, run_in_background, ...)
  │
  ├── 2. 查找 Agent 定义 (built-in → user → project → plugin → managed)
  │      ├── Fork 路径 (subagent_type 未指定 + fork gate on)
  │      │   └── 使用 FORK_AGENT 虚拟定义，继承父上下文
  │      └── 常规路径 → selectedAgent = agents.find(a => a.agentType === subagent_type)
  │
  ├── 3. 解析模型、工具集、权限模式
  │      ├── getAgentModel(): 处理 'inherit'、自定义模型
  │      ├── resolveAgentTools(): 过滤允许/禁止 + 异步工具白名单
  │      └── 创建 agentGetAppState() 闭包：覆盖 permissionMode, effort
  │
  ├── 4. 构建 System Prompt
  │      ├── Fork 路径 → 用父 Agent 的 renderedSystemPrompt（保证 byte-exact）
  │      └── 常规路径 → agentDefinition.getSystemPrompt() + enhanceSystemPromptWithEnvDetails()
  │
  ├── 5. 初始化 Agent 专属资源
  │      ├── MCP 服务器 (agentDefinition.mcpServers)
  │      ├── Frontmatter Hooks (agentDefinition.hooks)
  │      ├── 预加载 Skills (agentDefinition.skills)
  │      └── SubagentStart 钩子
  │
  ├── 6. 创建隔离的 ToolUseContext (createSubagentContext)
  │      ├── 复制 readFileState (cloneFileStateCache)
  │      ├── 创建自己或共享 abortController
  │      └── 决定回调：shareSetAppState / shareSetResponseLength
  │
  ├── 7. 启动查询循环 (query loop)
  │      ├── systemPrompt: agentSystemPrompt
  │      ├── messages: forkContextMessages + promptMessages
  │      ├── querySource: `agent:<source>:<type>` 格式
  │      └── maxTurns: agentDefinition.maxTurns (默认无限制)
  │
  ├── 8. 消息流转
  │      ├── Assistant 消息 → yield 给调用者 + 写入 Sidechain Transcript
  │      ├── Stream Events → 转发 pushApiMetricsEntry (TTFT/OTPS)
  │      └── Attachment (如 max_turns_reached) → yield 或 break
  │
  └── 9. 清理 (finally 块)
         ├── MCP 连接清理
         ├── Session Hooks 清理
         ├── Prompt Cache 追踪清理
         ├── ReadFileState 清理
         ├── Fork 上下文消息释放
         ├── Todos 条目清理
         ├── Bash Shell 任务 Kill
         └── Perfetto Trace 清理
```

### 3.2 状态隔离设计 (`createSubagentContext`)

```typescript
// src/utils/forkedAgent.ts:345
//
// 默认: 完全隔离（所有可变状态都克隆/重置）
// 可选的显式共享:
//   shareSetAppState: true      — 同步子 Agent 共享状态
//   shareSetResponseLength: true — 共享响应长度回调
//   shareAbortController: true   — 共享取消信号

export function createSubagentContext(
  parentContext: ToolUseContext,
  overrides?: SubagentContextOverrides,
): ToolUseContext {
  return {
    // === 隔离的状态 ===
    readFileState: cloneFileStateCache(overrides?.readFileState ?? parentContext.readFileState),
    nestedMemoryAttachmentTriggers: new Set(),  // 全新集合
    loadedNestedMemoryPaths: new Set(),
    dynamicSkillDirTriggers: new Set(),
    discoveredSkillNames: new Set(),
    toolDecisions: undefined,

    // === 隔离的 content replacement 状态 ===
    // 克隆防止缓存分叉 — 替换决策影响 wire 前缀，必须一致
    contentReplacementState: cloneContentReplacementState(parentContext.contentReplacementState),

    // === AbortController ===
    abortController: overrides?.shareAbortController
      ? parentContext.abortController           // 共享：同步子 Agent
      : createChildAbortController(...),       // 隔离：异步子 Agent

    // === AppState 访问 ===
    getAppState: 包装函数，设置 shouldAvoidPermissionPrompts（无 UI 的 Agent）
    setAppState: overrides?.shareSetAppState ? parent : no-op,
    setAppStateForTasks: 总是走 root store（Bash 任务注册必须到根 Store）

    // === UI 回调 ===
    addNotification: undefined,    // 子 Agent 不能控制父 Agent 的 UI
    setToolJSX: undefined,
    setStreamMode: undefined,
    setSDKStatus: undefined,
    openMessageSelector: undefined,

    // === 追踪 ===
    agentId: overrides?.agentId ?? createAgentId(),   // 新 Agent ID
    queryTracking: { chainId: new UUID, depth: parent.depth + 1 },  // 深度 +1
  }
}
```

关键设计原则：

- **默认隔离** — 子 Agent 的副作用不能意外影响父 Agent
- **显式共享** — 需要共享的字段必须显式 opt-in，避免隐式依赖
- **根 Store 透传** — `setAppStateForTasks` 永远指向 root（确保异步 Agent 的 Bash 任务注册/清理生效）

---

## 4. 三种 Agent 模式

### 4.1 同步子 Agent (Foreground / isAsync=false)

```
主 Agent                    子 Agent
  │                            │
  │──── AgentTool() ──────────►│
  │                            │ runAgent() 循环
  │                            │   ├── query()
  │                            │   ├── 工具调用
  │                            │   └── yield message
  │◄── yield assistant msg ────│
  │                            │
  │  (等待中...不能做其他事)     │
  │                            │
  │◄── 最终结果 ───────────────│
  │                            X (清理)
  │  处理结果，继续对话          │
```

特点：
- 共享 `abortController` — 父 Agent 的 ESC 取消会传播到子 Agent
- `shareSetAppState: true` — 子 Agent 可以修改 AppState
- `thinkingConfig: { type: 'disabled' }` — 禁用 extended thinking（控制输出成本）
- 结果直接作为 tool_result 返回给主 Agent

### 4.2 异步子 Agent (Background / isAsync=true)

```
主 Agent                         Task System                  子 Agent (后台)
  │                                  │                             │
  │── AgentTool(run_in_background)──►│                             │
  │◄── { status: 'async_launched',   │                             │
  │      agentId, outputFile }       │                             │
  │                                  │                             │
  │  继续其他工作...                  │   registerAsyncAgent()      │
  │                                  │──── runAgent() ────────────►│
  │                                  │                             │ 查询循环
  │                                  │                             │ 工具调用...
  │                                  │◄── yield message ───────────│
  │                                  │   updateProgressFromMessage │
  │                                  │                             │
  │◄── <task-notification> ─────────│                             │
  │     (作为 user message 注入)     │   enqueueAgentNotification() │
  │                                  │                             X (清理)
  │  处理结果                         │
```

特点：
- **独立 abortController** — 主 Agent 的 ESC 不会影响后台 Agent
- `shareSetAppState: false` — no-op，通过 `setAppStateForTasks` 走 root Store
- `isNonInteractiveSession: true`
- 工具白名单限制 (`ASYNC_AGENT_ALLOWED_TOOLS`)
- 结果通过 `<task-notification>` XML 注入为 user message
- 可配置自动转为后台：120 秒后 `tengu_auto_background_agents`

**task-notification 格式**:
```xml
<task-notification>
  <task-id>agent-a1b2c3d4e5f6g7h8</task-id>
  <status>completed|failed|killed</status>
  <summary>Agent "Investigate auth bug" completed</summary>
  <result>agent's final text response</result>
  <usage>
    <total_tokens>12345</total_tokens>
    <tool_uses>12</tool_uses>
    <duration_ms>34567</duration_ms>
  </usage>
</task-notification>
```

### 4.3 Fork Agent (上下文继承)

```
主 Agent (当前对话)              Fork Child
  │                                  │
  │ [messages: G0, G1, G2,          │
  │  assistant(tool_uses)]           │
  │                                  │
  │── AgentTool(无 subagent_type) ──►│
  │                                  │
  │  继承上下文:                      │
  │    - 全部历史消息                 │
  │    - System Prompt               │
  │    - 工具集 (byte-exact)         │
  │    - thinking config             │
  │                                  │
  │  → 相同 API cache key            │
  │  → Prompt Cache 命中!            │
  │                                  │
  │                                  │ runAgent(useExactTools: true)
  │                                  │   查询循环
  │                                  │   工具调用...
  │                                  │   结果报告
  │                                  X (清理)
  │◄── 结果作为 task-notification ───│
```

特点：
- `subagent_type` 省略时触发（gate: `FORK_SUBAGENT`）
- **继承**完整的父上下文（全部历史消息 + System Prompt + 工具 + Thinking Config）
- `useExactTools: true` — 使用父 Agent 的精确工具池
- `thinkingConfig` **继承**（不是 disabled）— 保持与父 Agent 的 API 前缀一致
- **递归防护**: fork child 中不能再 fork（通过 querySource 和 boilerplate 标记检测）
- **prompt 风格**: 写 "directive"（指令）而非 "briefing"（简报）— 因为已经知道上下文

**Fork 的 prompt 组成**:
```typescript
// buildForkedMessages() — forkSubagent.ts
//
// 1. 完整的父 assistant 消息（所有 tool_uses + thinking + text）
// 2. 单个 user 消息：
//    ├── 每个 tool_use 对应一个 placeholder tool_result（'Fork started — processing in background'）
//    └── 一个 text block：child directive（每个 fork 不同，在缓存 key 之外）
//
// 结果: [...history, assistant(all_tool_uses), user(placeholder_results..., directive)]
// 只有 final text block 因 fork 而异 → 其余全量缓存命中!
```

---

## 5. 交互机制：SendMessage

**文件**: `tools/SendMessageTool/SendMessageTool.ts`

子 Agent 不是一次性的。通过 `SendMessage` 可以**继续**一个已经完成的 Agent：

```
主 Agent
  │
  │── SendMessage({ to: "agent-a1b", message: "Fix the null pointer..." })
  │
  │   resumeAgentBackground(agentId)  → 恢复 Agent 上下文
  │   queuePendingMessage(agentId, message)  → 队列入站消息
  │
  │◄── (Agent 处理新消息，完成后再次 task-notification)
```

**支持的结构化消息**:
- `shutdown_request` / `shutdown_response` — Agent 间协商终止
- `plan_approval_response` — 计划审批响应

**设计意图**: Agent 的完整对话上下文保留在 sidechain transcript 中，恢复时重建 `contentReplacementState` 以保证 prompt cache 稳定性。

---

## 6. Coordinator 模式

**文件**: `coordinator/coordinatorMode.ts`

当 `CLAUDE_CODE_COORDINATOR_MODE=1` 时，主 Agent 转换为 **Coordinator（编排者）** 角色。

### 6.1 角色模型

```
┌──────────────────────────────────────────────────┐
│                  Coordinator                       │
│                                                    │
│  工具: AgentTool, SendMessage, TaskStop            │
│  不能直接: Bash, Read, Write, Edit...              │
│                                                    │
│  职责:                                              │
│  1. 理解用户意图                                    │
│  2. 将工作分解为并行/串行子任务                       │
│  3. 合成 Worker 的研究结果 → 精确定义的实现 Spec       │
│  4. 向用户汇报                                       │
│                                                    │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐          │
│  │ Worker 1  │  │ Worker 2  │  │ Worker 3  │          │
│  │ (Research)│  │ (Research)│  │ (Implement)│         │
│  └──────────┘  └──────────┘  └──────────┘          │
└──────────────────────────────────────────────────┘
```

### 6.2 Worker Agent

```typescript
// src/coordinator/coordinatorMode.ts
// Coordinator system prompt 中定义 worker agent 的能力

subagent_type: 'worker'

Worker 拥有的工具:
  Bash, Read, Edit, Write, Glob, Grep, WebSearch, WebFetch,
  Skill (用于调用 /commit, /verify 等 slash command)
  MCP tools (从配置的 MCP 服务器继承)
  NotebookEdit, TodoWrite, Task*, AskUserQuestion, ExitPlanMode

Worker 被排除的工具 (INTERNAL_WORKER_TOOLS):
  TeamCreate, TeamDelete, SendMessage, SyntheticOutput
```

### 6.3 Workflow 四阶段

```
Phase 1: Research    → Workers (并行)
  └── 调查研究代码库，找到相关文件和问题

Phase 2: Synthesis   → Coordinator (自己做)
  └── 阅读 Workers 的发现，理解问题，编写实现 Spec

Phase 3: Implementation → Workers
  └── 按 Spec 进行精确修改，commit

Phase 4: Verification → Workers
  └── 独立验证变更是否生效（不看实现 Worker 的上下文，独立审查）
```

### 6.4 核心设计原则

- **"永远不要委托理解"** — Coordinator 必须自己合成 Worker 的研究结果，不能用 "based on your findings" 把理解工作推给 Worker
- **Continue vs Spawn** — 如果 Worker 上下文与下一个任务高度重叠 → 用 `SendMessage` 继续；否则 → 用 `AgentTool` 全新生成
- **Worker 看不到对话** — 每个 prompt 必须自包含

---

## 7. 工具集管控

### 7.1 工具过滤层级

```typescript
// src/tools/AgentTool/agentToolUtils.ts

// 所有 Agent 都禁止的工具 (ALL_AGENT_DISALLOWED_TOOLS):
//   AgentTool, LegacyAgentTool, BriefTool, ConfigTool,
//   EnterPlanMode, EnterWorktree, ExitWorktree, LSPTool,
//   TeamCreate, TeamDelete, SendMessage, SyntheticOutput,
//   SkillTool (built-in 保留), StartCharmSession, ...

// 自定义 Agent 额外禁止的工具 (CUSTOM_AGENT_DISALLOWED_TOOLS):
//   TaskCreate, TaskStop, TaskOutput, CronCreate, CronDelete,
//   CronList, DesignSync, ScheduleWakeup, Monitor, ...

// 异步 Agent 的白名单 (ASYNC_AGENT_ALLOWED_TOOLS):
//   Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch,
//   NotebookEdit, Task*, TodoWrite, AskUserQuestion, ExitPlanMode,
//   Skill, Monitor, Cron*, ScheduleWakeup, ...
```

### 7.2 工具解析流程

```
agent.tools = ['*']  →  全部父工具 - agent.disallowedTools
agent.tools = ['Read', 'Bash', 'Write']  →  只保留这三个
agent.tools = undefined  →  默认工具集 (= '*' 语义)

过滤步骤:
1. ALL_AGENT_DISALLOWED_TOOLS: 所有 Agent 都排除
2. CUSTOM_AGENT_DISALLOWED_TOOLS: 自定义 Agent 额外排除
3. ASYNC_AGENT_ALLOWED_TOOLS: 异步 Agent 白名单保留
4. agent.disallowedTools: Agent 定义中显式排除
5. MCP tools (mcp__*): 始终保留
```

---

## 8. MCP 服务器集成

Agent 可以定义自己的 MCP 服务器（`agentDefinition.mcpServers`）：

```typescript
// 两种形式:
// 1. 引用已有 MCP 服务器 (字符串):
mcpServers: ['slack', 'github']

// 2. 内联定义:
mcpServers: [{ 'my-custom-server': { command: 'npx', args: ['-y', '...'] } }]
```

**生命周期**:
- 内联定义的 MCP 服务器在 Agent 启动时 `connectToServer()`
- Agent 结束时（finally 块）清理新增的 MCP 连接
- 字符串引用的 MCP 服务器是共享的（memoized `connectToServer`），不在此 Agent 清理
- 当 `strictPluginOnlyCustomization` 锁定时，用户自定义 Agent 的 MCP 被跳过（插件/admin 受信 Agent 不受影响）

---

## 9. 隔离模式

### 9.1 Worktree 隔离

```typescript
// isolation: 'worktree' 时:
// createAgentWorktree() → 在 .claude/worktrees/ 下创建临时 git worktree
// Agent 在隔离的工作副本中运行
// 如果 Agent 无修改 → 自动清理 worktree
// 如果有修改 → 保留 worktree 路径 + 分支名返回给主 Agent
```

### 9.2 Remote 隔离 (ant-only)

```typescript
// isolation: 'remote' 时:
// teleportToRemote() → 将 Agent 任务发送到远程 CCR 环境
// 总是异步: 返回 RemoteLaunchedOutput { taskId, sessionUrl, ... }
```

---

## 10. Sidechain Transcript（侧链记录）

每个子 Agent 都有独立的 transcript 记录：

```
Session 目录结构:
.session/
├── transcript.jsonl              ← 主 Agent 的对话记录
└── subagents/
    ├── agent-a1b2c3d4e5f6g7h8/
    │   ├── transcript.jsonl      ← 子 Agent 的完整对话记录
    │   └── metadata.json         ← { agentType, worktreePath, description }
    ├── agent-x9y0z1...
    └── workflows/<runId>/        ← 工作流子 Agent 的分组目录
```

**记录内容**: Assistant 消息、User 消息、Progress 消息、Compact Boundary 消息  
**不记录**: Stream Events、Attachment 消息  
**用途**: Agent resume（`resumeAgentBackground`）、Transcript 查询

---

## 11. Prompt Cache 共享策略

这是整个 Agent 系统最关键的优化：

```
主 Agent API 请求:
  system + tools + model + messages[0..N] + thinking → Service Cache

Forked Agent API 请求:
  system + tools + model + messages[0..N] + ... + thinking → ↑ CACHE HIT!
```

**Cache Key 的一致性要求**（`CacheSafeParams`):
1. `systemPrompt` — byte-exact 相同
2. `tools` — 相同的工具集定义
3. `model` — 相同的模型
4. `messages` 前缀 — forkContextMessages 相同
5. `thinkingConfig` — 相同的 thinking 配置

**哪些 Fork 共享缓存**:
- Compact 摘要（Forked Agent，共享主线程的缓存）
- Fork Agent（继承全部上下文）
- 这些 cache warm-up 请求（如 prompt suggestion）

**哪些不共享缓存**:
- 普通子 Agent（不同的 System Prompt）
- 不同模型的子 Agent

---

## 12. 事件与日志

```typescript
// Agent 选择
logEvent('tengu_agent_tool_selected', {
  agent_type, model, source, color,
  is_built_in_agent, is_resume, is_async, is_fork
})

// Forked Agent 完成
logEvent('tengu_fork_agent_query', {
  forkLabel, querySource, durationMs, messageCount,
  inputTokens, outputTokens,
  cacheReadInputTokens, cacheCreationInputTokens,
  cacheHitRate, queryChainId, queryDepth
})
```

---

## 13. 设计模式总结

| 模式 | 实现 | 位置 |
|------|------|------|
| **策略模式** | Agent 定义通过 `AgentDefinition` 确定工具集、权限、模型 | `loadAgentsDir.ts` |
| **模板方法** | `runAgent()` 统一生命周期，Agent 自定义 `getSystemPrompt()` | `runAgent.ts` |
| **状态隔离** | `createSubagentContext()` 克隆/重置可变状态 | `forkedAgent.ts` |
| **缓存键一致性** | `CacheSafeParams` 确保 fork 复用父缓存 | `forkedAgent.ts` |
| **命令模式** | `SendMessage` 封装对 Agent 的操作（继续/终止/审批） | `SendMessageTool.ts` |
| **观察者模式** | Task System 监听 Agent 进度，通过 task-notification 通知 | `LocalAgentTask.tsx` |
| **责任链** | Agent 定义来源优先级: built-in → plugin → project → user | `loadAgentsDir.ts` |
| **空对象模式** | `createSubagentContext` 默认 no-op 回调防止空指针 | `forkedAgent.ts` |
| **熔断器** | Fork 递归防护（querySource + boilerplate 检测） | `forkSubagent.ts` |

### 核心设计原则

1. **默认隔离，显式共享** — 子 Agent 不能产生意外的副作用
2. **Prompt Cache 优先** — Fork 路径的设计目标就是缓存命中
3. **异步独立，同步耦合** — `isAsync` 决定 Abort、State、UI 的耦合度
4. **Worker 无状态、Coordinator 有知识** — Coordinator 模式中，状态和知识集中在 Coordinator
5. **彻底清理** — finally 块覆盖 MCP、Hooks、Cache、Bash Tasks、Todos、Transcript — 防止资源泄漏
```
