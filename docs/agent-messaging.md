# Claude Code Agent 消息委派与回调机制

> 从零理解：主 Agent 如何通知/委派子 Agent，消息如何流转，结果如何回调

---

## 1. 整体消息流（全景图）

```
用户输入
  │
  ▼
┌─────────────────────────────────────────────────────────────────────┐
│  主 Agent (query loop)                                              │
│                                                                     │
│  ┌──────────────────┐      ┌──────────────────┐                    │
│  │ 工具调用回合      │ ───► │ AgentTool.call() │                    │
│  │ (normalizeMsg)   │      │                  │                    │
│  └──────────────────┘      └────────┬─────────┘                    │
│                                      │                              │
│                    ┌─────────────────┼─────────────────┐            │
│                    │                 │                 │            │
│              同步 Agent        异步 Agent         Fork Agent       │
│              (Foreground)     (Background)     (Context Inherit)   │
│                                                                     │
│  ▲ 结果直接返回    ▲ task-notification  ▲ task-notification        │
│  │ 到 tool_result  │ 注入为 user msg    │ 注入为 user msg           │
└──┼─────────────────┼───────────────────┼───────────────────────────┘
   │                 │                   │
   ▼                 ▼                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│  子 Agent (独立 query loop)                                         │
│                                                                     │
│  system prompt → query() → tool calls → ... → 最终文本              │
│                                                                     │
│  SendMessage 可以继续已完成的 Agent（恢复上下文）                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. 委派：主 Agent → 子 Agent

### 2.1 入口: AgentTool.call()

```typescript
// src/tools/AgentTool/AgentTool.tsx
// 主 Agent 调用 AgentTool 时，传入以下参数:

interface AgentToolInput {
  description: string     // 3-5 词简短描述
  prompt: string          // 子 Agent 的任务 prompt
  subagent_type?: string  // 子 Agent 类型（省略时 fork）
  model?: 'sonnet'|'opus'|'haiku'
  run_in_background?: boolean
  name?: string           // 多 Agent 协作时的名称
  isolation?: 'worktree'|'remote'
}
```

### 2.2 委派决策树

```
AgentTool.call()
  │
  ├── team_name + name 都存在?
  │   └── YES → spawnTeammate()  // 多 Agent Team 模式（独立进程/tmux）
  │
  ├── subagent_type 存在?
  │   └── YES → 查找 Agent 定义 → 常规子 Agent
  │       ├── isAsync = run_in_background || agentDef.background
  │       ├── 同步 → runAgent(), 等待结果
  │       └── 异步 → runAsyncAgentLifecycle(), 立即返回 async_launched
  │
  └── subagent_type 省略 + FORK_SUBAGENT gate on?
      └── YES → Fork Agent（继承完整上下文）
          └── 总是异步
```

### 2.3 同步委派的调用链

```
AgentTool.call()
  │
  ├── 1. resolveAgentTools(agentDef, availableTools)
  │      └── 过滤出子 Agent 可用的工具集
  │
  ├── 2. agentGetAppState() 闭包
  │      └── 覆盖 permissionMode, effort, allowedTools
  │
  ├── 3. getAgentSystemPrompt() → agentDef.getSystemPrompt()
  │      └── 每个 Agent 类型有自己的 System Prompt
  │
  ├── 4. runAgent({
  │      agentDefinition,
  │      promptMessages: [createUserMessage({ content: prompt })],
  │      toolUseContext: parentContext,
  │      canUseTool,
  │      isAsync: false,
  │      forkContextMessages: parentMessages,  // 传递父上下文（用于 cache 共享）
  │      availableTools: resolvedTools,
  │    })
  │
  └── 5. for await (const msg of runAgent(...)) { ... }
         └── 阻塞等待子 Agent 完成
         └── 累积所有 messages
         └── 提取最终 assistant 消息文本作为 tool_result
```

### 2.4 异步委派的调用链

```
AgentTool.call()
  │
  ├── 1-3. 同同步路径
  │
  ├── 4. runAsyncAgentLifecycle({
  │      agentDefinition,
  │      promptMessages,
  │      toolUseContext,
  │      canUseTool,
  │      availableTools,
  │      agentId,
  │      description,
  │      model,
  │      onCacheSafeParams,  // ← 用于后台摘要
  │    })
  │
  │   runAsyncAgentLifecycle() 内部:
  │   ├── registerAsyncAgent(taskState, abortController)
  │   │   └── 将 Agent 注册到 AppState.tasks[agentId]
  │   │       状态: pending → running → completed/failed/killed
  │   │
  │   ├── 启动后台 query loop (IIFE)
  │   │   for await (const msg of runAgent(...)) {
  │   │     updateProgressFromMessage(msg)
  │   │     emitTaskProgress(agentId, msg)
  │   │   }
  │   │
  │   └── 完成/失败时:
  │       completeAgentTask(agentId, result)
  │       │
  │       └── enqueueAgentNotification(agentId, result)
  │           └── 将 <task-notification> 注入主 Agent 的下一条消息
  │
  └── 5. 立即返回 { status: 'async_launched', agentId, outputFile }
```

### 2.5 Fork 委派（特殊路径）

```typescript
// forkSubagent.ts
// Fork 子 Agent 不是"创建新对话"，而是"继承并延续"

buildForkedMessages(directive, assistantMessage):
  1. 克隆完整的父 assistant 消息（所有 tool_use, thinking, text）
  2. 构建单个 user 消息：
     ├── 每个 tool_use → placeholder tool_result
     │   内容: 'Fork started — processing in background'
     └── text block: fork child directive

  结果:
    [...全部历史, assistant(all_tool_uses), user(placeholders + directive)]

  只有最后的 directive text 因 fork 而异
  → 前面的所有内容与父 Agent 的 API 请求前缀相同
  → Prompt Cache 命中！
```

---

## 3. 回调：子 Agent → 主 Agent

### 3.1 同步回调路径

```
子 Agent (runAgent 的 query loop)
  │
  ├── for await (const msg of query({...})) {
  │     yield msg  // ← 逐条 yield 给 AgentTool.call()
  │   }
  │
  ▼
AgentTool.call()
  │
  ├── 收集所有 yield 的 messages
  ├── 提取最后一条 assistant message 的 text 内容
  └── 返回 { data: { status: 'completed', result: text, ... } }
      │
      ▼
  主 Agent 的 tool_result block
  → 主 Agent 看到子 Agent 的完整结果
  → 继续下一轮 query loop
```

**关键限制**: 同步子 Agent 返回结果前，主 Agent **处于等待状态**，不能处理其他任务。

### 3.2 异步回调路径（task-notification 机制）

这是最复杂的部分，分三层：

#### 第一层：Task 状态机

```typescript
// src/tasks/LocalAgentTask/LocalAgentTask.tsx

// Agent 注册
registerAsyncAgent(agentId, description, abortController):
  AppState.tasks[agentId] = {
    type: 'local_agent',
    status: 'pending',       // → running → completed/failed/killed
    description,
    agentId,
    abortController,
    progress: { summary: null },
    retrieved: false,        // 主 Agent 是否已读取结果
  }

// Agent 完成
completeAgentTask(agentId, result):
  AppState.tasks[agentId] = {
    ...prev,
    status: 'completed',
    result: { text, messages, usage },
  }
  → enqueueAgentNotification(agentId, result)

// Agent 失败
failAgentTask(agentId, error):
  AppState.tasks[agentId] = {
    ...prev,
    status: 'failed',
    error: error.message,
  }
  → enqueueAgentNotification(agentId, error)
```

#### 第二层：Notification 注入

```typescript
// enqueueAgentNotification() 是核心机制:

enqueueAgentNotification(agentId, result):
  // 生成 XML 格式的 task-notification
  const notification = `
<task-notification>
  <task-id>${agentId}</task-id>
  <status>${result.status}</status>
  <summary>${generateSummary(result)}</summary>
  <result>${result.text}</result>
  <usage>
    <total_tokens>${usage.total_tokens}</total_tokens>
    <tool_uses>${usage.tool_uses}</tool_uses>
    <duration_ms>${usage.duration_ms}</duration_ms>
  </usage>
</task-notification>`

  // 将 notification 作为 user message 注入主对话
  // 注入方式: 在下一次主 Agent API 请求时附加到 messages 末尾
  pendingNotifications.push({ agentId, notification })

  // 主 Agent 的下一个 query loop 开始时:
  // messages = [...previousMessages, userMessage(notification)]
```

**关键设计**: notification 以 **user message** 形式注入。主 Agent 看到它时，像处理用户消息一样处理，只是内容格式为 XML。

#### 第三层：主 Agent 处理 notification

```
主 Agent query loop
  │
  ├── 下一轮开始时，messages 末尾多了:
  │   { role: 'user', content: '<task-notification>...' }
  │
  ├── 主 Agent 的 System Prompt 中已告知如何识别:
  │   "Worker results arrive as user-role messages containing
  │    <task-notification> XML. Distinguish them by the
  │    <task-notification> opening tag."
  │
  └── 主 Agent 解析 notification，提取:
      - 哪个 Agent 完成了 (task-id)
      - 状态 (completed/failed/killed)
      - 结果文本 (result)
      - Token 用量 (usage)
```

### 3.3 进度回调

```typescript
// AgentTool 在子 Agent 运行期间可以收到进度更新:

// AgentTool.call() 定义 onProgress 回调:
onProgress?: (progress: AgentToolProgress | ShellProgress) => void

// runAgent() 中:
updateProgressFromMessage(message):
  // 从 assistant message 中提取进度信息
  // 例如: tool_use 名称、thinking 内容摘要
  // 更新 AppState.tasks[agentId].progress

// AgentTool.call() 定期检查:
getProgressUpdate(agentId):
  // 返回当前进度 { summary, lastToolUse, tokensUsed, ... }
```

**注意**: 对于异步 Agent，主 Agent 不应该主动 poll 进度。Claude Code 的做法是**推送**：只在 Agent 完成时通过 notification 通知。

---

## 4. 继续对话：SendMessage 机制

### 4.1 设计意图

子 Agent 不是一次性的。当 Agent 完成研究任务后，如果发现需要修改代码，不应该从零启动新 Agent，而应该**在同一个 Agent 的上下文中继续**。

```
场景:
  Agent "research-auth" 完成了研究，找到了 bug 位置
  主 Agent: "基于研究结果修复这个 bug"
  
  错误做法: AgentTool({ subagent_type: 'general-purpose', prompt: '基于研究...' })
  → 新 Agent 没有研究上下文，需要重新解释
  
  正确做法: SendMessage({ to: 'research-auth', message: '修复 validate.ts:42...' })
  → 同一个 Agent 继续，已有全部研究上下文
```

### 4.2 SendMessage 调用链

```typescript
// src/tools/SendMessageTool/SendMessageTool.ts

SendMessage.call({ to, message, summary }):

  1. 解析 to:
     ├── Agent ID (a-xxx 格式)  → 子 Agent
     ├── teammate name          → 多 Agent Team 中的队友
     ├── "main"                 → 主 Agent（从子 Agent 发送）
     └── "uds:<path>" / "bridge:<id>"  → 跨进程/跨设备

  2. 查找 Agent:
     ├── 在 AppState.tasks 中查找
     ├── 在 Teammate tasks 中查找
     └── 在 InProcessTeammate tasks 中查找

  3. 恢复或发送:
     ├── Agent 已完成? → resumeAgentBackground(agentId)
     │   └── 从 sidechain transcript 重建 Agent 上下文
     │   └── 恢复 contentReplacementState（保证 cache 稳定性）
     │   └── 启动新的 query loop
     │
     ├── Agent 正在运行? → queuePendingMessage(agentId, message)
     │   └── 消息进入该 Agent 的待处理队列
     │   └── Agent 当前 query loop 完成后自动处理
     │
     └── 多 Agent 场景? → writeToMailbox(agentId, message)
         └── 跨进程通信（Agent Swarms）
```

### 4.3 Agent Resume 机制

```typescript
// src/tools/AgentTool/resumeAgent.ts

resumeAgentBackground(agentId, message):
  1. 读取 sidechain transcript (agentId 的完整历史)
  2. 读取 agent metadata (agentType, worktreePath, description)
  3. 从 transcript 重建:
     - messages: 全部历史消息
     - contentReplacementState: 确保相同的 tool result 替换决策
     - readFileState: 最近访问的文件
  4. 将新 message 追加为 user message
  5. 调用 runAgent() 重新启动 query loop
  6. 完成后 enqueueAgentNotification()

// 为什么需要 contentReplacementState?
//   Claude Code 有一个 tool result 替换优化:
//   如果同一个文件被多次 Read 且内容不变，第二次 Read 会用
//   占位符替换完整内容（节省 token）
//   恢复 Agent 时必须重建这个状态，否则同样的 tool_use_id
//   会有不同的替换决策 → 不同的 wire 前缀 → cache miss
```

### 4.4 结构化的 Agent 间消息

```typescript
// SendMessage 支持结构化消息 (用于 Agent 间协商):

// 终止协商:
{ type: 'shutdown_request', reason: 'work completed' }
{ type: 'shutdown_response', request_id: '...', approve: true }

// 计划审批:
{ type: 'plan_approval_response',
  request_id: '...',
  approve: false,
  feedback: 'need more detail on auth flow' }
```

---

## 5. 完整时序图

### 5.1 同步 Agent

```
Time ─────────────────────────────────────────────────────►

主 Agent                 AgentTool              runAgent/query()      子 Agent
  │                         │                        │                   │
  │── AgentTool(call) ─────►│                        │                   │
  │                         │── runAgent() ─────────►│                   │
  │                         │                        │── query() ───────►│
  │                         │                        │                   │
  │                         │                        │   ┌──────────┐    │
  │                         │                        │   │ Think    │    │
  │                         │                        │   └──────────┘    │
  │                         │                        │◄── tool_use ──────│
  │                         │                        │── tool_result ──►│
  │                         │                        │   ┌──────────┐    │
  │                         │                        │   │ Act      │    │
  │                         │                        │   └──────────┘    │
  │                         │                        │◄── text ─────────│
  │                         │◄── yield msg ──────────│                   │
  │                         │◄── yield msg ──────────│                   │
  │                         │◄── yield final msg ────│                   │
  │                         │                        │                   │
  │◄── { result } ──────────│                        │                   │
  │                         │                        │                   │
  │── 处理结果               │                        │                   │
  │── 继续下一轮 query loop  │                        │                   │
```

### 5.2 异步 Agent + SendMessage

```
Time ─────────────────────────────────────────────────────────────────►

主 Agent           AgentTool      Task System      子 Agent A    SendMessage
  │                   │               │               │               │
  │── AgentTool ─────►│               │               │               │
  │  (background)     │               │               │               │
  │                   │── register ──►│               │               │
  │◄── async_launched │               │── runAgent ──►│               │
  │                   │               │               │               │
  │── 处理其他工作...   │               │   ┌──────────┐│               │
  │                   │               │   │ 研究...   ││               │
  │                   │               │   └──────────┘│               │
  │                   │               │               │               │
  │                   │               │◄── 完成 ──────│               │
  │                   │               │               │               │
  │                   │               │── enqueue ────│               │
  │                   │               │   Notification│               │
  │                   │               │               │               │
  │◄── <task-notif> ──│───────────────│───────────────│               │
  │  (user msg)       │               │               │               │
  │                   │               │               │               │
  │── 阅读结果          │               │               │               │
  │── 决定继续 Agent A  │               │               │               │
  │                   │               │               │               │
  │── SendMessage ────│───────────────│───────────────│──────────────►│
  │  (to: agent-a)    │               │               │               │
  │                   │               │               │ resumeAgent() │
  │                   │               │               │◄── message ───│
  │                   │               │               │               │
  │                   │               │               │   ┌──────────┐│
  │                   │               │               │   │ 继续工作  ││
  │                   │               │               │   └──────────┘│
  │                   │               │               │               │
  │                   │               │◄── 完成 ──────│               │
  │◄── <task-notif> ──│───────────────│───────────────│               │
```

---

## 6. 数据传递方式总结

| 方向 | 机制 | 数据格式 | 时机 |
|------|------|----------|------|
| 主→子 (初始化) | `promptMessages` 参数 | UserMessage[] | Agent 启动时 |
| 主→子 (上下文) | `forkContextMessages` 参数 | Message[] (父历史) | Agent 启动时（可选） |
| 子→主 (同步结果) | `yield` + `tool_result` | AssistantMessage text | 子 Agent 完成时 |
| 子→主 (异步结果) | `enqueueAgentNotification` | `<task-notification>` XML as user msg | 子 Agent 完成/失败时 |
| 子→主 (进度) | `updateProgressFromMessage` | AppState.tasks[id].progress | 子 Agent 运行中 |
| 主→子 (继续) | `SendMessage` + `resumeAgentBackground` | 新 UserMessage 追加 | 任意时刻 |
| 子↔子 (协商) | `SendMessage` (结构化) | shutdown/plan_approval JSON | 任意时刻 |
| 子→子 (跨进程) | `writeToMailbox` | Mailbox message | Agent Swarms |

---

## 7. 从零设计：Agent 消息委派系统

### 7.1 设计目标

1. **异步性**: 主 Agent 不应阻塞等待子 Agent
2. **可恢复性**: 子 Agent 应该可以被继续（SendMessage），而非一次性
3. **可观测性**: 主 Agent 应该知道子 Agent 的状态（运行中/完成/失败）
4. **资源隔离**: 子 Agent 的状态变化不应该污染主 Agent
5. **缓存友好**: 子 Agent 的 API 请求尽量复用主 Agent 的 Prompt Cache

### 7.2 核心抽象

```
┌────────────────────────────────────────────────────────────┐
│                      AgentRuntime                          │
│                                                            │
│  spawn(definition, context, prompt) → AgentHandle          │
│  send(agentId, message) → void                             │
│  stop(agentId) → void                                      │
│  getState(agentId) → AgentState                            │
│                                                            │
│  events:                                                   │
│    onCompletion(agentId, result)                           │
│    onProgress(agentId, progress)                           │
│    onError(agentId, error)                                 │
└────────────────────────────────────────────────────────────┘

AgentHandle {
  id: string
  state: 'pending' | 'running' | 'completed' | 'failed' | 'killed'
  result?: AgentResult
  abort(): void
  send(message): void
}

AgentState = {
  definition: AgentDefinition
  messages: Message[]         // 完整对话历史
  context: RuntimeContext     // 隔离的运行时上下文
  controller: AbortController
}

AgentResult = {
  status: 'completed' | 'failed' | 'killed'
  text: string               // 最终输出文本
  messages: Message[]        // 完整对话记录
  usage: TokenUsage
}
```

### 7.3 消息队列设计

```
主 Agent 的 Inbox:

┌─────────────────────────────────────────────┐
│              Main Agent Inbox               │
│                                             │
│  ┌─────────┐  ┌─────────┐  ┌─────────────┐ │
│  │ User    │  │ Agent   │  │ Agent        │ │
│  │ Message │  │ Notif A │  │ Notif B      │ │
│  └─────────┘  └─────────┘  └─────────────┘ │
│                                             │
│  处理顺序: FIFO                              │
│  每条消息在下一轮 query loop 开始时注入       │
└─────────────────────────────────────────────┘

子 Agent 的 Inbox:

┌─────────────────────────────────────────────┐
│            Agent A's Pending Queue           │
│                                             │
│  ┌──────────────────────────────────────┐   │
│  │ SendMessage from Main:               │   │
│  │ "修復 validate.ts:42 的空指针"       │   │
│  └──────────────────────────────────────┘   │
│                                             │
│  当前 query loop 结束后自动处理下一条        │
└─────────────────────────────────────────────┘
```

### 7.4 状态机

```
         spawn()
            │
            ▼
        ┌─────────┐
        │ pending │──── 启动 query loop ────┐
        └─────────┘                         │
                                            ▼
              ┌── send(message) ────── ┌──────────┐
              │                        │ running  │
              │     ┌──────────────────│          │
              │     │  progress event  └────┬─────┘
              │     │                      │
              ▼     │              ┌───────┼───────┐
         ┌──────────┐             │       │       │
         │ resumed  │       complete  fail    kill
         └──────────┘             │       │       │
              │                   ▼       ▼       ▼
              │              ┌─────────┐ ┌─────┐ ┌──────┐
              └── send() ───►│completed│ │failed│ │killed│
                             └─────────┘ └─────┘ └──────┘
                                   │
                              send(message)
                                   │
                                   ▼
                              ┌─────────┐
                              │ running │  (resume + 继续)
                              └─────────┘
```

### 7.5 隔离机制

```typescript
// 子 Agent 的 RuntimeContext 应该隔离:

interface RuntimeContext {
  // === 独立副本（不共享） ===
  messages: Message[]           // 子 Agent 自己的对话历史
  readFileCache: LRU<string, string>  // 文件读取缓存
  abortController: AbortController    // 独立的取消信号

  // === 只读引用（共享） ===
  systemPrompt: SystemPrompt    // Agent 专属（可 fork 继承）
  tools: Tool[]                 // 过滤后的工具集
  model: string                 // Agent 专属模型

  // === 桥接（有限共享） ===
  enqueueResult(result): void   // 将结果推送到主 Agent inbox

  // === 禁止 ===
  // 不能直接修改主 Agent 的状态
  // 不能控制主 Agent 的 UI
  // 不能访问主 Agent 的对话历史（除非 fork 显式传递）
}
```

### 7.6 简洁实现骨架

```typescript
class AgentRuntime {
  private tasks: Map<string, AgentState> = new Map()
  private inbox: Message[] = []       // 主 Agent 的待处理消息
  private agentQueues: Map<string, Message[]> = new Map()  // 子 Agent 的待处理

  // 启动子 Agent
  async spawn(def: AgentDefinition, prompt: string, context: RuntimeContext): Promise<AgentHandle> {
    const id = generateAgentId()
    const controller = new AbortController()
    const messages = [
      ...(def.inheritContext ? context.parentMessages : []),
      createUserMessage(prompt),
    ]

    const state: AgentState = {
      definition: def,
      messages,
      context: isolateContext(context, def),
      controller,
      status: 'pending',
    }
    this.tasks.set(id, state)

    // 异步执行 query loop
    this.runLoop(id).catch(err => this.handleError(id, err))

    return new AgentHandle(id, controller, this)
  }

  // 子 Agent 的 query loop
  private async runLoop(id: string): Promise<void> {
    const state = this.tasks.get(id)!
    state.status = 'running'

    try {
      const result = await this.executeQueryLoop(state)
      this.complete(id, result)
    } catch (err) {
      this.fail(id, err)
    }
  }

  // 完成 → 通知主 Agent
  private complete(id: string, result: AgentResult): void {
    const state = this.tasks.get(id)!
    state.status = 'completed'
    state.result = result
    this.inbox.push({
      type: 'agent_notification',
      agentId: id,
      status: 'completed',
      text: result.text,
      usage: result.usage,
    })
  }

  // 继续子 Agent（SendMessage）
  send(agentId: string, message: string): void {
    const state = this.tasks.get(agentId)
    if (!state) throw new Error(`Agent ${agentId} not found`)

    if (state.status === 'running') {
      // Agent 正在运行 → 入队等待
      this.getQueue(agentId).push(createUserMessage(message))
    } else {
      // Agent 已完成 → resume
      this.resumeAndContinue(agentId, message)
    }
  }

  // 主 Agent 的下一轮对话
  getNextMessages(): Message[] {
    const pending = this.inbox.splice(0)  // 清空 inbox
    return pending.map(notif =>
      createUserMessage({ content: formatNotification(notif) })
    )
  }
}
```

### 7.7 关键设计决策

| 决策 | Claude Code 的做法 | 为什么 |
|------|-------------------|--------|
| 同步 vs 异步 | 默认双向支持 | 简单任务同步更快，复杂任务异步不阻塞 |
| 结果通知方式 | user message 注入 | 复用现有 query loop，不需要新协议 |
| Agent 可恢复 | 完整 transcript + 状态重建 | 避免每次重做研究 |
| context 传递 | forkContextMessages (可选) | Fork 需要完整上下文，普通 Agent 不需要 |
| 缓存策略 | CacheSafeParams (5 要素一致) | 最大化 API 缓存命中，降低成本 |
| 状态隔离 | 默认隔离 + 显式共享 | 安全优先 |
| 进度报告 | 仅异步 Agent 有 progress | 同步 Agent 主 Agent 正在等待，不需要 |

### 7.8 从简单到完整的演进路径

```
v0 — 最小可用:
  - spawn(def, prompt) → Promise<result>
  - 纯同步，类似函数调用

v1 — 异步支持:
  - spawn(def, prompt, { async: true }) → AgentHandle
  - AgentHandle.on('complete', callback)
  - AgentHandle.on('progress', callback)

v2 — 对话继续:
  - AgentHandle.send(message)
  - agent.resume() + message queue

v3 — 多 Agent 编排:
  - AgentRuntime（全局管理器）
  - Agent 间通信 (SendMessage)
  - task-notification inbox

v4 — 高级特性:
  - Fork (上下文继承 + 缓存共享)
  - Worktree 隔离
  - Coordinator/Worker 角色模型
```
