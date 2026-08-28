#!/usr/bin/env bash
# =============================================================================
# Apolla Work 备份校验（恢复前必跑）
#
# 检查项
#   1) 目录结构完整、无 .INCOMPLETE 残留标记
#   2) SHA256SUMS 全部匹配（防静默位腐 / 传输截断）
#   3) manifest.json 是合法 JSON，且 schema 认识
#   4) PostgreSQL dump 非空、魔数为 custom 格式（PGDMP）
#   5) pg_restore --list 能真正解析出对象清单（本机 pg_restore → 否则用一次性容器）
#   6) MinIO 归档 gzip 完整、tar 可列表（若该备份含对象存储）
#   7) config/.env 权限不宽于 0600（含密钥，不该组内/全局可读）
#
# 用法
#   bash infra/backup/verify-backup.sh <备份目录>
#   bash infra/backup/verify-backup.sh ./backups/apolla-backup-20260828-120000 --no-docker
#
# 只读：本脚本不修改备份目录里的任何内容。
# 退出码：0 全部通过 · 1 存在失败项 · 2 用法错误
# =============================================================================
set -euo pipefail

BACKUP_DIR=""
PG_IMAGE="${APOLLA_HELPER_IMAGE:-postgres:16-alpine}"
USE_DOCKER=1

usage() {
  cat <<'EOF'
Apolla Work 备份校验

用法
  bash infra/backup/verify-backup.sh <备份目录> [选项]

选项
  --pg-image IMG   解析 dump 用的镜像（默认 postgres:16-alpine）
  --no-docker      不使用 docker（本机无 pg_restore 时降级为魔数检查）
  -h, --help       显示本帮助

退出码：0 通过 · 1 有失败项 · 2 用法错误
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --pg-image) PG_IMAGE="${2:?--pg-image 需要镜像名}"; shift 2 ;;
    --no-docker) USE_DOCKER=0; shift ;;
    -h | --help) usage; exit 0 ;;
    -*) printf '❌ 未知参数：%s\n' "$1" >&2; exit 2 ;;
    *)
      [ -z "$BACKUP_DIR" ] || { printf '❌ 只能指定一个备份目录\n' >&2; exit 2; }
      BACKUP_DIR="$1"; shift ;;
  esac
done

[ -n "$BACKUP_DIR" ] || { usage >&2; printf '\n❌ 缺少参数：备份目录\n' >&2; exit 2; }
[ -d "$BACKUP_DIR" ] || { printf '❌ 备份目录不存在：%s\n' "$BACKUP_DIR" >&2; exit 2; }
BACKUP_DIR="$(cd "$BACKUP_DIR" && pwd)"

PASS=0
FAIL=0
SKIP=0
ok()   { PASS=$((PASS + 1)); printf '  ✅ %s\n' "$*"; }
bad()  { FAIL=$((FAIL + 1)); printf '  ❌ %s\n' "$*"; }
skip() { SKIP=$((SKIP + 1)); printf '  ⏭  %s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }

printf '==> 校验备份：%s\n' "$BACKUP_DIR"

# ——— 1) 结构与完成标记 ———
step "1/7 目录结构与完成标记"
if [ -f "$BACKUP_DIR/.INCOMPLETE" ]; then
  bad "存在 .INCOMPLETE —— 这份备份没做完（backup.sh 中途失败），不可用于恢复"
else
  ok "无 .INCOMPLETE 标记，备份已正常收尾"
fi
for f in manifest.json SHA256SUMS; do
  if [ -s "$BACKUP_DIR/$f" ]; then ok "$f 存在且非空"; else bad "$f 缺失或为空"; fi
done

# ——— 2) SHA256 校验 ———
step "2/7 SHA256SUMS 校验"
if [ -s "$BACKUP_DIR/SHA256SUMS" ]; then
  N_SUMS="$(wc -l < "$BACKUP_DIR/SHA256SUMS" | tr -d ' ')"
  if command -v sha256sum >/dev/null 2>&1; then
    SUM_CMD=(sha256sum -c --quiet SHA256SUMS)
  elif command -v shasum >/dev/null 2>&1; then
    SUM_CMD=(shasum -a 256 -c SHA256SUMS)
  else
    SUM_CMD=()
  fi
  if [ "${#SUM_CMD[@]}" -eq 0 ]; then
    skip "本机没有 sha256sum/shasum，跳过校验和比对"
  elif ( cd "$BACKUP_DIR" && "${SUM_CMD[@]}" >/dev/null 2>&1 ); then
    ok "$N_SUMS 个文件校验和全部匹配"
  else
    bad "校验和不匹配（文件被改动或传输损坏），明细："
    ( cd "$BACKUP_DIR" && "${SUM_CMD[@]}" 2>&1 | grep -vi ': *OK$' | head -20 | sed 's/^/       /' ) || true
  fi
else
  skip "无 SHA256SUMS，跳过校验和比对"
fi

# ——— 3) manifest.json ———
step "3/7 manifest.json"
MANIFEST="$BACKUP_DIR/manifest.json"
DB_NAME="apolla"
if [ -s "$MANIFEST" ]; then
  JSON_OK=0
  if command -v node >/dev/null 2>&1; then
    node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$MANIFEST" 2>/dev/null && JSON_OK=1
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$MANIFEST" 2>/dev/null && JSON_OK=1
  elif command -v jq >/dev/null 2>&1; then
    jq -e . "$MANIFEST" >/dev/null 2>&1 && JSON_OK=1
  fi
  if [ "$JSON_OK" = 1 ]; then
    ok "manifest.json 是合法 JSON"
  else
    if command -v node >/dev/null 2>&1 || command -v python3 >/dev/null 2>&1 || command -v jq >/dev/null 2>&1; then
      bad "manifest.json 不是合法 JSON"
    else
      skip "本机没有 node/python3/jq，跳过 JSON 语法校验"
    fi
  fi
  if grep -q '"schema"[[:space:]]*:[[:space:]]*"apolla-backup/v1"' "$MANIFEST"; then
    ok "schema = apolla-backup/v1（本脚本认识）"
  else
    bad "schema 不是 apolla-backup/v1 —— 可能不是 Apolla 备份，或版本不兼容"
  fi
  # 从 manifest 取库名，找对应的 dump 文件
  MANIFEST_DB="$(sed -n 's/.*"database"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$MANIFEST" | head -1)"
  [ -n "$MANIFEST_DB" ] && DB_NAME="$MANIFEST_DB"
  printf '     记录的库名：%s\n' "$DB_NAME"
else
  skip "无 manifest.json，按默认库名 apolla 继续"
fi

# ——— 4) PostgreSQL dump 存在性与格式 ———
step "4/7 PostgreSQL dump 格式"
PG_DUMP="$BACKUP_DIR/postgres/${DB_NAME}.dump"
if [ ! -f "$PG_DUMP" ]; then
  # 库名对不上时兜底：取 postgres/ 下第一个 .dump
  ALT="$(find "$BACKUP_DIR/postgres" -maxdepth 1 -name '*.dump' 2>/dev/null | LC_ALL=C sort | head -1 || true)"
  [ -n "$ALT" ] && PG_DUMP="$ALT"
fi
DUMP_OK=0
if [ -s "$PG_DUMP" ]; then
  ok "dump 存在且非空：${PG_DUMP#"$BACKUP_DIR"/}（$(du -h "$PG_DUMP" | cut -f1 | tr -d ' ')）"
  # custom 格式的前 5 字节固定是 ASCII "PGDMP"
  MAGIC="$(head -c 5 "$PG_DUMP" 2>/dev/null || true)"
  if [ "$MAGIC" = "PGDMP" ]; then
    ok "魔数 PGDMP —— 是 pg_dump custom 格式"
    DUMP_OK=1
  else
    bad "魔数不是 PGDMP（实际：'$MAGIC'）—— 不是 custom 格式，pg_restore 无法处理"
  fi
else
  bad "PostgreSQL dump 缺失或为空：${PG_DUMP#"$BACKUP_DIR"/}"
fi

# ——— 5) pg_restore --list 真解析 ———
step "5/7 pg_restore --list 解析"
if [ "$DUMP_OK" = 1 ]; then
  LIST_OUT=""
  LIST_RC=1
  if command -v pg_restore >/dev/null 2>&1; then
    LIST_OUT="$(pg_restore --list "$PG_DUMP" 2>&1)" && LIST_RC=0 || LIST_RC=$?
    SRC="本机 pg_restore"
  elif [ "$USE_DOCKER" = 1 ] && command -v docker >/dev/null 2>&1; then
    LIST_OUT="$(docker run --rm -v "$PG_DUMP":/tmp/db.dump:ro "$PG_IMAGE" pg_restore --list /tmp/db.dump 2>&1)" && LIST_RC=0 || LIST_RC=$?
    SRC="容器内 pg_restore（$PG_IMAGE）"
  else
    SRC=""
  fi
  if [ -z "$SRC" ]; then
    skip "本机无 pg_restore 且未启用 docker，跳过（第 4 项的魔数检查已确认格式）"
  elif [ "$LIST_RC" = 0 ]; then
    N_OBJ="$(printf '%s\n' "$LIST_OUT" | grep -c '^[0-9]' || true)"
    ok "$SRC 解析成功，目录条目 $N_OBJ 个"
    if [ "${N_OBJ:-0}" -eq 0 ]; then
      bad "dump 里没有任何对象 —— 备份到的可能是空库，请确认这是预期的"
    fi
  else
    bad "$SRC 解析失败：$(printf '%s' "$LIST_OUT" | head -3 | tr '\n' ' ')"
  fi
else
  skip "dump 格式检查未通过，跳过 pg_restore 解析"
fi

# ——— 6) MinIO 归档 ———
step "6/7 MinIO 对象归档"
MINIO_TAR="$BACKUP_DIR/minio/minio-data.tar.gz"
if [ -f "$MINIO_TAR" ]; then
  if [ -s "$MINIO_TAR" ]; then
    ok "归档存在且非空（$(du -h "$MINIO_TAR" | cut -f1 | tr -d ' ')）"
  else
    bad "归档为空：minio/minio-data.tar.gz"
  fi
  if gzip -t "$MINIO_TAR" 2>/dev/null; then
    ok "gzip 完整性校验通过"
    N_ENTRIES="$(tar tzf "$MINIO_TAR" 2>/dev/null | wc -l | tr -d ' ' || echo 0)"
    if [ "${N_ENTRIES:-0}" -gt 0 ]; then
      ok "tar 可列表，含 $N_ENTRIES 个条目"
    else
      bad "tar 列表为空 —— 对象存储备份没有内容"
    fi
  else
    bad "gzip 完整性校验失败（归档损坏）"
  fi
else
  skip "本备份不含对象存储归档（--no-minio 或使用外部 S3）"
fi

# ——— 7) 配置与密钥权限 ———
step "7/7 配置文件与密钥权限"
if [ -f "$BACKUP_DIR/config/.env" ]; then
  # macOS 的 stat 是 -f %Lp，GNU 是 -c %a
  MODE="$(stat -f '%Lp' "$BACKUP_DIR/config/.env" 2>/dev/null || stat -c '%a' "$BACKUP_DIR/config/.env" 2>/dev/null || echo '')"
  if [ -z "$MODE" ]; then
    skip "无法读取 config/.env 权限位"
  elif [ "$MODE" = "600" ] || [ "$MODE" = "400" ]; then
    ok "config/.env 权限 $MODE（仅属主可读）"
  else
    bad "config/.env 权限 $MODE 过宽 —— 内含 APOLLA_MASTER_KEY，应为 600。修复：chmod 600 '$BACKUP_DIR/config/.env'"
  fi
else
  skip "备份不含 config/.env（恢复后需自行提供密钥与数据库口令）"
fi
for f in litellm-config.yaml compose.prod.yml; do
  if [ -s "$BACKUP_DIR/config/$f" ]; then ok "config/$f 存在"; else skip "config/$f 未包含"; fi
done

# ——— 汇总 ———
printf '\n%s\n' "──────────────────────────────────────────────"
printf '通过 %s · 失败 %s · 跳过 %s\n' "$PASS" "$FAIL" "$SKIP"
if [ "$FAIL" -eq 0 ]; then
  printf '\n✅ 备份校验通过，可用于恢复：\n'
  printf '   bash infra/backup/restore.sh "%s" --yes\n\n' "$BACKUP_DIR"
  exit 0
else
  printf '\n❌ 备份校验不通过（%s 项失败）—— 请勿用它恢复生产环境。\n\n' "$FAIL"
  exit 1
fi
