#!/usr/bin/env bash
# 本机部署启动器：复用已构建的 dist（不重新 install/build），SQLite + 本地文件 + 免登录，Web 与 API 同端口。
# 模型：默认 mock；传 MODEL_BASE_URL/MODEL_DEFAULT/MODEL_API_KEY 即接真实 OpenAI 兼容端点（也可在管理后台配置）。
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
export SERVER_PORT="${SERVER_PORT:-3001}"
export STORAGE_DIR="${STORAGE_DIR:-$ROOT/data/storage}"
export DATABASE_URL_PRISMA="${DATABASE_URL_PRISMA:-file:$ROOT/apps/server/dev.db}"
export MODEL_DEFAULT="${MODEL_DEFAULT:-mock}"
export AUTH_MODE=dev EXECUTOR=local QUEUE_DRIVER=inproc STORAGE_DRIVER=fs LOG_FORMAT=text
export SERVE_WEB=1 WEB_DIST="$ROOT/apps/web/dist"
export ALLOWED_ORIGINS="http://localhost:$SERVER_PORT"
mkdir -p "$STORAGE_DIR"
( cd apps/server && node scripts/schema-sqlite.mjs >/dev/null \
  && npx prisma db push --schema prisma/schema.sqlite.prisma --skip-generate >/dev/null \
  && npx prisma generate --schema prisma/schema.sqlite.prisma >/dev/null \
  && npx tsx prisma/seed.ts >/dev/null )
echo "Apolla Work 本机部署：http://localhost:$SERVER_PORT （模型 $MODEL_DEFAULT）"
exec node apps/server/dist/main.js
