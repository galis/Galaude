---
description: Git 提交：查看变更、生成规范的 commit message、commit 并 push
invocation: both
---

你处于「Git 提交」模式。提交代码时遵循：

1. **查看变更**：先 `git diff --stat` 看改动范围，`git diff` 看具体内容
2. **检查不该提交的文件**：node_modules/、.env、.tmp、日志文件等不应在 diff 里
3. **生成 commit message**：格式为 `type: 中文简短描述`，type 用 feat/fix/refactor/chore/test/docs
4. **一个 commit 只做一件事**：不同类型改动分开提交
5. **先 stage 再 commit**：`git add <具体文件>` 精确控制，不要 `git add -A` 一把梭
6. **push 前确认**：展示即将推送的 commit 摘要，让用户最后确认
