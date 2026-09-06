#!/usr/bin/env bash
# Apolla Work —— 本地一体化启动（单进程：server 同时托管 Web 与 API）。
# 用法：
#   bash scripts/start-local.sh                      # 用 mock 模型（零依赖，验证链路）
#   MODEL_BASE_URL=http://localhost:11434/v1 MODEL_API_KEY=ollama MODEL_DEFAULT=qwen3:4b \
#     bash scripts/start-local.sh                    # 接真实模型（OpenAI 兼容端点）
#   也可启动后在「管理后台 → 模型接入」里配置模型，无需改环境。
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

PORT="${SERVER_PORT:-3001}"
export STORAGE_DIR="${STORAGE_DIR:-$ROOT/data/storage}"
export DATABASE_URL_PRISMA="${DATABASE_URL_PRISMA:-file:$ROOT/apps/server/dev.db}"
export MODEL_DEFAULT="${MODEL_DEFAULT:-mock}"
export SERVE_WEB=1
export WEB_DIST="$ROOT/apps/web/dist"
export SERVER_PORT="$PORT"
export EXECUTOR="${EXECUTOR:-local}"

echo "==> 构建（首次较慢）"
pnpm install >/dev/null 2>&1 || pnpm install
pnpm --filter @apolla/protocol --filter @apolla/agent-tools run build
pnpm --filter @apolla/runtime run build
pnpm --filter @apolla/web run build
pnpm --filter @apolla/server run build

echo "==> 初始化数据库（幂等）"
# schema.prisma 面向 PostgreSQL；本地零依赖用派生的 SQLite schema（ADR-002），并按它重新生成客户端
( cd apps/server && node scripts/schema-sqlite.mjs && npx prisma db push --schema prisma/schema.sqlite.prisma >/dev/null 2>&1 && npx tsx prisma/seed.ts )

echo ""
echo "==> 启动 Apolla Work（单进程 · 端口 $PORT · 模型 $MODEL_DEFAULT）"
echo "    打开 http://localhost:$PORT"
echo "    接真实模型：设 MODEL_BASE_URL/MODEL_API_KEY/MODEL_DEFAULT 重启，或在管理后台配置。"
echo ""
exec node apps/server/dist/main.js
