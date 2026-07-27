# Claude Code 并发模型：线程 / 进程 / 协程

> 源码模块: `src/utils/Shell.ts`, `src/utils/abortController.ts`, `src/tasks/`, `src/tools/shared/spawnMultiAgent.ts`

---

## 1. 核心结论

Claude Code 是 **单进程 + 事件循环** 模型：

```
┌────────────────────────────────────────────────────────────────┐
│                    Node.js 主进程                               │
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │                    Event Loop                             │ │
│  │                                                          │ │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐               │ │
│  │  │ 主 Agent  │  │ 子 Agent │  │ 子 Agent │  ← 协程      │ │
│  │  │ query()   │  │ query()  │  │ query()  │     (async)  │ │
│  │  │ (async)   │  │ (async)  │  │ (async)  │               │ │
│  │  └──────────┘  └──────────┘  └──────────┘               │ │
│  │       │              │              │                     │ │
│  │       ▼              ▼              ▼                     │ │
│  │  ┌──────────────────────────────────────────────────┐    │ │
│  │  │           AbortController Tree (WeakRef)          │    │ │
│  │  │     parent → child → child → ... (弱引用链)       │    │ │
│  │  └──────────────────────────────────────────────────┘    │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │                   Task Registry                           │ │
│  │  AppState.tasks = {                                      │ │
│  │    'agent-a1b': { type:'local_agent', status:'running' },│ │
│  │    'bash-x9y0': { type:'local_bash',  status:'running' },│ │
│  │    'teammate-z3':{ type:'in_process_teammate', ... },    │ │
│  │  }                                                        │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │  child_process.spawn() — OS 级子进程                      │ │
│  │  ├── Bash 命令 (每次一个独立进程)                          │ │
│  │  ├── Git 操作 (execFileNoThrow)                           │ │
│  │  └── Hooks / Skills (外部脚本)                            │ │
│  └──────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────┘

┌──────────────────────┐  ┌──────────────────────┐
│   Tmux Pane (进程)    │  │  Remote CCR (机器)    │
│                       │  │                       │
│  claude --agent-id .. │  │  claude (远程)        │
│  独立 Node.js 进程    │  │  独立进程 + 网络通信   │
│                       │  │                       │
│  通过 Mailbox 通信     │  │  通过 WebSocket 通信   │
└──────────────────────┘  └──────────────────────┘
```

---

## 2. 三层并发模型

### 2.1 第一层：Async 协程（Event Loop 内）

**这是 Claude Code 最主要、最核心的并发方式。**

```
主 Agent (async generator)      子 Agent A (async generator)    子 Agent B (async IIFE)
       │                                │                              │
       ├─ query() ──────────────────┐   │                              │
       │   for await (msg of ...)   │   │                              │
       │                            │   │                              │
       │   ┌──────────┐             │   │                              │
       │   │ API 请求  │─── await ───┼───┤ (事件循环空闲)               │
       │   └──────────┘             │   │                              │
       │                            │   ├─ query() ─────────────────┐  │
       │   ◄── 响应返回 ────────────┘   │  for await (msg of ...)   │  │
       │   ┌──────────┐                 │                          │  │
       │   │ 工具调用  │                 │  ┌──────────┐             │  │
       │   │ AgentTool│────────────────►│  │ API 请求  │─── await ──┼──┤
       │   └──────────┘                 │  └──────────┘             │  │
       │                                │                          │  │  ├─ query()
       │   ┌──────────┐                 │                          │  │  │  ...
       │   │ 处理结果  │                 │  ◄── 响应 ───────────────┘  │  │
       │   └──────────┘                 │  ┌──────────┐               │  │
       │                                │  │ 工具调用  │               │  │
       │                                │  └──────────┘               │  │
       │   ...继续...                   │  ...继续...                 │  │  ...继续...
```

**核心机制**：
- 所有 Agent 的 `query()` 都是 `AsyncGenerator`
- Node.js Event Loop 在各 async task 的 `await` 点之间切换
- 每个 Agent 都是**独立的 async 上下文**（不共享闭包中的可变状态）
- 通过 `createSubagentContext()` 确保状态隔离

### 2.2 第二层：child_process（OS 级子进程）

**每次 Bash 工具调用都会创建一个 OS 进程。**

```typescript
// src/utils/Shell.ts:316
const childProcess = spawn(spawnBinary, shellArgs, {
  env: { ...subprocessEnv(), SHELL, GIT_EDITOR: 'true', ... },
  cwd,
  stdio: ['pipe', outputHandle?.fd, outputHandle?.fd],
  detached: provider.detached,
  windowsHide: true,
})

// 关键点:
// 1. spawn() — 非阻塞，异步返回
// 2. detached — Bash 子进程可能独立于父进程（后台任务）
// 3. stdio pipe — 通过 pipe 捕获输出
// 4. 信号处理通过 tree-kill 确保子进程组全部终止
```

**Bash 执行的生命周期**:

```
Agent 调用 Bash Tool
  │
  ├── spawn(bash, ['-c', command])
  │   └── 返回 ChildProcess 对象
  │
  ├── wrapSpawn(childProcess, abortSignal, timeout, taskOutput)
  │   ├── 注册 abortListener → tree-kill 子进程
  │   ├── 设置 timeout → 超时自动 kill
  │   ├── 连接 stdio → TaskOutput 文件/内存
  │   └── 返回 ShellCommand (Promise-based)
  │
  ├── 同步 (foreground):
  │   └── await shellCommand.result → 阻塞当前 Agent 的协程
  │
  └── 异步 (background / run_in_background):
      └── 注册到 AppState.tasks → 不阻塞，Agent 继续
```

**非 AI 交互的子进程**（`execFileNoThrow`）：

```typescript
// 通过 execa (基于 child_process)
// git status, git log, git branch, which, 等
// 大量使用: context.ts (git status), concurrentSessions.ts, spawnMultiAgent.ts
execFileNoThrow('git', ['--no-optional-locks', 'status', '--short'])
  → execa(git, args, { reject: false })
  → Promise.resolve({ stdout, stderr, code })
```

### 2.3 第三层：Tmux / 远程（独立进程/机器）

**Agent Swarms / Teammate 模式**:

```
主进程 (Leader)                     Tmux Pane (Teammate)
┌──────────────────┐              ┌──────────────────────┐
│ claude (REPL)    │              │ claude --agent-id ..  │
│                  │              │                      │
│ spawnTeammate()  │  tmux        │ 启动时从 mailbox 读取  │
│   ├── tmux       │  split-window│ 初始 prompt           │
│   │   split-window│────────────►│                      │
│   │              │              │ query loop           │
│   ├── write to   │  File-based  │                      │
│   │   mailbox    │  Mailbox     │ 完成后 → mailbox      │
│   │              │◄─────────────│                      │
│   └── AppState   │              │ 独立:                 │
│       .tasks[id] │              │  - 自己的 Node 进程   │
│                  │              │  - 自己的 Event Loop  │
│                  │              │  - 自己的 AbortController│
└──────────────────┘              └──────────────────────┘
```

**In-Process Teammate（中间态）**:

```
主进程 (Leader)
┌──────────────────────────────────────┐
│  Event Loop                          │
│                                      │
│  ┌────────┐  ┌───────┐  ┌────────┐  │
│  │ Leader │  │ Teamm │  │ Teamm  │  │
│  │ query()│  │ query()│  │ query()│  │  ← 同进程, 不同 async context
│  └────────┘  └───────┘  └────────┘  │
│                                      │
│  通过 AppState 共享任务注册表          │
│  通过 Mailbox 通信(进程内)            │
└──────────────────────────────────────┘
```

---

## 3. 取消信号层次 (AbortController Tree)

```
              Root (用户 ESC / 进程退出)
                │
                ▼
        ┌───────────────┐
        │  主 Agent      │
        │  abortController│
        └───────┬───────┘
                │ createChildAbortController()
        ┌───────┼───────┬───────────┐
        ▼       ▼       ▼           ▼
    Sync     Fork    Async A     Async B
    Agent    Agent   (独立)      (独立)
    (继承)   (继承)  (不继承)    (不继承)
```

**关键设计** (`abortController.ts`):

```typescript
// src/utils/abortController.ts

// 父→子传播 (WeakRef 防止内存泄漏)
createChildAbortController(parent):
  child = new AbortController()
  parent.signal.addEventListener('abort', () => child.abort())
  // 父 abort → 子 abort
  // 子 abort ⇏ 父 abort (单向)

// WeakRef 设计:
// - 父通过 WeakRef 持有子 → 子可以被 GC（如果所有强引用丢失）
// - 父 abort 时，如果子还存在 → 传播 cancel
// - 子 abort 时，从父移除 listener → 防止 handler 堆积

// 同步 Agent → 共享父 abortController → ESC 一起取消
// 异步 Agent → 独立 abortController → ESC 不影响后台 Agent
// Fork Agent → createChildAbortController(parent) → ESC 传播到 fork
```

---

## 4. 任务系统 (Task Registry)

所有并发执行的任务都注册在 `AppState.tasks` 中：

```typescript
// AppState.tasks: Record<string, TaskState>

type TaskState =
  | LocalShellTaskState     // type: 'local_bash'      — Bash 命令
  | LocalAgentTaskState     // type: 'local_agent'     — 子 Agent
  | RemoteAgentTaskState    // type: 'remote_agent'    — 远程 CCR Agent
  | InProcessTeammateTaskState // type: 'in_process_teammate' — 进程内队友
  | LocalWorkflowTaskState  // type: 'local_workflow'  — 工作流
  | MonitorMcpTaskState     // type: 'monitor_mcp'     — MCP 监控
```

**任务生命周期**:

```
registerTask() → status: 'pending'
     │
     ▼
start → status: 'running'
     │
     ├── complete → status: 'completed' (result available)
     ├── fail    → status: 'failed'    (error available)
     └── kill    → status: 'killed'    (aborted)
```

**并发上限**:

```typescript
// Agent 并发上限（在 workflow.ts 中）
// min(16, os.cpus().length - 2) — 每 workflow 最多 16 个并发 agent
// 总共 1000 个 agent 上限（防止 runaway loop）

// Bash 并发: 无硬限制（受限于 OS 资源）
// 但 streaming tool executor 区分读写操作:
//   - 只读工具 (Glob, Grep, Read) → 并行执行
//   - 写入工具 (Bash, Edit, Write)  → 串行执行
```

---

## 5. 基于 event loop 的完整并发分析

### 5.1 什么"阻塞" Event Loop

| 操作 | 是否阻塞 | 说明 |
|------|----------|------|
| `await query()` | ❌ 不阻塞 | async generator, Event Loop 可切换 |
| `await shellCommand.result` | ❌ 不阻塞 | 基于 Promise + child_process |
| `for await (msg of generator)` | ❌ 不阻塞 | await 点让出控制权 |
| `analyzeContext()` (同步遍历消息) | ⚠️ 微阻塞 | ~11ms on 4500 messages, 被推迟到 compact 之后 |
| `getGitStatus()` (子进程) | ❌ 不阻塞 | execa 基于 child_process |
| `tokenCountWithEstimation()` | ⚠️ 微阻塞 | 同步字符串遍历, O(n) |
| JSON 序列化/反序列化 | ⚠️ 微阻塞 | 用 `slowOperations.ts` 包装, 记录性能 |

### 5.2 并发安全保证

```
操作类型          并发模型                 安全保证
──────────────────────────────────────────────────────
Bash 命令         OS 进程                 进程隔离, 文件系统由 OS 保护
只读工具          Event Loop 协程         无状态冲突 (只读)
写入工具          串行化 Event Loop        StreamingToolExecutor 串行队列
子 Agent          Async IIFE              createSubagentContext 状态隔离
Fork Agent        Async IIFE              共享父 cache, 隔离可变状态
Tmux Teammate     独立 OS 进程            进程隔离, 文件系统 + Mailbox
In-Process Tm     Async Context           AsyncLocalStorage 隔离
```

### 5.3 进程 vs 线程的选择

Claude Code **没有使用** Worker Threads。原因很明显：

1. **Node.js 是单线程的** — 本身就适合 I/O 密集而非 CPU 密集任务
2. **核心 workload 是 API 调用** — HTTP 请求是纯 I/O, 不消耗 CPU
3. **Bash 工具调用是子进程** — 天然进程隔离
4. **状态隔离可以用 async context** — 不需要线程级别隔离
5. **避免序列化开销** — 如果消息在 thread 间传递, 需要结构化克隆
6. **调试简单** — 单线程无 race condition (JS 层面)

---

## 6. 从零设计：Agent 并发系统

### 6.1 选型分析

```
┌──────────────────────────────────────────────────────────────────┐
│                      并发模型对比                                  │
│                                                                   │
│  模型            适用场景                Agent 系统的适用性         │
│  ─────────────────────────────────────────────────────────────   │
│  Worker Threads  CPU 密集 (解析, 压缩)   ❌ Agent 主要做 I/O      │
│  Child Process   需要 OS 级别隔离        ✅ Bash/Shell            │
│  Async/Await     I/O 密集, 高并发        ✅ Agent query loops     │
│  Cluster         多核利用率              ❌ Node.js 本身单线程     │
│  Tmux/Multi-Proc 跨机器, 独立 UI         ✅ Team 模式             │
└──────────────────────────────────────────────────────────────────┘
```

**最佳组合**: Async/Await (协程) + Child Process (Shell) + Multi-Process (Team)

### 6.2 协程调度模型

```typescript
// 简洁实现: 基于 AsyncGenerator 的 Agent 运行时

class AgentScheduler {
  private agents: Map<string, AgentContext> = new Map()
  private concurrencyLimit: number

  constructor(limit = 10) {
    this.concurrencyLimit = limit
  }

  // 启动 Agent (不阻塞调用者)
  spawn(def: AgentDef, prompt: string): AgentHandle {
    const id = generateId()
    const ctx = this.createContext(def, prompt)

    // 如果已达并发上限, 入队等待
    if (this.runningCount >= this.concurrencyLimit) {
      this.pendingQueue.push({ id, ctx })
    } else {
      this.startAgent(id, ctx)  // fire-and-forget
    }

    return new AgentHandle(id, this)
  }

  // 启动 Agent 的 query loop (非阻塞)
  private startAgent(id: string, ctx: AgentContext): void {
    this.agents.set(id, { status: 'running', ctx })

    // IIFE — 不阻塞 spawn() 的调用者
    ;(async () => {
      try {
        for await (const msg of this.runQueryLoop(ctx)) {
          ctx.messages.push(msg)
          this.emitProgress(id, msg)
        }
        this.complete(id, ctx.messages)
      } catch (err) {
        this.fail(id, err)
      } finally {
        this.cleanup(id)
        this.dispatchNext()  // 调度下一个等待的 Agent
      }
    })()
  }

  // 并发控制
  private get runningCount(): number {
    return [...this.agents.values()].filter(a => a.status === 'running').length
  }

  private dispatchNext(): void {
    if (this.pendingQueue.length > 0 && this.runningCount < this.concurrencyLimit) {
      const { id, ctx } = this.pendingQueue.shift()!
      this.startAgent(id, ctx)
    }
  }
}
```

### 6.3 取消传播

```typescript
// 基于 AbortController 的树形取消

class CancelTree {
  private parent: CancelTree | null
  private controller: AbortController
  private children: Set<WeakRef<CancelTree>> = new Set()

  constructor(parent?: CancelTree) {
    this.parent = parent ?? null
    this.controller = new AbortController()

    if (parent) {
      // 父取消 → 子取消
      parent.controller.signal.addEventListener('abort', () => this.abort())
      // 子取消 → 从父解除注册
      this.controller.signal.addEventListener('abort', () => {
        parent.children.delete(new WeakRef(this))
      })
    }
  }

  fork(): CancelTree {
    const child = new CancelTree(this)
    this.children.add(new WeakRef(child))
    return child
  }

  abort(reason?: string): void {
    this.controller.abort(reason)
  }

  get signal(): AbortSignal {
    return this.controller.signal
  }
}

// 使用:
const root = new CancelTree()  // 用户 ESC → root.abort()

// 同步子 Agent → 共享 root (ESC 一起取消)
const syncAgent = root  // 不 fork

// 异步子 Agent → fork (独立)
const asyncAgent = root.fork()  // root.abort() 不影响 asyncAgent

// Fork Agent → fork (父取消传播到 fork)
const forkAgent = root.fork()   // root.abort() → forkAgent.abort()

// 主进程退出 → root.abort() → 传播到所有非独立的子 Agent
```

### 6.4 进程隔离 (Bash/Shell)

```typescript
// Shell 命令 → OS 进程

async function runShell(command: string, signal: AbortSignal): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', ['-c', command], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    })

    let stdout = '', stderr = ''

    child.stdout.on('data', chunk => stdout += chunk)
    child.stderr.on('data', chunk => stderr += chunk)

    child.on('close', code => resolve({ code, stdout, stderr }))
    child.on('error', reject)

    // 取消 → kill 进程组
    signal.addEventListener('abort', () => {
      child.kill('SIGTERM')
      // 确保子进程也终止:
      setTimeout(() => child.kill('SIGKILL'), 3000)
    })
  })
}
```

### 6.5 从简单到完整的演进

```
v0 — 纯同步:
  result = await runAgent(prompt)
  // 一次只能运行一个 Agent

v1 — 异步协程:
  handle = scheduler.spawn(prompt)  // fire-and-forget
  // 多个 Agent 并发在同一个 Event Loop

v2 — 任务注册表:
  AppState.tasks[agentId] = { status, progress, result }
  // 可查询 Agent 状态

v3 — 取消传播:
  CancelTree: root → sync share, async fork
  // 精细化的取消控制

v4 — 进程隔离:
  ChildProcess for Bash
  Tmux for Teammates
  // OS 级别隔离

v5 — 远程:
  CCR for Remote Agents
  // 跨机器扩展
```

---

## 7. 总结

| 维度 | Claude Code 的选择 | 原因 |
|------|-------------------|------|
| **主运行时** | Node.js 单进程 + Event Loop | I/O 密集, 不需要多线程 |
| **Agent 并发** | Async/Await 协程 (AsyncGenerator) | 天然并发, 无锁, 调试简单 |
| **Shell 执行** | `child_process.spawn()` | OS 进程隔离, POSIX 兼容 |
| **取消模型** | AbortController Tree + WeakRef | 父子链, 单向传播, 内存安全 |
| **Team 模式** | Tmux 独立进程 + Mailbox 通信 | 完全进程隔离 + 独立 UI |
| **In-Process Team** | 同进程 + AsyncLocalStorage | 性能最优 (无 IPC 开销) |
| **并发上限** | min(16, cpus-2) per workflow | 防止资源耗尽 |
| **状态隔离** | Async Context (闭包) | 不用序列化, 不用锁 |
