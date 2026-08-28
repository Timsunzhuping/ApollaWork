#!/usr/bin/env bash
# =============================================================================
# Apolla Work 从备份恢复（破坏性操作）
#
# 流程
#   0) 预检：verify-backup.sh 全绿才继续
#   1) 安全网：先给**当前**数据做一份 pre-restore 备份（可 --no-pre-backup 关闭）
#   2) 停 server（停止写入）
#   3) 恢复 PostgreSQL：DROP DATABASE ... WITH (FORCE) → CREATE → pg_restore
#   4) 恢复 MinIO：停 minio → 清空卷 → 解包归档 → 起 minio
#   5) 起全栈 → 健康检查
#
# ⚠️ 这会**删除并重建**目标数据库、**清空并覆盖**对象存储卷。
#    必须显式传 --yes 才会真正执行；否则只打印计划然后退出。
#
# 用法
#   bash infra/backup/restore.sh <备份目录>              # 只看计划（安全）
#   bash infra/backup/restore.sh <备份目录> --yes        # 真正恢复
#
# 幂等：同一份备份重复恢复，结果一致（每次都是 DROP+CREATE / 清空+解包）。
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# ——— 默认值 ———
BACKUP_DIR=""
COMPOSE_FILE="$REPO_ROOT/infra/compose/compose.prod.yml"
ENV_FILE="$REPO_ROOT/infra/compose/.env"
PROJECT="apolla"
DB_USER="apolla"
DB_NAME="" # 留空则从 manifest.json 读；再兜底 apolla
CONFIRMED=0
SKIP_MINIO=0
SKIP_VERIFY=0
RESTORE_CONFIG=0
PRE_BACKUP=1
HEALTH_PORT=""
HEALTH_TIMEOUT=120
HELPER_IMAGE="${APOLLA_HELPER_IMAGE:-postgres:16-alpine}"

usage() {
  cat <<'EOF'
Apolla Work 从备份恢复（破坏性）

用法
  bash infra/backup/restore.sh <备份目录> [选项]

示例
  bash infra/backup/restore.sh ./backups/apolla-backup-20260828-120000          # 只打印计划
  bash infra/backup/restore.sh ./backups/apolla-backup-20260828-120000 --yes    # 真正执行

选项
  --yes                必须显式给出，才会真正执行破坏性恢复
  --dry-run            只打印计划（等价于不给 --yes，用于在脚本里表达意图）
  -f, --compose FILE   compose 文件（默认 infra/compose/compose.prod.yml）
  -e, --env-file FILE  compose 的 .env（默认 infra/compose/.env）
  -p, --project NAME   compose 项目名（默认 apolla）
      --db-user NAME   数据库用户（默认 apolla）
      --db-name NAME   数据库名（默认从备份的 manifest.json 读取）
      --skip-minio     不恢复对象存储
      --skip-verify    跳过 verify-backup.sh 预检（不推荐）
      --restore-config 用备份里的 .env / litellm 配置覆盖当前配置
                       （默认**不**覆盖，避免误伤当前环境的密钥与端点）
      --no-pre-backup  不做恢复前的现状备份（默认会做，作为回滚安全网）
      --port N         健康检查端口（默认取 .env 里的 PORT，再兜底 3001）
      --timeout SEC    健康检查等待秒数（默认 120）
      --helper-image IMG 操作数据卷用的镜像（默认 postgres:16-alpine）
  -h, --help           显示本帮助

退出码：0 成功 / 仅打印计划 · 1 失败 · 2 用法错误
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --yes) CONFIRMED=1; shift ;;
    --dry-run) CONFIRMED=0; shift ;;
    -f | --compose) COMPOSE_FILE="${2:?--compose 需要文件}"; shift 2 ;;
    -e | --env-file) ENV_FILE="${2:?--env-file 需要文件}"; shift 2 ;;
    -p | --project) PROJECT="${2:?--project 需要名称}"; shift 2 ;;
    --db-user) DB_USER="${2:?--db-user 需要名称}"; shift 2 ;;
    --db-name) DB_NAME="${2:?--db-name 需要名称}"; shift 2 ;;
    --skip-minio) SKIP_MINIO=1; shift ;;
    --skip-verify) SKIP_VERIFY=1; shift ;;
    --restore-config) RESTORE_CONFIG=1; shift ;;
    --no-pre-backup) PRE_BACKUP=0; shift ;;
    --port) HEALTH_PORT="${2:?--port 需要端口}"; shift 2 ;;
    --timeout) HEALTH_TIMEOUT="${2:?--timeout 需要秒数}"; shift 2 ;;
    --helper-image) HELPER_IMAGE="${2:?--helper-image 需要镜像名}"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    -*) printf '❌ 未知参数：%s（用 --help 看用法）\n' "$1" >&2; exit 2 ;;
    *)
      [ -z "$BACKUP_DIR" ] || { printf '❌ 只能指定一个备份目录\n' >&2; exit 2; }
      BACKUP_DIR="$1"; shift ;;
  esac
done

say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
warn() { printf '⚠️  %s\n' "$*" >&2; }
die() { printf '❌ %s\n' "$*" >&2; exit 1; }

[ -n "$BACKUP_DIR" ] || { usage >&2; printf '\n❌ 缺少参数：备份目录\n' >&2; exit 2; }
[ -d "$BACKUP_DIR" ] || die "备份目录不存在：$BACKUP_DIR"
BACKUP_DIR="$(cd "$BACKUP_DIR" && pwd)"
[ -f "$COMPOSE_FILE" ] || die "compose 文件不存在：$COMPOSE_FILE"
[ -f "$BACKUP_DIR/.INCOMPLETE" ] && die "该备份带 .INCOMPLETE 标记（备份未完成），拒绝使用"

# compose 参数用数组：路径可能含空格
DC_ARGS=(-p "$PROJECT" -f "$COMPOSE_FILE")
[ -f "$ENV_FILE" ] && DC_ARGS+=(--env-file "$ENV_FILE")
dc() { docker compose "${DC_ARGS[@]}" "$@"; }
# compose 文件里是否声明了该服务（用外部 S3 的部署可能根本没有 minio 服务）
has_service() { dc config --services 2>/dev/null | grep -qx "$1"; }

# ——— 解析备份内容 ———
MANIFEST="$BACKUP_DIR/manifest.json"
if [ -z "$DB_NAME" ]; then
  if [ -s "$MANIFEST" ]; then
    DB_NAME="$(sed -n 's/.*"database"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$MANIFEST" | head -1)"
  fi
  DB_NAME="${DB_NAME:-apolla}"
fi
PG_DUMP="$BACKUP_DIR/postgres/${DB_NAME}.dump"
if [ ! -f "$PG_DUMP" ]; then
  ALT="$(find "$BACKUP_DIR/postgres" -maxdepth 1 -name '*.dump' 2>/dev/null | LC_ALL=C sort | head -1 || true)"
  [ -n "$ALT" ] && PG_DUMP="$ALT"
fi
MINIO_TAR="$BACKUP_DIR/minio/minio-data.tar.gz"
[ -f "$MINIO_TAR" ] || SKIP_MINIO=1

MINIO_VOL=""
if [ "$SKIP_MINIO" = 0 ]; then
  if command -v docker >/dev/null 2>&1; then
    MINIO_VOL="$(docker volume ls -q \
      --filter "label=com.docker.compose.project=$PROJECT" \
      --filter "label=com.docker.compose.volume=minio" 2>/dev/null | head -1 || true)"
  fi
  [ -n "$MINIO_VOL" ] || MINIO_VOL="${PROJECT}_minio"
fi

if [ -z "$HEALTH_PORT" ]; then
  [ -f "$ENV_FILE" ] && HEALTH_PORT="$(sed -n 's/^PORT=//p' "$ENV_FILE" 2>/dev/null | head -1 || true)"
  HEALTH_PORT="${HEALTH_PORT:-3001}"
fi

BACKED_UP_AT="$(sed -n 's/.*"createdAt"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$MANIFEST" 2>/dev/null | head -1 || true)"
BACKED_UP_VER="$(sed -n 's/.*"apollaVersion"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$MANIFEST" 2>/dev/null | head -1 || true)"

# ——— 计划 ———
say "==> Apolla Work 恢复"
say ""
say "备份来源：$BACKUP_DIR"
say "  备份时间：${BACKED_UP_AT:-未知}    Apolla 版本：${BACKED_UP_VER:-未知}"
say "目标环境：compose 项目 $PROJECT · $COMPOSE_FILE"
say ""
say "将执行的步骤："
say "  0. 预检备份完整性：$([ "$SKIP_VERIFY" = 1 ] && echo '跳过（--skip-verify）' || echo 'verify-backup.sh 全绿才继续')"
say "  1. 恢复前给现状留档：$([ "$PRE_BACKUP" = 1 ] && echo 'backup.sh --label pre-restore（回滚安全网）' || echo '跳过（--no-pre-backup）')"
say "  2. 停止 server 服务（停止一切写入）"
say "  3. 【破坏性】DROP DATABASE \"$DB_NAME\" WITH (FORCE) → CREATE → pg_restore 恢复"
say "     数据源：${PG_DUMP#"$BACKUP_DIR"/}"
if [ "$SKIP_MINIO" = 1 ]; then
  say "  4. 对象存储：跳过$([ -f "$MINIO_TAR" ] || echo '（备份里没有对象归档）')"
else
  say "  4. 【破坏性】停 minio → 清空卷 $MINIO_VOL → 解包 minio/minio-data.tar.gz → 起 minio"
fi
if [ "$RESTORE_CONFIG" = 1 ]; then
  say "  5. 【破坏性】用备份里的 .env / litellm 配置覆盖 $ENV_FILE 与 infra/litellm/config.yaml"
else
  say "  5. 配置文件：不覆盖（默认行为；需要覆盖请加 --restore-config）"
fi
say "  6. 起全栈 → 轮询 http://localhost:$HEALTH_PORT/readyz 就绪探针（最多 ${HEALTH_TIMEOUT}s）"
say ""

if [ "$CONFIRMED" != 1 ]; then
  say "──────────────────────────────────────────────"
  say "当前为**仅打印计划**模式，没有做任何改动。"
  say "确认无误后，在原命令末尾追加 --yes 即可执行，例如："
  say "  bash infra/backup/restore.sh \"$BACKUP_DIR\" --project $PROJECT --yes"
  say ""
  exit 0
fi

say "──────────────────────────────────────────────"
warn "已收到 --yes：下面开始**破坏性**恢复，目标环境的现有数据将被覆盖。"
say ""

command -v docker >/dev/null 2>&1 || die "缺少 docker，无法恢复"

# ——— 0) 预检 ———
step "0/6 预检备份完整性"
if [ "$SKIP_VERIFY" = 1 ]; then
  warn "已跳过预检（--skip-verify）—— 你在用一份未经校验的备份恢复生产数据"
else
  if bash "$SCRIPT_DIR/verify-backup.sh" "$BACKUP_DIR"; then
    say "    预检通过"
  else
    die "备份校验不通过，已中止恢复。如确认可用，可加 --skip-verify 强行继续。"
  fi
fi

# ——— 1) 恢复前留档 ———
step "1/6 恢复前给现状留档"
if [ "$PRE_BACKUP" = 0 ]; then
  warn "已跳过（--no-pre-backup）—— 恢复后无法回到当前状态"
elif dc ps --status running --services 2>/dev/null | grep -qx postgres; then
  PRE_OUT="$(dirname "$BACKUP_DIR")"
  say "    → $PRE_OUT/apolla-backup-<时间戳>-pre-restore"
  bash "$SCRIPT_DIR/backup.sh" \
    --out "$PRE_OUT" --label pre-restore \
    --compose "$COMPOSE_FILE" --env-file "$ENV_FILE" --project "$PROJECT" \
    --db-user "$DB_USER" --db-name "$DB_NAME" --helper-image "$HELPER_IMAGE" \
    || die "恢复前留档失败，已中止（宁可不恢复，也不要在无回滚点时覆盖数据）"
else
  warn "postgres 未运行，无法给现状留档 —— 视作全新环境，继续恢复"
fi

# ——— 2) 停 server ———
step "2/6 停止 server（停止写入）"
if has_service server; then
  dc stop server >/dev/null 2>&1 || warn "停止 server 失败，继续（恢复期间可能有写入冲突）"
  say "    server 已停止"
else
  warn "compose 里没有 server 服务，跳过（请自行确认没有进程在写这套数据）"
fi

# ——— 3) 恢复 PostgreSQL ———
step "3/6 恢复 PostgreSQL（库 $DB_NAME）"
[ -s "$PG_DUMP" ] || die "dump 缺失或为空：$PG_DUMP"

say "    确保 postgres 在运行…"
dc up -d postgres >/dev/null
for i in $(seq 1 60); do
  if dc exec -T postgres pg_isready -U "$DB_USER" >/dev/null 2>&1; then break; fi
  [ "$i" = 60 ] && die "postgres 60 秒内未就绪"
  sleep 1
done
say "    postgres 就绪"

# WITH (FORCE)：PG13+ 支持强制断开现有连接后删库，免得被残留会话卡住
say "    DROP DATABASE \"$DB_NAME\" WITH (FORCE)…"
dc exec -T postgres psql -U "$DB_USER" -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS \"$DB_NAME\" WITH (FORCE);" >/dev/null
say "    CREATE DATABASE \"$DB_NAME\"…"
dc exec -T postgres psql -U "$DB_USER" -d postgres -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE \"$DB_NAME\" OWNER \"$DB_USER\";" >/dev/null

say "    pg_restore 导入中…"
# --exit-on-error：任何一条恢复语句失败都立刻停，避免恢复出半截数据库
dc exec -T postgres pg_restore -U "$DB_USER" -d "$DB_NAME" \
  --no-owner --no-privileges --exit-on-error < "$PG_DUMP"

N_TABLES="$(dc exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';" 2>/dev/null | tr -d '[:space:]' || echo '?')"
say "    ✅ 数据库已恢复（public schema 下 $N_TABLES 张表）"

# ——— 4) 恢复 MinIO ———
step "4/6 恢复 MinIO 对象存储"
if [ "$SKIP_MINIO" = 1 ]; then
  say "    跳过（备份不含对象归档，或指定了 --skip-minio）"
else
  # 用外部 S3 的部署可能压根没声明 minio 服务；此时只恢复数据卷，不做起停
  MINIO_SVC=0
  if has_service minio; then
    MINIO_SVC=1
    say "    停止 minio…"
    dc stop minio 2>/dev/null || true
  else
    warn "compose 里没有 minio 服务，只恢复数据卷、不做服务起停（用外部 S3 时属正常）"
  fi
  if ! docker volume inspect "$MINIO_VOL" >/dev/null 2>&1; then
    say "    卷 $MINIO_VOL 不存在，创建…"
    docker volume create "$MINIO_VOL" >/dev/null
  fi
  say "    清空卷 $MINIO_VOL…"
  # 用 find 删而非 rm -rf /data/*：能一并清掉点开头的隐藏项，且空目录不报错
  docker run --rm -v "$MINIO_VOL":/data "$HELPER_IMAGE" \
    find /data -mindepth 1 -delete
  say "    解包归档到卷…"
  docker run --rm \
    -v "$MINIO_VOL":/data \
    -v "$BACKUP_DIR/minio":/backup:ro \
    "$HELPER_IMAGE" \
    tar xzf /backup/minio-data.tar.gz -C /data
  if [ "$MINIO_SVC" = 1 ]; then
    say "    启动 minio…"
    dc up -d minio >/dev/null || die "minio 启动失败 —— 数据卷已恢复，请查日志：docker compose -p $PROJECT logs minio"
  fi
  N_OBJ="$(docker run --rm -v "$MINIO_VOL":/data:ro "$HELPER_IMAGE" \
    sh -c 'find /data -type f | wc -l' 2>/dev/null | tr -d '[:space:]' || echo '?')"
  say "    ✅ 对象存储已恢复（卷内文件 $N_OBJ 个）"
fi

# ——— 5) 配置文件 ———
step "5/6 配置文件"
if [ "$RESTORE_CONFIG" = 1 ]; then
  if [ -f "$BACKUP_DIR/config/.env" ]; then
    cp "$ENV_FILE" "$ENV_FILE.bak.$(date +%s)" 2>/dev/null || true
    cp "$BACKUP_DIR/config/.env" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    say "    ✓ 已覆盖 $ENV_FILE（旧文件另存为 .bak.<时间戳>）"
  else
    warn "备份里没有 config/.env，跳过"
  fi
  if [ -f "$BACKUP_DIR/config/litellm-config.yaml" ]; then
    cp "$REPO_ROOT/infra/litellm/config.yaml" "$REPO_ROOT/infra/litellm/config.yaml.bak.$(date +%s)" 2>/dev/null || true
    cp "$BACKUP_DIR/config/litellm-config.yaml" "$REPO_ROOT/infra/litellm/config.yaml"
    say "    ✓ 已覆盖 infra/litellm/config.yaml"
  fi
else
  say "    未覆盖（默认）。若目标环境是全新机器，请手动比对："
  say "      diff \"$BACKUP_DIR/config/.env\" \"$ENV_FILE\""
  say "    注意：APOLLA_MASTER_KEY 必须与备份时一致，否则连接器/模型密钥解不开。"
fi

# ——— 6) 起全栈 + 健康检查 ———
step "6/6 启动全栈并健康检查"
dc up -d
say "    等待 server 就绪（最多 ${HEALTH_TIMEOUT}s）…"

# 优先用 /readyz（免鉴权，真查 DB + 存储可达性；未就绪返回 503）。
# 老版本 server 没有这个端点，回落到 /api/v1/me —— 但注意 AUTH_MODE=oidc 时
# 不带 token 的 /api/v1/me 会返回 401，那种情况下探测结果不可靠，以 dc ps 为准。
health_probe() {
  curl -sf -o /dev/null "http://localhost:${HEALTH_PORT}/readyz" 2>/dev/null && return 0
  curl -sf -o /dev/null "http://localhost:${HEALTH_PORT}/api/v1/me" 2>/dev/null && return 0
  return 1
}

HEALTHY=0
ELAPSED=0
while [ "$ELAPSED" -lt "$HEALTH_TIMEOUT" ]; do
  if health_probe; then
    HEALTHY=1
    break
  fi
  sleep 3
  ELAPSED=$((ELAPSED + 3))
done

say ""
dc ps || true
say ""
if [ "$HEALTHY" = 1 ]; then
  say "✅ 恢复完成，server 已就绪 → http://localhost:${HEALTH_PORT}"
  say ""
  say "建议随后人工确认："
  say "  1. 登录后能看到历史任务与事件（事件是唯一真相，回放应完整）"
  say "  2. 打开一个历史任务的产物文件（验证对象存储恢复正确）"
  say "  3. 管理后台 →「模型接入」做一次连通测试（验证 APOLLA_MASTER_KEY 能解密密钥）"
  exit 0
else
  warn "server 在 ${HEALTH_TIMEOUT}s 内未通过健康检查。数据已恢复，问题多半在服务启动。"
  say "   就绪探针原始返回（哪个组件没起来一看便知）："
  curl -s --max-time 5 "http://localhost:${HEALTH_PORT}/readyz" 2>/dev/null | head -c 500 | sed 's/^/     /' || true
  say ""
  say "   排查：docker compose -p $PROJECT -f \"$COMPOSE_FILE\" logs --tail 100 server"
  say "   详见 docs/ops.md §故障排查 · server 起不来"
  exit 1
fi
