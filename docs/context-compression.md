# 上下文压缩（Context Compression）设计

> 目标：让会话能「长跑」——多轮对话后既不撞上下文窗口上限、又控制住每轮的
> token 成本，同时**不丢失完整记录**、**恢复会话零重放**。

本文是完整设计 + 详细举例。代码尚未实现，按 §11 分期落地。

---

## 0. 核心思想（一句话）

`session.messages` 是**完整、只追加、永不改**的真相源；每轮发给模型的是它的一个
**投影（projection）**：`system + 外置记忆 + 旧段摘要 + 近段原文`。
投影里**便宜的层每轮现算、贵的产物（摘要）缓存进 JSON**；压缩状态设计成
**看状态、不看历史动作**，所以**恢复零重放**。

记住三句话：

1. **真相源不动，发出去的是投影。**
2. **便宜的每轮算，贵的存 JSON。**
3. **看状态不看动作 → 恢复零重放；触顶靠分级折叠 + 软提示，而非硬重启。**

---

## 1. 为什么需要：从「无状态 API」说起

DeepSeek（OpenAI 兼容）API 是**无状态**的——模型不记任何东西，它「记得」什么
100% 取决于你这一轮发了什么。所以我们每轮都把完整 `messages` 重发一遍。

于是聊得越久：

- **会撞上下文窗口上限**：模型能吃的 token 有上限（记为 `W`），超了直接报错。
- **越来越贵**：每轮 input token 单调增长；而工具输出（`run_bash`、`read_file`）
  动辄几千 token，是最大的吞噬者。

### 举例：token 怎么涨的

一段「让 agent 改代码」的会话，第 8 轮时 `messages` 大概长这样（粗估）：

| # | role | 内容 | ≈tokens |
|---|------|------|--------|
| 0 | system | 工具引导 | 300 |
| 1 | user | 「帮我给 utils.ts 加个 debounce」 | 30 |
| 2 | assistant | tool_calls: read_file(utils.ts) | 20 |
| 3 | tool | utils.ts 全文（带行号，180 行） | **2600** |
| 4 | assistant | tool_calls: edit_file(...) | 60 |
| 5 | tool | 「已编辑」 | 15 |
| 6 | assistant | 「加好了，用法是…」 | 200 |
| 7 | user | 「跑下测试」 | 10 |
| 8 | assistant | tool_calls: run_bash(npm test) | 20 |
| 9 | tool | 测试输出（80 行刷屏 + 结果） | **1800** |
| 10 | assistant | 「测试过了」 | 120 |
| … | | | |

到第 20 轮，光是 #3 那条 read_file（2600 token）和几条 run_bash 输出就占了大头，
而它们**早就没用了**——模型当前根本不需要 10 轮前那次 `npm test` 的逐行输出。
这就是压缩的切入点。

---

## 2. 两层：别把「记录」和「上下文」搞混

| | 是什么 | 压缩时 |
|---|---|---|
| **完整记录** | 真实发生的全部对话（`sessions/<id>.json` / `logs/` / TUI 可上滚） | **永远保留，不删** |
| **上下文窗口** | 每轮**实际发给模型**的那份 messages | **被压缩**（旧的换成摘要/占位） |

所以「压缩后历史还在吗？」的答案：

- 磁盘 / 日志 / 界面里的历史 → **还在**，完整。
- 模型「看得到」的 → 只剩**摘要 + 最近几轮**。原始细节模型确实看不到了（这正是
  压缩的目的），但你和界面没丢。

> 压缩 = 改写「发出去的那份」，**不是删除「存着的那份」**。投影是真相源的临时视图。

---

## 3. 数据模型（session JSON 增量）

```jsonc
{
  "id": "20260629-153000",
  "createdAt": "2026-06-29T15:30:00.000Z",
  "updatedAt": "2026-06-29T16:10:00.000Z",
  "title": "给 utils.ts 加 debounce",

  "messages": [ /* 完整原文，append-only，真相源；§1 那张表的全部 */ ],

  // —— 压缩状态（新增字段）——
  "summaries": [                  // 分段摘要，append-only；每段从原文摘一次
    { "range": [1, 10],  "level": 1,
      "text": "用户要给 utils.ts 加 debounce；read_file 看到该文件 180 行；用 edit_file 在第 42 行插入 debounce 实现；npm test 通过（42 项）。" }
  ],
  "summarizedUpTo": 10,           // messages[1..10] 已被 summaries 覆盖（水位线 k）
  "memory": [                     // 外置关键事实，豁免压缩（可选层）
    "项目用 TypeScript + ESM；模型 deepseek-v4-pro",
    "约定：文件读写改一律用 read_file/write_file/edit_file"
  ],
  "lastPromptTokens": 8421        // 上轮模型实际看到的 prompt token，做触发判据
}
```

> `summarizedUpTo` 其实可由 `summaries` 末段的 `range[1]` 推出，这里显式存只为可读。

### 不变量（Invariants）——实现时必须守住

1. `messages` **永不编辑/删除**（只追加）。
2. `summaries` **只追加**；每段**从原文摘一次、之后不再碰**（分级折叠是例外，见 §7）。
3. `summaries` **连续覆盖** `messages[1..summarizedUpTo]`，无空洞、无重叠。
4. `system` 永远在、**永不压缩**。
5. `messages[summarizedUpTo+1 .. end]`（近段）默认**原文**带上。
6. 任何切割点都落在**轮边界**（无未闭合 tool_calls），`tool_call`/`tool` **永不拆散**。

---

## 4. 投影流水线 `buildContext(session) → Message[]`

每轮发请求前调用，**返回新数组、绝不改 session**：

```
buildContext(session):
  k   = session.summarizedUpTo
  ctx = [ systemMessage ]                    # 层 0：system，永不动

  # 层 C：外置记忆（豁免压缩，始终原样）
  if session.memory.length:
      ctx.push(asSystem("【已知事实】\n" + session.memory.join("\n")))

  # 层 B：旧段摘要（覆盖 messages[1..k]）
  if session.summaries.length:
      ctx.push(asSystem("【早前对话摘要】\n" +
                        session.summaries.map(s => s.text).join("\n")))

  # 近段原文 messages[k+1 .. end]
  recent = session.messages.slice(k + 1)

  # 层 A：裁旧工具输出（只对近段里「较旧且大」的 tool 消息）
  recentStart = 最近 R 轮的起点下标（相对 recent）
  recent = recent.map((m, i) =>
     (m.role === "tool" && i < recentStart && len(m.content) > TRIM_MIN)
        ? { ...m, content: headTail(m.content, m) }   # 头尾保留+省略中间+面包屑
        : m)

  ctx.push(...recent)
  return ctx
```

三层各管一段、互不重叠：

| 层 | 管哪段 | 贵不贵 | 存不存 |
|---|---|---|---|
| C 外置记忆 | 跨全程的关键事实 | 便宜（规则或 LLM 抽取） | 存 `memory` |
| B 段摘要 | `messages[1..k]` | **贵**（LLM） | **存** `summaries` |
| A 裁工具输出 | 近段里较旧的大 tool 消息 | **极便宜**（纯字符串） | **不存**，每轮现算 |

> 「每轮现算」只针对**层 A**（微秒级，相对一次模型调用可忽略）；层 B 的摘要是
> **算一次、缓存、复用很多轮**，不是每轮重算。详见 §6。

---

## 5. 层 A 详解：裁旧工具输出（最划算、最先做）

### 选谁（取交集）

只盯 `role:"tool"` 消息，且**又老又大**才裁：

- **够老**：在「最近 R 轮」之外（如 `R = 3`）；
- **够大**：`content` 超过 `TRIM_MIN`（如 300 字符）才值得裁。

`exit=0` 这种小输出、以及最近刚产生的输出，**都留全**（模型常要靠最近那条接着
干，比如刚 read_file 完正要 edit）。

### 裁成什么：头尾保留 + 面包屑

`run_bash` 的**命令在头、退出码/结果在尾**，中间刷屏才是水分：

**裁之前**（#9，≈1800 token）：

```
$ npm test
> galaude@0.1.0 test
> vitest run

 ✓ src/utils.test.ts (12)
 ✓ src/agent.test.ts (8)
 … 省略 70 行 …
 ✓ src/store.test.ts (5)

 Test Files  6 passed (6)
      Tests  42 passed (42)
   Duration  3.21s
exit=0
```

**裁之后**（≈40 token）：

```
$ npm test
…（中间 78 行已省略；原 1800 字符。需要可重新执行 run_bash）…
 Test Files  6 passed (6)
   Tests  42 passed (42)
exit=0
```

`read_file` 的占位则强调「可重读」：

```
[read_file utils.ts 的 180 行内容已省略（原 2600 字符）。需要可重新 read_file]
```

### 为什么裁 content 比删消息安全得多

`tool_call` / `tool` 必须**成对**（带 tool_calls 的 assistant 后面必须紧跟同
`tool_call_id` 的 tool 消息），否则 API 报错。

- 「滑动窗口删消息」要小心翼翼按整轮删、别切断配对；
- **裁 content 只改文本、不删消息** → 消息数量、`tool_call_id`、顺序全不变 →
  **天然不会破坏配对**。

所以层 A 风险最低，作为压缩第一层。

---

## 6. 层 B 详解：分段摘要（append-only）

### 为什么分段，而不是一条滚动摘要

| | 存什么 | 已摘要的会再摘吗 | 漂移 |
|---|---|---|---|
| 滚动摘要（一条） | 1 串 + 水位线 | `summary_new = LLM(summary_old + 新段)` → **旧摘要每轮回炉** | **会**（摘要的摘要越来越糊） |
| **分段摘要（一组）** | `[{range,text}]` 数组 | **每段从原文摘一次，之后不碰** | **不会** |

分段摘要是 **append-only** 的，**跟 `messages` 一模一样、只增不改**：

```
messages:   [m0, m1, m2, ...]        只追加
summaries:  [seg0, seg1, seg2, ...]  只追加
```

所以「多轮摘要难存」是错觉：**不存摘要链、不存中间过程，就存这个只增不改的数组**，
每段写一次、永不重写。

### 折叠动作（跨 `SUMMARIZE_AT` 阈值时，在轮边界执行一次）

```
compactOnce(session):
  k  = session.summarizedUpTo
  k' = 选一个轮边界（> k），把 messages[k+1..k'] 凑够 CHUNK 大小且不拆 tool 对
  text = LLM.summarize(messages[k+1..k'])         # 唯一一次 LLM 调用
  session.summaries.push({ range:[k+1, k'], level:1, text })
  session.summarizedUpTo = k'
  persist(session)                                 # 摘要 + 水位线落盘
```

要点：从**原文**摘（不漂移）；**稀疏**（十几轮一次）；护缓存（只改写一次前缀，之后稳定）。

### 举例：一次折叠前后

**折叠前**，发给模型的投影（近段全是原文，很长）：

```
system
user: 帮我加 debounce
assistant(tool_calls: read_file)
tool: <utils.ts 180 行>           ← 2600 token
assistant(tool_calls: edit_file)
tool: 已编辑
assistant: 加好了…
user: 跑测试
assistant(tool_calls: run_bash)
tool: <npm test 80 行>            ← 1800 token
assistant: 测试过了
user: 再加个 throttle          ← 当前轮
```

`prompt_tokens` 冲过 `SUMMARIZE_AT`。`compactOnce` 把 `messages[1..10]`（debounce
那整段）摘成一条 `summaries[0]`，水位线 `k=10`。

**折叠后**，下一轮投影变成：

```
system
[早前对话摘要]: 用户给 utils.ts 加 debounce；读了 180 行；edit 在第 42 行插入；npm test 42 项通过。
user: 再加个 throttle           ← 近段（k 之后）原文
…
```

2600 + 1800 + … 几千 token 被压成一条 ~60 token 的摘要。**而 `messages` 原文一字未动**。

---

## 7. 触顶与分级折叠（把墙推到几乎无限）

纯 append-only 的段会一直涨，有**理论天花板**。救生圈是**分级折叠**：

```
Level 0: 原始 messages
Level 1: 段摘要（从原文摘，各一次）
Level 2: 元摘要（把旧的若干 L1 段再摘成一条）
Level 3: ...
```

当 `summaries` 自身涨到 `FOLD_AT`（如占预算 30%），把最老的若干 `level:1` 段
LLM 再摘成一条 `level:2`，数组前部收缩。形成一棵树，**容量上几乎无上限**
（像 LSM-tree / B 树，每级把下一级再压一截）。

### 真正的墙是「保真度」，不是「容量」

压缩有损，每折一级丢一截信息。折到三四级，元摘要就糊成「用户聊了个项目很久」——
**早期对话等于失忆**。所以：

- **总能塞下**（折得更狠就行），但到某点**塞进去也没用了**——继续这个 session
  跟开新的没区别。
- 因此**不硬停、不强制重启**，而是 §9 的软提示 + §8 的外置记忆把墙推远。

---

## 8. 层 C：外置记忆（把「丢了会痛」的东西保护住）

真正怕丢的（决定、文件路径、用户偏好、约定）**别交给摘要去管**——抽到 `memory`
数组，**豁免压缩**、始终原样带上。这样即使早期对话被折糊了，关键事实也不丢。

抽取可以：

- **规则**：把 user 明确说「记住 X」的内容入 memory；
- **LLM**：折叠时顺便让模型吐出「值得长期记住的事实」放进 memory。

**举例**：用户第 2 轮说「以后所有金额都保留两位小数」。这条进 `memory`，于是哪怕
第 50 轮、早期对话全被折叠，这条约定仍原样在每轮上下文里，模型不会「忘」。

---

## 9. 触发参数 & UX

判据用**上轮 `usage.prompt_tokens`**（= 投影实际大小，正好是要控的量），与模型
窗口 `W` 的比例（数值可调）：

```
TRIM_AT      = 0.50 * W   # 近段开始裁工具输出（层 A 生效）
SUMMARIZE_AT = 0.70 * W   # 把近段最老一块折进摘要（层 B，一次 LLM）
FOLD_AT      = summaries 自身 > 0.30 * W   # 二级折叠（§7）
WARN_AT      = fold 层级 ≥ 2 或 投影/W > 0.85   # 软提示用户
```

> 层 A 是纯函数、随便算；其实可一直开，阈值只是「省得近段没必要时也裁」。
> 层 B 的折叠**只在跨 `SUMMARIZE_AT` 时做一次**，稀疏。

UX：

- **软提示**：到 `WARN_AT` 时插一条 note：`⚠️ 对话很长，早期内容已重度压缩，可
  /new 开聚焦会话`。**建议而非强制**。
- **状态可见**：标题栏显示 `ctx 71%（压缩中）`。
- **`/compact`**（可选）：手动触发一次折叠。

---

## 10. 恢复（`--resume` / `/resume`）：零重放

```
load: messages（完整） + summaries + summarizedUpTo + memory + lastPromptTokens
之后: buildContext(session) 直接可用
```

**为什么不用一轮轮重放压缩？** 因为压缩状态是

```
当前投影 = f(完整 messages, 存着的 summaries, 水位线 k, memory)
```

这四样恢复时**都现成有**——直接套函数算出来，**不回放历史上每一次压缩动作**：

- **摘要**：虽增量生成（路径依赖），但**存的是最终结果**，已把过去所有增量活儿固化。
- **裁剪**：纯函数，恢复时一遍扫完（微秒），也不是「一轮轮模拟」。

> 反例：若**不存**摘要，恢复时为拿回压缩态就得把每次摘要**重新调一遍模型**，又慢又
> 花钱。所以「贵的产物存进 JSON」不只省每轮的钱，更让**恢复从 O(轮数次模型调用)
> 变成 O(1) 读盘**。

TUI 仍用完整 `messages` 铺历史（已有 `messagesToItems`）；发给模型的是投影。二者分离、互不影响。

---

## 11. 缓存（prompt cache）分析

DeepSeek 的缓存是**前缀缓存**：messages 前缀不变才命中（你日志里的
`prompt_cache_hit_tokens` 就是它）。

- **投影前缀**（system + memory + summaries）在两次折叠之间**稳定** → 持续命中。
- **一次折叠/裁剪**会改写历史中间某条 → 那条往后的前缀这一轮失效（**一次性 miss**），
  之后又稳定。

所以策略是**「按阈值触发、别每轮压」**：压一次、稳一阵。频繁重摘 = 缓存一直 miss，
可能比不压还贵。

---

## 12. 边界 case

1. **tool 配对**：切割点（摘要 chunk 边界、近段起点）只在「无未闭合 tool_calls」的
   轮边界，绝不在 assistant(tool_calls) 与其 tool 结果之间切。
2. **单条超大**（一坨巨型 bash 输出 / 用户粘超长文本）：**执行/接收时就截断**
   （`run_bash` 限 4000 字符、`read_file` 限 400 行，已实现）。这是「单条上限」，
   跟会话压缩两码事，不靠重启解决。
3. **当前在飞的这一轮**（本轮 user + 正在跑的 tool 循环）**永不压**。
4. **system 永不压**。
5. **全量进日志**：in-context 可压，但 `logs/run-*.log` 留完整原文，压缩出 bug 能复盘。

---

## 13. 代码落点

- `store.ts`：`StoredSession` 加 `summaries / summarizedUpTo / memory / lastPromptTokens`。
- 新 `compress.ts`：
  - `buildContext(session) → Message[]`（层 A/B/C 组装）
  - `headTail(content)`（层 A 头尾占位）
  - `shouldCompact(session) → boolean`、`compactOnce(session)`（层 B）
  - `turnBoundaries(messages)`（找不拆 tool 对的切割点）
- `agent.ts`：
  - `Session` 运行时结构同步加上述字段。
  - `streamModel`：发请求改成发 `buildContext(session)`，**不再直接发 `session.messages`**。
  - `runAgent`：把本轮 `usage.prompt_tokens` 写回 `session.lastPromptTokens`；
    在轮边界 `if (shouldCompact(session)) await compactOnce(session)`；`persist` 带上新字段。
- `ui.tsx`：标题栏 ctx 占比 + `WARN_AT` 软提示；可选 `/compact`。

---

## 14. 分期落地

| 期 | 做什么 | 动 JSON 吗 | 验证点 |
|---|---|---|---|
| **P1** | 层 A 裁工具输出 + `buildContext` 骨架 + 标题栏 ctx 占比 | 否 | 投影机制通、恢复零重放、缓存不乱 |
| **P2** | 层 B 分段摘要（`shouldCompact`/`compactOnce`）+ 字段落盘 | 加 `summaries/summarizedUpTo/lastPromptTokens` | 折一次省 token、恢复直接读摘要 |
| **P3** | 分级折叠 + 软提示 + 外置 `memory` | 加 `memory` | 触顶不崩、关键事实不丢 |

> 先做 **P1**：零 JSON 改动、零 LLM、纯投影，把地基和「投影不入库 / 恢复不重放」
> 这套机制验证扎实，再叠 P2/P3。

---

## 附：术语速查

- **真相源（source of truth）**：`session.messages`，完整、只追加、永不改。
- **投影（projection）**：每轮实际发给模型的 messages，由真相源临时算出。
- **水位线（watermark）`k`**：`messages[1..k]` 已被摘要覆盖。
- **折叠（compaction/fold）**：把一段原文（或旧摘要）摘成更短的摘要。
- **面包屑（breadcrumb）**：裁剪/省略后留下的「这是什么 + 可重取」提示，防幻觉。
