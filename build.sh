#!/usr/bin/env bash
# 构建：装依赖 → 类型检查 → 把 src/ 的 TypeScript 编译成 dist/ 的纯 JS。
# 产物 dist/ 可以用 `node dist/index.js` 直接跑，不再依赖 tsx。
set -euo pipefail
cd "$(dirname "$0")"

echo "[build] 1/3 安装依赖 …"
npm install

echo "[build] 2/3 类型检查 …"
npm run typecheck

echo "[build] 3/3 编译到 dist/ …"
rm -rf dist
# tsconfig 里是 noEmit=true（给 typecheck 用），这里用命令行覆盖，真正产出 JS。
npx tsc -p tsconfig.json --noEmit false --outDir dist

echo "[build] 完成 ✅  运行: node dist/index.js \"你的问题\""
