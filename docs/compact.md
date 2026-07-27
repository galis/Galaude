# Claude Code 上下文压缩策略与机制分析

> 源码来源: [galis/claude-code](https://github.com/galis/claude-code)  
> 核心模块: `src/services/compact/`, `src/commands/compact/`, `src/utils/context.ts`

---

## 1. 总体架构

Claude Code 的上下文压缩是一个**多层分级系统**，从轻量级到重量级共 6 个层次：

```
层次                           触发条件                         API 开销
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
L1: API Context Management    每次 API 请求前自动              零（服务端处理）
L2: Cached MicroCompact       每次 API 请求前自动              零（cache_edits 机制）
L3: Time-Based MicroCompact   空闲 >60 分钟触发                零（仅修改本地消息）
L4: Session Memory Compact    Token 触及阈值自动               零（复用预计算摘要）
L5: Full Compact              自动 / 手动 / 413 错误触发       一次 API 调用
L6: Reactive Compact          API 返回 prompt-too-long 时      一次 API 调用（紧急收缩）
```

每个层次的核心文件：

```
src/services/compact/
├── compact.ts                  # L5: Full Compact 核心 (1706行)
├── autoCompact.ts              # 自动压缩触发与阈值计算
├── prompt.ts                   # 压缩 Prompt 模板
├── grouping.ts                 # API-round 消息分组
├── microCompact.ts             # L2/L3: 微压缩 (Cached + Time-Based)
├── apiMicrocompact.ts          # L1: API 原生 Context Management
├── sessionMemoryCompact.ts     # L4: Session Memory 压缩
├── compactWarningState.ts      # 压缩警告状态管理
├── postCompactCleanup.ts       # 压缩后缓存清理
├── timeBasedMCConfig.ts        # 时间基准 MC 配置
├── cachedMicrocompact.ts       # Cached MC 内部实现
├── reactiveCompact.ts          # L6: 反应式压缩
├── compactMessages.ts          # 消息裁剪工具
└── compactWarningHook.ts       # 压缩警告 Hook

src/commands/compact/
├── compact.ts                  # /compact 手动命令入口
└── index.ts

src/utils/context.ts            # 上下文窗口大小计算
```

---

## 2. 上下文窗口模型

### 2.1 窗口大小

```typescript
// src/utils/context.ts
export const MODEL_CONTEXT_WINDOW_DEFAULT = 200_000  // 默认 200K

// Sonnet 4.6 / Opus 4.6 支持 1M context
//   方式1: 模型名带 [1m] 后缀 → 1_000_000
//   方式2: GrowthBook 实验 coral_reef_sonnet=true → 1_000_000
//   方式3: 服务端 beta header CONTEXT_1M_BETA_HEADER
```

### 2.2 有效窗口与预算分配

```
上下文窗口 (contextWindow)
│
├── maxOutputTokens 预留         (20K — p99.99 compact 输出 = 17,387 tokens)
├── AUTOCOMPACT_BUFFER           (13K — 自动压缩缓冲)
├── WARNING_THRESHOLD_BUFFER     (20K — 警告阈值缓冲)
├── ERROR_THRESHOLD_BUFFER       (20K — 错误阈值缓冲)
└── MANUAL_COMPACT_BUFFER        (3K  — 阻塞前最后防线)
```

关键计算 (`autoCompact.ts`):

```typescript
// 有效窗口 = contextWindow - outputReserved(20K)
export function getEffectiveContextWindowSize(model: string): number {
  const reservedTokensForSummary = Math.min(
    getMaxOutputTokensForModel(model),
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,  // 20_000
  )
  let contextWindow = getContextWindowForModel(model, getSdkBetas())
  // 可通过 CLAUDE_CODE_AUTO_COMPACT_WINDOW 限制
  return contextWindow - reservedTokensForSummary
}

// 自动压缩阈值 = 有效窗口 - 13K
export function getAutoCompactThreshold(model: string): number {
  return getEffectiveContextWindowSize(model) - AUTOCOMPACT_BUFFER_TOKENS // 13_000
}
```

以 200K 窗口为例：
- 有效窗口: `200K - 20K = 180K`
- 自动压缩阈值: `180K - 13K = 167K`
- 警告阈值: `180K - 20K = 160K`
- 阻塞限制: `180K - 3K = 177K` (防止压缩后立即再触发)

### 2.3 Token 计数策略

`tokenCountWithEstimation` 混合使用两种方式：
- **精确计数**: 从 API 响应取 `usage.input_tokens`
- **估算**: `roughTokenCountEstimation` — 按 ~4 chars/token 粗略估算，乘以 4/3 安全系数

---

## 3. L1: API Context Management（API 原生上下文管理）

**文件**: `apiMicrocompact.ts`

利用 Claude API 的 `context_management` 能力，将压缩逻辑下沉到服务端：

### 3.1 策略一: `clear_tool_uses_20250919`

清除旧的工具调用和结果：

```typescript
{
  type: 'clear_tool_uses_20250919',
  trigger: { type: 'input_tokens', value: 180_000 },  // 触发阈值
  clear_at_least: { type: 'input_tokens', value: 140_000 }, // 至少清除量
  clear_tool_inputs: [  // 只清除这些工具的 input（保留 output）
    'Bash', 'Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'
  ],
}
```

工具分类：
- **可清除结果的工具** (`TOOLS_CLEARABLE_RESULTS`): Bash, Read, Grep, Glob, WebSearch, WebFetch — 保留工具调用本身，只清除结果内容
- **可清除调用的工具** (`TOOLS_CLEARABLE_USES`): FileEdit, FileWrite, NotebookEdit — 整个工具调用+结果都清除

### 3.2 策略二: `clear_thinking_20251015`

保留/清理 thinking block：

```typescript
{
  type: 'clear_thinking_20251015',
  keep: 'all',  // 保留所有 thinking（默认）
  // 或 keep: { type: 'thinking_turns', value: 1 }  // 缓存过期时只保留最近 1 轮
}
```

`keep: 'all'` 确保 thinking block 始终被保留（thinking 对工作质量很重要）。

### 3.3 开关控制

- `USE_API_CLEAR_TOOL_RESULTS` 环境变量
- `USE_API_CLEAR_TOOL_USES` 环境变量
- 仅 ant 用户可用

---

## 4. L2: Cached MicroCompact（缓存微压缩）

**文件**: `microCompact.ts`, `cachedMicrocompact.ts`

### 4.1 核心机制

利用 Claude API 的 **cache_edits** 能力：

- **不修改**本地消息内容
- 在 API 请求层附加 `cache_edits` 指令，标记删除某些 tool_result
- 服务端**直接从缓存中移除**对应的 content block
- 缓存前缀不受影响，后续请求继续命中

### 4.2 工作流程

```
1. 遍历所有消息，收集 compactable 工具调用的 tool_use_id
      ↓
2. 注册每个 new tool_result 到 cachedMCState
      ↓
3. getToolResultsToDelete() 根据阈值判断哪些需要删除
      ↓
4. createCacheEditsBlock() 生成 cache_edits 指令
      ↓
5. consumePendingCacheEdits() → 在下一次 API 请求中附加
      ↓
6. API 响应后，从 usage.cache_deleted_input_tokens 获取实际删除量
```

### 4.3 可压缩工具

```typescript
const COMPACTABLE_TOOLS = new Set([
  FILE_READ_TOOL_NAME,   // Read
  ...SHELL_TOOL_NAMES,   // Bash
  GREP_TOOL_NAME,        // Grep
  GLOB_TOOL_NAME,        // Glob
  WEB_SEARCH_TOOL_NAME,  // WebSearch
  WEB_FETCH_TOOL_NAME,   // WebFetch
  FILE_EDIT_TOOL_NAME,   // Edit
  FILE_WRITE_TOOL_NAME,  // Write
])
```

### 4.4 安全限制

- 仅主线程执行 (`isMainThreadSource`) — 防止 forked agent 污染全局状态
- 仅支持的模型启用 (`isModelSupportedForCacheEditing`)
- 可通过 GrowthBook 远端配置 `cachedMCConfig.triggerThreshold` 和 `keepRecent`

---

## 5. L3: Time-Based MicroCompact（时间基准微压缩）

**文件**: `microCompact.ts:446-530`, `timeBasedMCConfig.ts`

### 5.1 触发条件

```typescript
// 距上一条 assistant 消息的时间 > gapThresholdMinutes (默认 60 分钟)
const gapMinutes = (Date.now() - lastAssistantTimestamp) / 60_000
if (gapMinutes >= config.gapThresholdMinutes) {
  // 触发!
}
```

**原因**: 服务器 prompt cache 的 TTL 约为 1 小时。60 分钟以上的空闲意味着缓存必然已过期，下一次 API 请求会重写全量前缀。此时提前清除旧数据可以**缩减需要重写的前缀大小**。

### 5.2 执行方式

```typescript
// 保留最近 keepRecent 条（默认 5 条）compactable tool result
// 将其余旧 tool result 的 content 替换为:
const TIME_BASED_MC_CLEARED_MESSAGE = '[Old tool result content cleared]'
```

### 5.3 副作用处理

```typescript
// 重置 cached MC 的 module-level 状态
// （因为本地消息内容已变，cached MC 追踪的 tool ID 已失效）
resetMicrocompactState()

// 通知 prompt cache break 检测器
// （下一轮 cache read 会下降，但这并非真实 break）
notifyCacheDeletion(querySource)
```

### 5.4 配置 (GrowthBook `tengu_slate_heron`)

```typescript
{
  enabled: false,            // 主开关（默认关闭）
  gapThresholdMinutes: 60,   // 空闲阈值
  keepRecent: 5              // 保留最近条数
}
```

---

## 6. L4: Session Memory Compact（会话记忆压缩）

**文件**: `sessionMemoryCompact.ts`

### 6.1 前置条件

后台持续运行的 **SessionMemory 提取进程** 将对话结构化摘要写入 `session_memory` 文件。压缩时直接读取这个预计算摘要，**零 API 开销**。

### 6.2 工作流程

```
1. 检查 Feature Flag (tengu_session_memory && tengu_sm_compact)
   ↓
2. 等待 session memory 提取完成 (waitForSessionMemoryExtraction)
   ↓
3. 读取 session_memory 文件内容
   ↓  (空或模板 → 回退到 Full Compact)
4. calculateMessagesToKeepIndex():
   ├── 从 lastSummarizedMessageId 之后开始保留
   ├── 向后扩展直到 ≥ minTokens (10K) 且 ≥ minTextBlockMessages (5)
   ├── 上限 ≤ maxTokens (40K)
   └── adjustIndexToPreserveAPIInvariants() — 不切断 tool pairs
   ↓
5. 构建 CompactionResult:
   ├── boundaryMarker (auto 类型)
   ├── summaryMessages (来自 session memory)
   ├── messagesToKeep (保留的最近消息)
   ├── planAttachment (如有 plan 文件)
   └── hookResults (SessionStart hooks)
   ↓
6. 验证 postCompactTokenCount < autoCompactThreshold
   (防止压缩后立即可再触发)
```

### 6.3 消息保存策略

```typescript
// 默认配置
const DEFAULT_SM_COMPACT_CONFIG = {
  minTokens: 10_000,          // 最少保留 10K tokens
  minTextBlockMessages: 5,    // 最少保留 5 条有文本的消息
  maxTokens: 40_000,          // 最多保留 40K tokens
}
```

### 6.4 API 不变量保护

`adjustIndexToPreserveAPIInvariants()` 确保不切断：

1. **tool_use / tool_result 对** — 如果保留的消息包含 tool_result，向前回溯找到匹配的 tool_use
2. **thinking block** — 如果保留的 assistant 消息与前面的 assistant 消息共享同一 `message.id`（streaming 分片），合并它们

```
修复前:                       修复后:
[assistant, id:X, thinking]  [assistant, id:X, thinking]  ← 回溯包含
[assistant, id:X, tool_use]  [assistant, id:X, tool_use]  ← startIndex
[user, tool_result]          [user, tool_result]
↑ startIndex 在这里
如果没有修复 → thinking block 丢失 → API 错误
```

### 6.5 开关控制

- `ENABLE_CLAUDE_CODE_SM_COMPACT` 环境变量（强制启用，用于测试）
- `DISABLE_CLAUDE_CODE_SM_COMPACT` 环境变量（强制禁用）
- GrowthBook: `tengu_session_memory` + `tengu_sm_compact`

---

## 7. L5: Full Compact（完整压缩）

**文件**: `compact.ts` — 核心函数 `compactConversation()`（387-763行）

### 7.1 触发条件

**自动触发** (`autoCompactIfNeeded`):

```typescript
// autoCompact.ts
const tokenCount = tokenCountWithEstimation(messages) - snipTokensFreed
const threshold = getAutoCompactThreshold(model)

if (tokenCount >= threshold) {
  // → autoCompactIfNeeded()
}
```

**手动触发**: 用户执行 `/compact` 或 `/compact <custom instructions>`

**递归守卫**:
```typescript
// 这些 querySource 不触发自动压缩（会导致死锁）
if (querySource === 'session_memory') return false
if (querySource === 'compact') return false
if (querySource === 'marble_origami') return false  // context collapse agent
```

**熔断器**: 连续 3 次自动压缩失败后停止重试
```typescript
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3
```

### 7.2 完整执行流程

```
┌─────────────────────────────────────────────────────────┐
│  1. 前置检查                                              │
│     ├── messages.length === 0 → 报错                     │
│     └── preCompactTokenCount = tokenCountWithEstimation   │
├─────────────────────────────────────────────────────────┤
│  2. PreCompact Hooks                                      │
│     └── 合并 hook 返回的 customInstructions               │
├─────────────────────────────────────────────────────────┤
│  3. 压缩 API 调用                                         │
│     ├── 优先: Forked Agent (缓存共享)                      │
│     │   ├── system prompt + tools + model 一致 → 缓存命中  │
│     │   ├── maxTurns: 1, canUseTool: deny                │
│     │   ├── thinkingConfig: disabled                     │
│     │   └── skipCacheWrite: true                         │
│     │                                                     │
│     ├── 回退: Streaming API 调用                           │
│     │   ├── 工具集: [FileRead] 或 [FileRead, ToolSearch]  │
│     │   ├── systemPrompt: "summarizing conversations"    │
│     │   ├── maxOutputTokensOverride: min(20K, modelMax)   │
│     │   └── retry: 最多 2 次 (tengu_compact_streaming_retry)│
│     │                                                     │
│     └── PTL 重试: compact 请求本身 prompt-too-long       │
│         ├── truncateHeadForPTLRetry() 逐组删除最旧消息    │
│         └── 最多 MAX_PTL_RETRIES=3 次                     │
├─────────────────────────────────────────────────────────┤
│  4. 上下文重建（并行执行）                                  │
│     ├── 清除 readFileState / loadedNestedMemoryPaths     │
│     ├── createPostCompactFileAttachments()                │
│     │   ├── 最多 5 个最近访问文件                          │
│     │   ├── 每个 ≤ 5K tokens                              │
│     │   └── 总计 ≤ 50K tokens                             │
│     ├── createSkillAttachmentIfNeeded()                   │
│     │   ├── 每个 skill ≤ 5K tokens                        │
│     │   └── 总计 ≤ 25K tokens                             │
│     ├── createPlanAttachmentIfNeeded()                    │
│     ├── createPlanModeAttachmentIfNeeded()                │
│     ├── createAsyncAgentAttachmentsIfNeeded()             │
│     ├── getDeferredToolsDeltaAttachment() (完整重发)       │
│     ├── getAgentListingDeltaAttachment() (完整重发)        │
│     └── getMcpInstructionsDeltaAttachment() (完整重发)     │
├─────────────────────────────────────────────────────────┤
│  5. SessionStart Hooks                                    │
├─────────────────────────────────────────────────────────┤
│  6. 后处理                                                │
│     ├── 构建 boundaryMarker + summaryMessages             │
│     ├── reAppendSessionMetadata()                         │
│     ├── 写入 session transcript segment (KAIROS)         │
│     └── PostCompact Hooks                                 │
├─────────────────────────────────────────────────────────┤
│  7. 日志与监控                                             │
│     ├── logEvent('tengu_compact', ...)                    │
│     ├── 记录: pre/post token count, cache hit rate, 等    │
│     └── analyzeContext() → 对话内容分类统计                │
└─────────────────────────────────────────────────────────┘
```

### 7.3 Prompt 设计

**摘要 Prompt** (`prompt.ts`) 采用高度结构化的模板，要求 9 个 sections：

```
1. Primary Request and Intent    — 用户的显式请求
2. Key Technical Concepts        — 技术概念、框架
3. Files and Code Sections       — 文件 + 完整代码片段
4. Errors and fixes              — 错误与修复方式
5. Problem Solving               — 已解决/进行中的问题
6. All user messages             — 所有非工具结果的用户消息
7. Pending Tasks                 — 明确要求的待办项
8. Current Work                  — 压缩前正在做什么（精确到文件+代码）
9. Optional Next Step            — 下一步 + 对话原文引用
```

**指令技巧**:

```xml
<!-- Analysis 块作为草稿便签，提升摘要质量 -->
<analysis>
[详细的思维过程...]
</analysis>

<summary>
1. Primary Request and Intent:
   ...
</summary>
```

- `<analysis>` 在 `formatCompactSummary()` 中被**移除** — 它是写作辅助，不进入最终上下文
- `<summary>` XML 标签被替换为可读标题 `"Summary:"`

**严格禁用工具**:

```
CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.
- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
```

### 7.4 图片处理

`stripImagesFromMessages()` — 将用户消息中的 image/document block 替换为 `[image]` / `[document]` 文本占位符。图片 token 量大且对摘要无用，移除可防止 compact 请求自身触发 prompt-too-long。

```typescript
// 也会处理嵌套在 tool_result 中的图片
if (block.type === 'tool_result' && Array.isArray(block.content)) {
  // 替换嵌套图片/文档为文本标记
}
```

### 7.5 Prompt Cache 共享策略

Forked Agent 的缓存共享是最关键的优化：

```
主线程 API 请求:
  system_prompt + tools + context_messages → 服务端缓存

Forked Agent (compact):
  system_prompt + tools + context_messages → ↑ 相同前缀 → 缓存命中!
```

- `skipCacheWrite: true` — 不污染缓存（compact 是一次性的）
- `thinkingConfig: { type: 'disabled' }` — 摘要不需要 thinking overhead
- 如果 forked agent 失败，回退到 streaming 路径（走独立请求）

```typescript
// 实验数据（代码注释）:
// 不走缓存共享的路径有 98% 缓存未命中率
// 缓存共享路径节省 ~0.76% 舰队 cache_creation（~38B tok/day）
```

### 7.6 消息分组策略

**文件**: `grouping.ts`

```typescript
export function groupMessagesByApiRound(messages: Message[]): Message[][]
```

按 **API round-trip** 分组，而不是按人类对话轮次：

- 使用 `assistant.message.id` 作为边界标记
- 同一次 API 响应的 streaming chunks 共享同一个 `id` → 不会被切断
- 允许在单轮 agentic session（SDK/CCR）中正确分组

**为什么重要**: 在 agentic 场景中，一次用户输入可能触发多轮工具调用（数十次 API round），如果按人类轮次分组，一次 "round" 可能包含整个 session。

### 7.7 PTL (Prompt Too Long) 重试

`truncateHeadForPTLRetry()` — 当 compact 请求本身触发 prompt-too-long 时：

```typescript
// 按 API-round 分组
const groups = groupMessagesByApiRound(messages)

// 从最旧开始删除组，直到覆盖 tokenGap
let acc = 0
for (const g of groups) {
  acc += roughTokenCountEstimationForMessages(g)
  dropCount++
  if (acc >= tokenGap) break
}

// 至少保留一组用于摘要
dropCount = Math.min(dropCount, groups.length - 1)

// 如果 group 0 被删除（preamble），插入合成标记维持 API 契约
// (API 要求第一条消息必须是 role=user)
```

---

## 8. L6: Reactive Compact（反应式压缩）

**文件**: `reactiveCompact.ts`（ant-only, feature flag `REACTIVE_COMPACT`）

### 8.1 触发条件

API 返回 prompt-too-long 错误时触发（proactive autocompact 没能及时拦截）。

### 8.2 与 Proactive Compact 的区别

| 维度 | Proactive (L5) | Reactive (L6) |
|------|----------------|---------------|
| 触发方 | Token 计数阈值 | API 返回错误 |
| 压缩策略 | 整段一次摘要 | 从尾部逐组收缩 |
| 摘要内容 | 全部历史 | 只压缩被移除的部分 |
| 上下文保留 | 最多 5 个文件 | 保留尾部最近消息 |

### 8.3 后缀保留策略

```
messages: [G0, G1, G2, G3, G4, G5, G6, G7]
                            ↑ 最近
如果 G6+G7 已经 > PTL 阈值:
  → 移除 G0-G5, 只对 G0-G5 做摘要
  → G6+G7 原样保留
如果 G6+G7 仍 > PTL 阈值:
  → 继续移除 G7, G6... 直到剩余能放入窗口
```

---

## 9. Partial Compact（部分压缩）

**文件**: `compact.ts:772-1106` — `partialCompactConversation()`

用户可以在 Transcript 中选中一条消息，执行部分压缩：

### 9.1 两种方向

| 方向 | 行为 | Prompt Cache |
|------|------|-------------|
| `'from'` | 压缩选中消息**之后**的部分，保留前面的 | 需发送全部消息 |
| `'up_to'` | 压缩选中消息**之前**的部分，保留后面的 | 前缀不变 → 缓存命中 |

### 9.2 'up_to' 模式的特殊处理

```typescript
// 清除保留消息中的旧 compact boundary/summary
// 否则 findLastCompactBoundaryIndex 的向后扫描会命中旧边界
const messagesToKeep = allMessages
  .slice(pivotIndex)
  .filter(m =>
    m.type !== 'progress' &&
    !isCompactBoundaryMessage(m) &&
    !(m.type === 'user' && m.isCompactSummary),
  )
```

### 9.3 Relink Metadata

```typescript
// boundary 上附加 preservedSegment 元数据
// 用于 transcript loader 重建正确的链表关系
boundary.compactMetadata.preservedSegment = {
  headUuid: keep[0].uuid,     // 保留段第一条
  anchorUuid,                  // 锚点（boundary 或 summary）
  tailUuid: keep.at(-1).uuid, // 保留段最后一条
}
```

---

## 10. 后压缩清理

**文件**: `postCompactCleanup.ts`

```typescript
export function runPostCompactCleanup(querySource?: QuerySource): void {
  resetMicrocompactState()           // 重置 cached MC 状态
  // context-collapse 重置（仅主线程）
  getUserContext.cache.clear?.()     // 下一次请求重新加载 CLAUDE.md
  resetGetMemoryFilesCache('compact')// 重置 memory file 缓存
  clearSystemPromptSections()        // 清除系统 prompt 片段
  clearClassifierApprovals()         // 清除权限分类器缓存
  clearSpeculativeChecks()           // 清除投机检查
  clearBetaTracingState()            // 清除 beta 追踪
  clearSessionMessagesCache()        // 清除消息缓存
}
```

**子代理保护**: 子代理（`agent:*`）的 querySource 不以 `repl_main_thread` 开头，因此不会重置主线程的模块级状态（如 context-collapse, memory file cache）。

---

## 11. Token 估算体系

### 11.1 估算函数

```typescript
// 粗略估算: ~4 chars/token
function roughTokenCountEstimation(text: string): number

// 精确计数: 从 API response usage
function tokenCountFromLastAPIResponse(messages: Message[]): number

// 混合: 优先精确, 回退估算
function tokenCountWithEstimation(messages: Message[]): number
```

### 11.2 tool_result 的 Token 计算

```typescript
function calculateToolResultTokens(block: ToolResultBlockParam): number {
  // text content → roughTokenCountEstimation
  // image/document → 固定 2000 tokens (IMAGE_MAX_TOKEN_SIZE)
  // 数组 → 逐一累加
}
```

### 11.3 安全系数

```typescript
// estimateMessageTokens 最后乘以 4/3 作为安全系数
return Math.ceil(totalTokens * (4 / 3))
```

---

## 12. 开关与环境变量

| 环境变量 | 作用 |
|----------|------|
| `DISABLE_COMPACT` | 禁用所有压缩（auto + manual） |
| `DISABLE_AUTO_COMPACT` | 仅禁用自动压缩 |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | 限制有效上下文窗口大小 |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | 覆盖自动压缩触发百分比 (1-100) |
| `CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE` | 覆盖阻塞限制值 |
| `CLAUDE_CODE_DISABLE_1M_CONTEXT` | 禁用 1M 上下文（HIPAA） |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` | 手动限制上下文窗口 (ant-only) |
| `ENABLE_CLAUDE_CODE_SM_COMPACT` | 强制启用 Session Memory Compact |
| `DISABLE_CLAUDE_CODE_SM_COMPACT` | 强制禁用 Session Memory Compact |
| `USE_API_CLEAR_TOOL_RESULTS` | 启用 API 服务端 tool result 清除 |
| `USE_API_CLEAR_TOOL_USES` | 启用 API 服务端 tool use 清除 |
| `API_MAX_INPUT_TOKENS` | API MC 触发阈值 |
| `API_TARGET_INPUT_TOKENS` | API MC 目标保留量 |

---

## 13. 监控与遥测

### 13.1 关键事件

```typescript
// 完整压缩
logEvent('tengu_compact', {
  preCompactTokenCount,
  postCompactTokenCount,       // compact API 调用的总 token 使用量
  truePostCompactTokenCount,   // 压缩后上下文的实际 token 估算
  willRetriggerNextTurn,       // 压缩后是否下一轮会立即再触发
  isAutoCompact,
  compactionCacheReadTokens,
  compactionCacheCreationTokens,
  promptCacheSharingEnabled,
  // ... analyzeContext() 的对话分类统计
})

// 其他事件:
// tengu_compact_failed         — 压缩失败
// tengu_compact_ptl_retry     — PTL 重试
// tengu_compact_cache_sharing_success  — 缓存共享成功
// tengu_compact_cache_sharing_fallback — 缓存共享回退
// tengu_partial_compact       — 部分压缩
// tengu_sm_compact_*          — Session Memory 压缩
// tengu_cached_microcompact   — Cached MC
// tengu_time_based_microcompact — 时间基准 MC
```

### 13.2 电路保护

```typescript
// 连续失败 3 次 → 停止自动压缩
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3

// PTL 重试最多 3 次
const MAX_PTL_RETRIES = 3

// Streaming 回退重试最多 2 次
const MAX_COMPACT_STREAMING_RETRIES = 2

// 后台 Agent 心跳间隔
const ACTIVITY_INTERVAL_MS = 30_000
```

---

## 14. 设计哲学总结

```
┌──────────────────────────────────────────────────────────┐
│                   分层防御 (Defense in Depth)              │
│                                                           │
│  L1-L3: "零开销" 压缩                                      │
│  ├── API 原生 Context Management（服务端处理）              │
│  ├── Cached MC（cache_edits 机制，不破坏缓存）              │
│  ├── Time-Based MC（利用缓存已过期的事实）                   │
│  └── Session Memory Compact（复用预计算摘要）                │
│                                                           │
│  L4-L6: "有开销" 压缩（最后手段）                           │
│  ├── Full Compact（额外 API 调用 + Prompt Cache 共享）     │
│  ├── Partial Compact（用户精确控制范围）                    │
│  └── Reactive Compact（紧急收缩，AP I错误恢复）             │
│                                                           │
│  关键原则:                                                 │
│  ├── Prompt Cache 优先 — 能不破坏就不破坏                  │
│  ├── 状态恢复 — 压缩后重建完整工作上下文                    │
│  ├── 熔断器 — 防止失败级联                                 │
│  └── 可观测性 — 每个决策点都有遥测                         │
└──────────────────────────────────────────────────────────┘
```
