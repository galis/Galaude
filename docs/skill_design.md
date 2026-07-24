# Galaude Skill 机制设计文档

> 状态：**已实现**。
> 方法：每个承重决策 → 列选项/权衡 → 决定 → 反方攻击 → 修订 → 记录。

---

## 1. 目标（一句话）

Skill = **可命名的 system prompt 扩展片段**。为 agent 提供可切换的「工作模式」（代码审查、调试、重构…），渐进式披露——先看有哪些，需要时才加载完整 prompt 注入上下文。

**不是**「插件系统」或「自定义工具」——skill 只影响提示词，不引入新能力。它重用现有工具集，但改变模型的行为姿态。

---

## 2. 设计灵感来源

参考 Claude Code 的 Slash Commands（`.claude/commands/*.md`），但方向不同：

| Claude Code | Galaude Skill |
|------------|---------------|
| 用户手动敲 slash 命令触发 | **模型自主发现并激活**（渐进式披露两阶段） |
| 文件放在项目目录 `.claude/` | 文件放在 `~/.galaude/skills/`（用户级，跨会话）和 `src/skills/`（内置） |
| 每个命令 = 一个 `.md` | 同样：一个 skill = 一个 `.md` |

---

## 3. 核心设计：渐进式披露（三层）

### 第一层：发现（始终注入）

`buildContext` 在**每轮**上下文里始终注入一条轻量 skill 列表，模型无需调用任何工具就能看到所有可用 skill：

```
【可用 Skills】review, debug, refactor, commit | 用 skillactivate <name> 激活 | skillread 查看详情
```

开销：~20 token/skill，即使 50 个 skill 也仅 ~1K token。`skillread` 工具保留作为「手动刷新 / 查看详情」用，但发现不依赖模型的主动工具调用。

### 第二层：激活（按需加载）

模型调用 `skillactivate` 激活一个或多个 skill 后，完整 prompt 以 system 消息注入上下文。激活语义为**并集**：新激活不踢掉已有的。关闭用 `skilldeactivate`。

### 第三层：扩展文件（按需读取）

每个 skill 目录下可放 `references/` 子目录。skill 的 prompt 正文中可引用相对路径（如 `见 ./references/forms.md`），模型用现有 `read_file` 工具自行读取——不占用激活时的一次性上下文。



---

## 4. 承重决策

### D1 文件格式：Markdown + Frontmatter

```
---
description: 代码审查：读取代码、分析问题、给出改进建议
invocation: both          # model / user / both（默认 both）
allowed-tools:            # 可选：限制可用工具白名单，空=全部可用
---

你处于「代码审查」模式。审查代码时遵循：

1. **先理解完整上下文**：用 read_file 读取相关文件
2. **检查潜在 bug**：空指针、边界条件、资源泄漏
...
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `description` | 必填 | 发现层展示用，一行话（约 20 字） |
| `invocation` | 可选（默认 `both`） | `model`=仅模型可触发，`user`=仅手动 `/skill` 触发，`both`=两者都可 |
| `allowed-tools` | 可选 | 工具白名单限制（预留），对齐 Claude Code 同级字段命名 |
| `prompt`（正文） | 必填 | 激活后注入上下文的完整提示片段 |

`tools` 别名向后兼容：如果 frontmatter 中有 `tools` 但没有 `allowed-tools`，自动映射。

### D2 目录结构：扁平即为扁平，子目录即为分类

```
src/skills/                  ← 内置（项目自带）
  review.md                  ← /skill review
  debug.md                   ← /skill debug
  refactor.md                ← /skill refactor
  commit.md                  ← /skill commit

~/.galaude/skills/           ← 用户自定义
  code/
    review.md                ← /skill code/review（覆盖内置 review）
    format.md                ← 用户自己加的
    references/              ← 第三层：扩展参考文件
      style-guide.md         ← body 中可引用 ./references/
  project/
    my-convention.md         ← /skill project/my-convention
```

**规则**：
- 文件名去 `.md` 后缀即为 skill 名
- 子目录用 `/` 连接：`code/review.md` → skill 名 `code/review`
- 目录即分类，天然组织
- `references/` 子目录：存放大量示例、边界情况说明等，skill body 引用相对路径（`./references/xxx.md`），模型用现有 `read_file` 工具按需读取，不占用激活时上下文

### D3 优先级：用户 > 内置

`skillactivate("review")` 查找路径：

1. `~/.galaude/skills/review.md` → 命中，停止
2. `src/skills/review.md` → 内置兜底
3. 都没找到 → throw，错误回喂模型

**为什么**：用户自定义覆盖内置，和 memory 机制一致——用户可定制任何内置 skill。

### D4 首次启动：内置 skill 自动复制

`ensureUserSkills()` 在 `createSession()` 时调用（幂等，已有则跳过）：

```
src/skills/review.md  ── 首次启动 ──→  ~/.galaude/skills/review.md
src/skills/debug.md                   ~/.galaude/skills/debug.md
...
```

之后用户可自由编辑 `~/.galaude/skills/` 下的副本，不影响内置原版，`npm update` 也不会覆盖用户的改动。

### D5 写 API：增量语义（并集）/ 单独关闭

`skillactivate({ skills: ["review"] })`

- **增量添加**：新传入的 skill 加入激活集，已激活的保留
- 不会因为激活新 skill 而踢掉已在用的 skill
- 空数组 `[]` = 无操作

`skilldeactivate({ skills: ["review"] })`

- **指定关闭**：从激活集中移除指定 skill
- 不影响其他已激活的 skill
- 空数组 `[]` = 无操作

**为什么改增量语义**：全量替换容易导致模型"忘了"已经在用的 skill——如果先 `["review"]` 后想加 `debug`，必须重传 `["review", "debug"]`，漏了 review 就被无声关掉。

### D6 工具

| 工具 | 参数 | 注册表 | 说明 |
|------|------|--------|------|
| `skillread` | 无 | statefulTools | 扫描两目录，返回 `name + description` 列表（过滤 `invocation=user` 的，仅返回模型可触发的） |
| `skillactivate` | `skills: string[]` | statefulTools | 增量激活（并集），校验每个存在，发出 `skills` 事件 |
| `skilldeactivate` | `skills: string[]` | statefulTools | 指定关闭，不影响其他已激活的 skill |

`invocation=user` 的 skill 不出现在 `skillread` 返回列表中——模型看不见它们，只能通过 `/skill <name>` UI 命令手动激活（用于危险操作类 skill）。

### D7 上下文注入点

`buildContext` 构造投影，按以下顺序：

```
┌─ system  "你是一个 AI 编程 Agent 助手…"           ← messages[0]，缓存根，永不变
├─ system  【可用 Skills】review, debug, …           ← 发现层始终注入（无激活也展示）
├─ system  【已激活 Skill: review】\n审查原则…        ← 激活层（每个激活 skill 一条消息）
├─ system  【已知事实（12 条，请始终遵守）】            ← 全局 memory + 会话 memory
├─ system  【早前对话摘要】                            ← summaries
├─ system  【当前任务清单】                            ← todos
├─ user    帮我审查 src/tools.ts                      ← 近段原文（messages[k+1..]）
└─ ...
```

- **skill hint（发现层）** 始终注入，让模型无需调用工具就知道有哪些 skill
- **skill prompt（激活层）** 只在有激活 skill 时注入

### D8 持久化/会话状态

```
Session.activeSkills: string[]   ← 当前激活的 skill 名列表
StoredSession.activeSkills       ← 持久化到 sessions/<id>.json
```

- `createSession()` → `[]`（空，不激活任何 skill）
- `adoptSession()` → 跟着切换
- `resumeSession()` → 从存档恢复
- `persist()` → 跟着落盘

**好处**：会话恢复后自动回到之前的工作模式。

### D9 UI 命令

```
/skill               → 同 /skill list
/skill list          → 列出所有可用 skill（名 + 描述）
/skill review        → 增量激活 review（不影响已激活的）
/skill review debug  → 同时激活多个
/skill off           → 关闭所有 skill
/skill off review    → 关闭指定 skill（不影响其他）
```

空格分隔多个 skill 名，路径用 `/` 分隔（如 `code/review`）。`/skill off <name>` 只关闭指定的，不关其他的。

---

## 5. Skill 加载生命周期

```
1. 每轮 think 开始前（buildContext）：
   → scanSkills() 扫描 ~/.galaude/skills/ + src/skills/
   → 合并去重（用户优先），按名排序
   → renderSkillHint() 渲染为轻量提示行
   → 始终注入为 system 消息（ctx[1]）
   → 有激活 skill 时：逐个 loadSkill + renderSkillPrompts
   → 包成 system 消息插入（ctx[2..n]）
   → 模型始终看到可用 skill 列表 + 已激活 skill 的完整 prompt

2. 模型调用 skillread
   → scanSkills() 扫描两目录
   → 过滤 invocation=user 的 skill
   → renderSkillList() 渲染为文本
   → 返回给模型

3. 模型调用 skillactivate({ skills: ["review"] })
   → 逐个 loadSkill(name) 读取 .md 文件 + 解析 frontmatter
   → 校验每个存在（不存在则 throw，回喂模型）
   → ctx.activeSkills 增量追加（并集），已激活的保留
   → emit { type: "skills", skills: [...] } ← UI 刷新面板
   → renderSkillPrompts() 渲染为 "【已激活 Skill: name】\nprompt"
   → 返回渲染结果给模型

4. 模型调用 skilldeactivate({ skills: ["review"] })
   → 从 ctx.activeSkills 中过滤掉指定 skill
   → emit { type: "skills", skills: [...] }
   → 返回当前激活状态
```

---

## 6. 内置 4 个 Skill

| name | description | 行为模式 |
|------|-------------|---------|
| `review` | 代码审查：读取代码、分析问题、给出改进建议 | 先读完整上下文 → 查 bug/错误处理/性能/风格 → 给出具体建议 → 不直接改文件 |
| `debug` | 调试排错：先读错误信息、定位源码、加日志、定位根因 | 收集错误 → 定位源码 → 加诊断日志 → 定位根因 → 修复后验证 → 一次一个 bug |
| `refactor` | 重构优化：理解结构、拆小函数、提取模块、跑测试验证 | 理解结构 → 确保测试覆盖 → 小步改每步验证 → 提取纯函数 → 保持接口兼容 |
| `commit` | Git 提交：查看变更、生成规范的 commit message、commit 并 push | git diff → 检查不该提交的文件 → 生成 `type: 中文描述` → 一个 commit 一件事 → 精确 stage → push 前确认 |

---

## 7. 用户自定义 Skill

### 创建

```bash
# 扁平 skill
mkdir -p ~/.galaude/skills
cat > ~/.galaude/skills/format.md << 'EOF'
---
description: 代码格式化：自动修复代码风格问题
---

你处于「代码格式化」模式。

1. 先用 read_file 读取目标文件
2. 用 edit_file 修正缩进、空格、空行
3. 检查 eslint/prettier 是否配置，如有则跑格式化命令
4. 不改逻辑，只改格式
EOF
```

### 覆盖内置 skill

```bash
# 用户版覆盖内置版（优先级更高）
cat > ~/.galaude/skills/review.md << 'EOF'
---
description: 我的审查标准：侧重安全性和性能
---

你处于「代码审查」模式。我的代码库安全要求很高。

1. **安全检查优先**：SQL 注入、XSS、硬编码密钥、未验证的用户输入
2. 性能其次
3. 风格最后
EOF
```

### 分类组织

```bash
mkdir -p ~/.galaude/skills/{code,git,project}
# 创建 code/format.md → skill 名 "code/format"
# 创建 git/pr.md     → skill 名 "git/pr"
```

---

## 8. 纯函数叶子模块（src/skill.ts）

遵循 Galaude 模块约定：领域逻辑不依赖会话/UI，纯函数独立可测。工具和 agent 共用。

| 函数 | 签名 | 用途 |
|------|------|------|
| `scanSkills(userDir?, builtinDir?)` | → `SkillMeta[]` | 扫描两目录，合并去重，解析 description + invocation |
| `loadSkill(name, userDir?, builtinDir?)` | → `Skill` | 读 `.md` 文件，解析 frontmatter（含 invocation、allowed-tools） |
| `renderSkillList(skills)` | → `string` | 发现层详情：名 + 描述完整列表（skillread 用） |
| `renderSkillHint(skills)` | → `string` | 发现层轻量提示：一行列出所有 skill 名（buildContext 始终注入） |
| `renderSkillPrompts(skills)` | → `string[]` | 激活层：每条 `【已激活 Skill: name】\nprompt` |
| `parseFrontmatter(raw)` | → `{ meta, body }` | 内嵌，简易 YAML frontmatter 解析器（兼容 tools→allowed-tools） |
| `ensureUserSkills()` | → `void` | 内置 skill 复制到用户目录（幂等） |
| `getSkillDir(name)` | → `string` | 返回 skill 文件所在目录，供 body 中相对路径引用的 `references/` |

---

## 9. 文件改动清单

| 文件 | 用途 |
|------|------|
| `src/skill.ts`（新） | Skill 领域逻辑纯函数叶子模块 |
| `src/skill.test.ts`（新） | 13 个单测 |
| `src/skills/review.md`（新） | 代码审查 skill |
| `src/skills/debug.md`（新） | 调试排错 skill |
| `src/skills/refactor.md`（新） | 重构优化 skill |
| `src/skills/commit.md`（新） | Git 提交 skill |
| `src/tools.ts` | `skillread` / `skillactivate` 声明 + statefulTool 实现 |
| `src/agent.ts` | `Session.activeSkills` + `AgentEvent.skills` + SYSPROMPT + adopt/resume/persist |
| `src/compress.ts` | `CompressState.activeSkills`，`buildContext` 注入 skill prompts |
| `src/ui.tsx` | `/skill list` `/skill <name>` `/skill off` 命令 |
| `src/lgraph/graph.ts` | `activeSkills` 状态通道 + `buildContext` + `ToolCtx` |
| `src/store.ts` | `StoredSession.activeSkills` 持久化字段 |
