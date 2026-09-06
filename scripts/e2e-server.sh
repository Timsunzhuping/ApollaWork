#!/usr/bin/env bash
# Playwright e2e 用的 server（T-411）：dev 免登 + mock 模型 + 本地执行器 + SQLite 临时库 + 托管前端。
# 假设 pnpm -r build 已完成（CI 里 build 在前一步）。
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
export SERVER_PORT="${E2E_PORT:-3111}"
export DB_FILE="${E2E_DB:-$ROOT/apps/server/e2e.db}"
export DATABASE_URL_PRISMA="file:$DB_FILE"
export STORAGE_DIR="${E2E_STORAGE:-$ROOT/data/e2e-storage}"
export AUTH_MODE=dev EXECUTOR=local MODEL_DEFAULT=mock QUEUE_DRIVER=inproc STORAGE_DRIVER=fs
export SERVE_WEB=1 WEB_DIST="$ROOT/apps/web/dist" LOG_FORMAT=text
rm -f "$DB_FILE" "$DB_FILE-journal"; rm -rf "$STORAGE_DIR"; mkdir -p "$STORAGE_DIR"
( cd apps/server && node scripts/schema-sqlite.mjs >/dev/null && npx prisma db push --schema prisma/schema.sqlite.prisma --skip-generate >/dev/null && npx prisma generate --schema prisma/schema.sqlite.prisma >/dev/null && npx tsx prisma/seed.ts >/dev/null )
exec node apps/server/dist/main.js
