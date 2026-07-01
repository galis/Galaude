# Galaude 任务清单（todo）设计文档

> 状态：**设计中**。决策逐个敲定，敲定前不写代码。
> 方法：每个承重决策 → 列选项/权衡 → 决定 → 反方攻击 → 修订 → 记录。

## 1. 目标（一句话）

模型在执行**多步任务**时，自己维护的一份**进度清单**：模型用工具读写它，
系统**每轮把它回注上下文**（模型始终看得见自己的计划），用户侧顺带得到一个**进度面板**。

**不是**"用户用 `/todo add` 维护的个人待办管理器"。→ 模型驱动，非用户驱动。

## 2. 场景 trace（一次用户输入的内部轨迹）

```
用户: "帮我加个 X 功能"                      ← 用户轮开始
  turn 1: 回注✔ → 模型 → todowrite 建清单[A,B,C] + 读文件
  turn 2: 回注✔ → 模型 → 改文件 + todowrite 标 A=done,B=doing
  turn 3: 回注✔ → 模型 → 跑测试（没调 todowrite，但清单仍被回注）
  turn 4: 回注✔ → 模型 → 无 tool_call，给最终回答 → break
```

要点：**回注**每个内部轮都发生（系统做）；**模型调 todowrite** 只在要改计划时（模型做）。

## 3. 承重决策清单（逐个敲定）

- [x] **D1** 定位 / 谁驱动 —— **锁定：模型驱动**
- [x] **D2** 写 API —— **锁定：A 全量替换（+ 三处加固）**
- [x] **D3** 工具状态放哪 / 签名 —— **锁定：两张分类型注册表（pureTools / statefulTools）**
- [x] **D4** 数据模型 —— **锁定：`{ id, content, status }` + nextId 计数器**
- [x] **D5** in_progress —— **锁定：软约定；默认『最多一个』（软归一执行，删归一即放开）**
- [x] **D6** 失败处理 —— **锁定：失败模式汇总 + 升级=冻结旧表、非终态、交回用户**
- [x] **D7** 回注注入点 + durability —— **锁定：注入点=记忆/摘要后·近段前·豁免压缩；temp+rename（独立 commit）**
- [x] **D8** UI 进度面板 —— **锁定：hybrid（标题栏一行 `📋 done/total` 常驻 + 详情变化入流）**

## 4. 决策记录

### D1 定位 —— 锁定：模型驱动
模型用工具读写、系统每轮回注、用户旁观进度面板。排除"用户 slash 命令维护的个人待办"。无异议锁定。

### D2 写 API —— 锁定：A 全量替换（+ 三处加固）
**选项**：A 全量替换（每次发完整表、直接覆盖） vs B 增量 id 补丁。
**选 A 理由**：幂等；无 read-modify-write 窗口 → 免掉一整类竞态；模型只描述"现状"、不用跨轮记账。
**被攻击 → 修订**：
- **攻击①「内容改写漂移」**：模型重抄整表时把 content 改了词 → 认不出是同一项。
  - 加固：① **回注**本身防大头——模型"照着眼前回注的清单抄"、非凭记忆重建，可见文本抄写 LLM 很稳；
    ② 每项带**稳定 id**，id **活在回注的清单里**、模型照抄回来（≠ B：B 要模型自己管理 id 状态；这里 id 只是贴着的标签，系统分配）。新增项无 id → 系统分配下一个。
  - 收益：按 id 配对即可区分"改状态"与"新增"；同 id 内容大改 → 记软警告（不硬拦）。
- **攻击②「输出截断 → 残表覆盖好表」**：截断产物结构合规，语法校验拦不住。
  - 加固：上游用 `streamModel` 返回的 `finishReason` 检测。`finishReason==="length"` 且本轮有 todowrite
    → 判定已知不可信，**写入前直接丢弃这次调用**（连校验都不做），旧表纹丝不动；令模型"发更小的更新"再来。
- **攻击③「每次重发全表 = 浪费贵的输出 token」**：
  - 接受为已知代价：表本就小（一把项）、状态翻转偶发非每轮，输出增量可忽略，不加护栏。
**级联**：D4 数据模型必须含 `id`（+ nextId 计数器）；D6 复用"脏输入 → 重试≤3 → 升级用户"阶梯。

### D4 数据模型 —— 锁定：`{ id, content, status }` + nextId
`id:number`（系统分配的稳定标签，见 D2/F2）、`content:string`、`status:"pending"|"in_progress"|"completed"`。
计划对象上挂 `nextId` 计数器给新增项发号。**不要** dependsOn/result/blocked（以后要再加）。

### D3 工具状态放哪 / 签名 —— 锁定：两张分类型注册表
`pureTools: (args)=>string`（calculate/read_file/run_bash/write_file/edit_file，纯净签名、碰不到会话）；
`statefulTools: (args, ctx)=>string`（todoread/todowrite），`ctx = { session, emit, finishReason }`。
循环按"在哪张表"分派，无 if 链，加新的有状态工具零改动。
**理由**：兼得统一分派（B）与最小权限/纯净可证（A）；类型说真话——一眼看出谁能碰 session、谁并发安全；为日后"能力/权限分层"留接缝。
**衍生**：① 截断自守——todowrite 读 `ctx.finishReason==="length"` 自行拒写（F1 不必在循环特判）；② 与 `needsApproval` 正交（另一条能力轴，按工具名）；todo 两工具不入 needsApproval。

### D8 UI 面板 —— 锁定：hybrid（一行常驻 + 详情入流）
最可逆/纯装饰 → 取最简能用。标题栏/spinner 附近一行 `📋 done/total` **常驻**；todos 变化时把详情**印进消息流**（复用 note 渲染）。用户侧图标 `☑/⟳/☐`（BMP，避开 emoji 宽度坑），模型侧 `[x]/[~]/[ ]`。以后需要再升级到常驻大面板（选项 2）。

**补充（/todo 命令）**：加只读 `/todo`（= `/todo list`）按需打印当前清单（标题栏只有计数、详情会滚走，需要一个"再看一眼"入口）。**不做** `/todo add/rm`——那会重开 D1（变用户驱动）、与模型全量替换成两写者冲突（模型下次覆盖可能静默删掉用户加的项、或复活用户删的项）。用户要增删 → **用聊天让 agent 代劳**（单一 owner 不破，且已有此通道）。真要"用户自己的待办管理器"是另一个功能（独立清单+面板），不与 agent 草稿本混用。

### D7 回注注入点 + 落盘 durability —— 锁定
**(a) 注入点**：`buildContext` 里 todo 消息置于 `[记忆][摘要]` 之后、`[近段]` 之前，独立 `system` 消息，豁免压缩（同 memory 每轮必带）。紧贴近段 → 清单变动不击穿更靠前的缓存。
**(b) durability**：采纳 **temp+rename**（写 `<id>.json.tmp` 再原子 rename）→ 崩溃时旧档完好或新档完整、绝无半截文件。**作为独立 commit**，不与 todo 改动混同——它保护整个 session 文件、与 todos 无关，属相邻独立改进（避免范围蔓延、缩小单次爆炸半径）。

### D6 失败处理 —— 锁定：失败模式汇总 + 升级语义
D6 由 D2/D3/D5 + F1–F4 自然拼成，不引入新机制：截断→拒写保旧表(F1)；漂移→id 认领+存档为准+软警告(F2)；脏输入→重试≤3→升级(F3)；多 in_progress→软归一(D5)；分派→fail fast(F4)。
**升级语义**：连续 3 次脏输入 → **冻结在最后一个好状态**（旧表不动）+ 输出一句提示 + 决定权交回用户。**非终态**——不硬停 agent，旧表仍每轮回注，模型下轮可自行改小重试；"交回用户"只停掉本次重试循环、把情况摆上台面，不设硬性"必须用户操作"闸。
**原则**：失败时冻在最后一个好状态，不猜、不乱改。

### D5 in_progress 约束 —— 锁定：软约定，默认『最多一个 in_progress』
**分类**：软约定。违反不崩、系统照跑；"必须唯一"只在把 in_progress 定义成"唯一焦点"时才出现 → 随定义/实现而变 → 不是从外部强加的硬约束。
**选择**：默认 at-most-one（本 agent 线性推理、无后台任务，单点焦点更稳、面板更清爽）。
**执行**：软归一——多个 in_progress 时保留第一个、其余降级 `pending`，在 todowrite 返回里说明（模型下轮自纠）；不 throw、不打回。
**可逆**：政策非律 —— 删掉归一那段循环即放开为"允许多个"，其余逻辑不动。

## 5. 失败模式清单

- **F1 输出截断**：todowrite 被 max-output 截断 → 残表。**检测** `finishReason==="length"`（上游、免费）；**处置** 丢弃本次写入、保旧表、令模型发更小更新；连续失败走 F3 阶梯。
- **F2 内容/id 漂移**：content 与 id **都是模型 echo 的、都可能被改**——id 不"防止"漂移，而是把它从【无声/无界/不可修】变成【罕见/可检测/可自愈】。**机制**：系统持有 `id↔content` 真值。① id 对 content 漂 → 以存档 content 为准 → **自愈**（代价：content 按 id 冻结，改词走 remove+add）；② id 非法/不在已知集 → 检测出 → 走 F3；③ id/content 配对与存档不符 → 软警告（疑似串号）。回注使漂移本就罕见。**残余**：漂成另一个合法 id 且 content 也像 → 靠 ③ 的交叉核对兜。**原则**：无状态模型里拿不到"绝对不可改"，目标是可观测 + 爆炸半径可控。
- **F3 脏输入**：status 非法 / 少字段 / JSON 坏。**处置** 结构校验不过 → 请模型重发，最多 3 次 → 仍不行升级用户（保旧表，让用户决定：继续 / 放弃 / 手动）。
- **F4 分派完整性**：每个 `toolSchemas` 声明的工具须恰好落在 pureTools / statefulTools 之一。两表都有=歧义，都没有=运行时分派失败。**处置** 启动时校验键集（并集=声明集、两表不相交），不一致 fail fast。

## 6. 落地范围与顺序

**范围（v1）**：模型驱动 todo——`todoread`/`todowrite` 两工具、两张分类型注册表、id 身份 + 全量替换、软归一单 in_progress、回注注入、hybrid UI。**不做**：dependsOn/blocked/result、用户 slash 命令、常驻大面板（选项 2）。

**提交结构**（D7：durability 独立）：
- **Commit A｜feat: todo 清单**：todo.ts/store/compress/tools/agent/ui 一组，功能本身。
- **Commit B｜chore: 会话落盘 temp+rename**：仅 store.ts 写盘机制，与 A 无关、单独一 commit。

**实现顺序**（数据 → 注入 → 工具 → 接线 → UI）：
1. **`todo.ts`（新）**：`Todo` 类型；`renderTodos()`（模型侧 `[x]/[~]/[ ]`）；`normalizeTodos(prev, incoming)`（校验 → 软归一单 in_progress → 按 id 认领/存档为准自愈 → 新增项发号）。纯函数、无依赖 → 叶子模块。
2. `store.ts`：`StoredSession.todos?`、`todoNextId?`（import `Todo`）。
3. `compress.ts`：`CompressState.todos`；`todoMessage()`（包 renderTodos 成 system 消息）；`buildContext` 注入（记忆/摘要后 · 近段前 · 豁免压缩）。
4. `tools.ts`：`todoread`/`todowrite` schema；拆 `pureTools`/`statefulTools`；`ctx={session,emit,finishReason}`；handler（校验→normalizeTodos→截断自守→emit→返回 renderTodos）；键集 fail-fast。
5. `agent.ts`：Session 挂 `todos`/`todoNextId`（create/resume/persist）；循环按两表分派、组 ctx、传 finishReason；`AgentEvent` 加 `todos`；SYSTEM_PROMPT 加一句。
6. `ui.tsx`：收 `todos` 事件；标题栏一行 `📋 done/total`；详情变化印入流。
7. **（独立 commit B）** `store.ts`：saveSession 改 temp+rename。

**验证**：`npm run typecheck` 过；跑一个多步任务看模型是否建/更新清单、面板是否刷新、`--resume` 后清单还在。
