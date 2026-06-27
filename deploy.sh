#!/usr/bin/env bash
# 部署（本地）：先构建出 dist/，再用编译后的纯 JS 产物运行。
# 跟 `npm run dev`(tsx 直接跑 .ts) 的区别：这里跑的是 build 出来的 dist/，
# 更接近"上线运行"的形态——不依赖 tsx，只需要 node。
#
# 用法:
#   ./deploy.sh                      # 跑默认示例
#   ./deploy.sh "帮我算 (3+4)*5"     # 跑指定问题（参数原样传给程序）
set -euo pipefail
cd "$(dirname "$0")"

# 1) 构建（装依赖 + 类型检查 + 编译到 dist/）
./build.sh

# 2) 运行编译产物，把所有参数透传给程序
echo
echo "[deploy] 启动 dist/index.js …"
echo
exec node dist/index.js "$@"
