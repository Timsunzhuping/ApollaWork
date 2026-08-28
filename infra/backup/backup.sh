#!/usr/bin/env bash
# =============================================================================
# Apolla Work 全量备份（PRD T-120 «备份脚本»）
#
# 备份什么
#   1) PostgreSQL —— docker compose exec postgres pg_dump -Fc（custom 格式，可被
#      pg_restore --list 解析、可选择性恢复、自带压缩）
#   2) MinIO 对象 —— 直接打包 compose 数据卷（不依赖 mc 客户端，离线环境也能跑）
#   3) 配置 —— .env / infra/litellm/config.yaml / compose.prod.yml
#      ⚠️ .env 内含主密钥与数据库口令，备份目录属敏感数据（见脚本末尾警告）
#
# 产出
#   <备份根>/apolla-backup-<时间戳>[-<标签>]/
#     postgres/apolla.dump          pg_dump custom 格式
#     minio/minio-data.tar.gz       对象存储卷快照
#     config/.env                   ⚠️ 含密钥，权限 0600
#     config/litellm-config.yaml
#     config/compose.prod.yml
#     manifest.json                 组件版本、镜像、Git 提交等元信息
#     SHA256SUMS                    除自身外全部文件的校验和
#
# 可重复执行：每次生成独立的时间戳目录，绝不覆盖历史备份。
# 中途失败：目录里留下 .INCOMPLETE 标记，verify-backup.sh / restore.sh 会拒绝使用。
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# ——— 默认值 ———
OUT_ROOT="${APOLLA_BACKUP_DIR:-$REPO_ROOT/backups}"
COMPOSE_FILE="$REPO_ROOT/infra/compose/compose.prod.yml"
ENV_FILE="$REPO_ROOT/infra/compose/.env"
PROJECT="apolla" # 与 compose.prod.yml 的 `name: apolla` 一致
DB_USER="apolla"
DB_NAME="apolla"
KEEP=0 # 0 = 不清理历史备份
LABEL=""
DRY_RUN=0
SKIP_MINIO=0
# 打包数据卷用的一次性辅助容器镜像：默认取 Apolla 栈本来就有的 postgres 镜像，
# 这样离线环境不必额外准备 alpine/busybox。
HELPER_IMAGE="${APOLLA_HELPER_IMAGE:-postgres:16-alpine}"

usage() {
  cat <<'EOF'
Apolla Work 全量备份

用法
  bash infra/backup/backup.sh [选项]

示例
  bash infra/backup/backup.sh                          # 备份到 ./backups
  bash infra/backup/backup.sh -o /srv/backup --keep 7  # 异地目录 + 只留最近 7 份
  bash infra/backup/backup.sh --label pre-upgrade      # 升级前留档
  bash infra/backup/backup.sh --dry-run                # 只打印计划，不动任何数据

选项
  -o, --out DIR          备份根目录（默认 ./backups，或环境变量 APOLLA_BACKUP_DIR）
  -f, --compose FILE     compose 文件（默认 infra/compose/compose.prod.yml）
  -e, --env-file FILE    compose 的 .env（默认 infra/compose/.env）
  -p, --project NAME     compose 项目名（默认 apolla）
      --db-user NAME     数据库用户（默认 apolla）
      --db-name NAME     数据库名（默认 apolla）
      --keep N           只保留最近 N 份备份，删除更旧的（默认 0 = 不清理）
      --label TEXT       给备份目录加后缀，如 --label pre-upgrade
      --no-minio         跳过对象存储备份（用外部 S3 时）
      --helper-image IMG 打包数据卷用的镜像（默认 postgres:16-alpine）
      --dry-run          只打印将执行的动作，不读写任何数据
  -h, --help             显示本帮助
EOF
}

# ——— 参数解析 ———
while [ $# -gt 0 ]; do
  case "$1" in
    -o | --out) OUT_ROOT="${2:?--out 需要目录}"; shift 2 ;;
    -f | --compose) COMPOSE_FILE="${2:?--compose 需要文件}"; shift 2 ;;
    -e | --env-file) ENV_FILE="${2:?--env-file 需要文件}"; shift 2 ;;
    -p | --project) PROJECT="${2:?--project 需要名称}"; shift 2 ;;
    --db-user) DB_USER="${2:?--db-user 需要名称}"; shift 2 ;;
    --db-name) DB_NAME="${2:?--db-name 需要名称}"; shift 2 ;;
    --keep) KEEP="${2:?--keep 需要数字}"; shift 2 ;;
    --label) LABEL="${2:?--label 需要文本}"; shift 2 ;;
    --no-minio) SKIP_MINIO=1; shift ;;
    --helper-image) HELPER_IMAGE="${2:?--helper-image 需要镜像名}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) printf '❌ 未知参数：%s（用 --help 看用法）\n' "$1" >&2; exit 2 ;;
  esac
done

case "$KEEP" in
  '' | *[!0-9]*) printf '❌ --keep 必须是非负整数，得到：%s\n' "$KEEP" >&2; exit 2 ;;
esac

# ——— 小工具 ———
say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
warn() { printf '⚠️  %s\n' "$*" >&2; }
die() { printf '❌ %s\n' "$*" >&2; exit 1; }

# dry-run 下只打印命令，不执行
run() {
  if [ "$DRY_RUN" = 1 ]; then printf '    [dry-run] %s\n' "$*"; return 0; fi
  "$@"
}
# 需要把 stdout 重定向到文件的命令
run_to() {
  local dest="$1"; shift
  if [ "$DRY_RUN" = 1 ]; then printf '    [dry-run] %s > %s\n' "$*" "$dest"; return 0; fi
  "$@" > "$dest"
}

sha256_tool() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi
}

# 最小 JSON 字符串转义（反斜杠 / 双引号 / 换行）
json_escape() {
  printf '%s' "${1-}" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\r' | tr '\n' ' '
}

# compose 参数用数组保存：路径可能含空格（本仓库路径就含空格），不能靠字符串拼接
DC_ARGS=()
dc() { docker compose "${DC_ARGS[@]}" "$@"; }

say "==> Apolla Work 全量备份"
[ "$DRY_RUN" = 1 ] && say "    ** DRY-RUN 模式：只打印计划，不读写任何数据 **"

# ——— 0) 环境自检 ———
step "环境自检"
[ -f "$COMPOSE_FILE" ] || die "compose 文件不存在：$COMPOSE_FILE"
DC_ARGS=(-p "$PROJECT" -f "$COMPOSE_FILE")
say "    compose 文件：$COMPOSE_FILE"
say "    compose 项目：$PROJECT"

if [ -f "$ENV_FILE" ]; then
  DC_ARGS+=(--env-file "$ENV_FILE")
  say "    环境文件：  $ENV_FILE"
else
  warn "未找到 $ENV_FILE —— 不带 --env-file 运行 compose（变量取自当前 shell）"
fi

HAVE_DOCKER=0
if command -v docker >/dev/null 2>&1; then
  HAVE_DOCKER=1
  say "    docker：    $(docker --version 2>/dev/null || echo '未知版本')"
elif [ "$DRY_RUN" = 1 ]; then
  warn "本机没有 docker —— dry-run 继续（真跑时必须有 docker）"
else
  die "缺少 docker，无法备份"
fi

pg_is_running() {
  [ "$HAVE_DOCKER" = 1 ] || return 1
  dc ps --status running --services 2>/dev/null | grep -qx postgres
}

if pg_is_running; then
  say "    postgres：  运行中"
elif [ "$DRY_RUN" = 1 ]; then
  say "    postgres：  未运行（dry-run 下不阻断）"
else
  die "postgres 容器未在运行 —— 请先启动：docker compose -p $PROJECT -f $COMPOSE_FILE up -d postgres"
fi

# ——— 1) 建立备份目录 ———
TS="$(date +%Y%m%d-%H%M%S)"
NAME="apolla-backup-${TS}${LABEL:+-$LABEL}"
DEST="$OUT_ROOT/$NAME"
# 同一秒内重复执行：加进程号后缀，保证不覆盖
if [ -e "$DEST" ]; then DEST="${DEST}-$$"; NAME="$(basename "$DEST")"; fi

step "建立备份目录 $DEST"
run mkdir -p "$DEST/postgres" "$DEST/minio" "$DEST/config"
if [ "$DRY_RUN" = 0 ]; then
  chmod 700 "$DEST"
  # 未完成标记：中途失败就留在原地，verify/restore 见到即拒绝
  printf '备份未完成（脚本仍在运行，或已中断）。正常结束时本文件会被删除。\n' > "$DEST/.INCOMPLETE"
fi

on_exit() {
  local code=$?
  if [ "$code" -ne 0 ] && [ "$DRY_RUN" = 0 ] && [ -d "$DEST" ]; then
    warn "备份失败（退出码 $code）。残缺目录已保留供排查：$DEST"
    warn "该目录带 .INCOMPLETE 标记，restore.sh 会拒绝使用它。"
  fi
}
trap on_exit EXIT

# ——— 2) PostgreSQL ———
step "备份 PostgreSQL（库 $DB_NAME / 用户 $DB_USER）"
PG_DUMP="$DEST/postgres/${DB_NAME}.dump"
# -Fc：custom 格式（自带压缩、支持 pg_restore --list 与选择性恢复）
# --no-owner --no-privileges：恢复到新环境时不因角色缺失而报错
run_to "$PG_DUMP" dc exec -T postgres \
  pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc --no-owner --no-privileges
if [ "$DRY_RUN" = 0 ]; then
  [ -s "$PG_DUMP" ] || die "pg_dump 产出为空：$PG_DUMP"
  say "    → postgres/$(basename "$PG_DUMP")（$(du -h "$PG_DUMP" | cut -f1 | tr -d ' ')）"
fi

PG_VERSION="unknown"
if [ "$DRY_RUN" = 0 ]; then
  PG_VERSION="$(dc exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" -tAc 'SHOW server_version' 2>/dev/null | tr -d '[:space:]' || true)"
  PG_VERSION="${PG_VERSION:-unknown}"
  say "    PostgreSQL 版本：$PG_VERSION"
fi

# ——— 3) MinIO 对象存储 ———
MINIO_VOL=""
MINIO_TAR="$DEST/minio/minio-data.tar.gz"
if [ "$SKIP_MINIO" = 1 ]; then
  step "跳过对象存储备份（--no-minio）"
  [ "$DRY_RUN" = 0 ] && rmdir "$DEST/minio" 2>/dev/null
  true
else
  step "备份 MinIO 对象存储卷"
  # 优先按 compose label 查真实卷名，查不到再退回 <项目>_minio 命名约定
  if [ "$HAVE_DOCKER" = 1 ]; then
    MINIO_VOL="$(docker volume ls -q \
      --filter "label=com.docker.compose.project=$PROJECT" \
      --filter "label=com.docker.compose.volume=minio" 2>/dev/null | head -1 || true)"
  fi
  [ -n "$MINIO_VOL" ] || MINIO_VOL="${PROJECT}_minio"
  say "    卷名：$MINIO_VOL"

  if [ "$DRY_RUN" = 0 ] && ! docker volume inspect "$MINIO_VOL" >/dev/null 2>&1; then
    warn "卷 $MINIO_VOL 不存在，跳过对象存储备份（用的是外部 S3 时这是预期行为）"
    rm -rf "$DEST/minio"
    MINIO_VOL=""
  else
    # 只读挂载数据卷 + 读写挂载备份目录，用一次性容器打包；不要求宿主机装 tar/mc
    run docker run --rm \
      -v "$MINIO_VOL":/data:ro \
      -v "$DEST/minio":/backup \
      "$HELPER_IMAGE" \
      tar czf /backup/minio-data.tar.gz -C /data .
    # 容器以 root 写出归档，交回当前用户，免得后续 chmod/rm 失败
    run docker run --rm \
      -v "$DEST/minio":/backup \
      "$HELPER_IMAGE" \
      chown -R "$(id -u):$(id -g)" /backup
    if [ "$DRY_RUN" = 0 ]; then
      [ -s "$MINIO_TAR" ] || die "对象存储打包为空：$MINIO_TAR"
      chmod 600 "$MINIO_TAR" 2>/dev/null || true
      say "    → minio/minio-data.tar.gz（$(du -h "$MINIO_TAR" | cut -f1 | tr -d ' ')）"
    fi
  fi
fi

# ——— 4) 配置与密钥 ———
step "备份配置文件"
copy_cfg() {
  local src="$1" dst="$2"
  if [ -f "$src" ]; then
    run cp "$src" "$DEST/config/$dst"
    [ "$DRY_RUN" = 0 ] && say "    ✓ config/$dst"
    true
  else
    warn "未找到 $src，跳过 config/$dst"
  fi
}
copy_cfg "$ENV_FILE" ".env"
copy_cfg "$REPO_ROOT/infra/litellm/config.yaml" "litellm-config.yaml"
copy_cfg "$COMPOSE_FILE" "$(basename "$COMPOSE_FILE")"
if [ "$DRY_RUN" = 0 ] && [ -f "$DEST/config/.env" ]; then
  chmod 600 "$DEST/config/.env"
fi

# ——— 5) manifest.json ———
step "生成 manifest.json"
GIT_COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
GIT_BRANCH="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
VERSION_FROM_ENV=""
[ -f "$ENV_FILE" ] && VERSION_FROM_ENV="$(sed -n 's/^APOLLA_VERSION=//p' "$ENV_FILE" 2>/dev/null | head -1 || true)"
APOLLA_VERSION="${APOLLA_VERSION:-${VERSION_FROM_ENV:-unknown}}"
DOCKER_VERSION="$(docker --version 2>/dev/null || echo unknown)"
COMPOSE_VERSION="$(docker compose version --short 2>/dev/null || echo unknown)"

# 记录各服务实际在跑的镜像，恢复时可对齐版本
IMAGES_JSON='[]'
if [ "$DRY_RUN" = 0 ] && [ "$HAVE_DOCKER" = 1 ]; then
  IMAGES_JSON="$(
    printf '['
    first=1
    while IFS='|' read -r svc img; do
      [ -n "$svc" ] || continue
      [ "$first" = 1 ] || printf ','
      first=0
      printf '{"service":"%s","image":"%s"}' "$(json_escape "$svc")" "$(json_escape "$img")"
    done < <(dc ps --format '{{.Service}}|{{.Image}}' 2>/dev/null || true)
    printf ']'
  )"
fi

MINIO_ARCHIVE_JSON='null'
[ -n "$MINIO_VOL" ] && MINIO_ARCHIVE_JSON='"minio/minio-data.tar.gz"'

write_manifest() {
  cat <<EOF
{
  "schema": "apolla-backup/v1",
  "name": "$(json_escape "$NAME")",
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "hostname": "$(json_escape "$(hostname 2>/dev/null || echo unknown)")",
  "apollaVersion": "$(json_escape "$APOLLA_VERSION")",
  "git": { "commit": "$(json_escape "$GIT_COMMIT")", "branch": "$(json_escape "$GIT_BRANCH")" },
  "compose": {
    "project": "$(json_escape "$PROJECT")",
    "file": "$(json_escape "$(basename "$COMPOSE_FILE")")",
    "dockerVersion": "$(json_escape "$DOCKER_VERSION")",
    "composeVersion": "$(json_escape "$COMPOSE_VERSION")"
  },
  "postgres": {
    "user": "$(json_escape "$DB_USER")",
    "database": "$(json_escape "$DB_NAME")",
    "serverVersion": "$(json_escape "$PG_VERSION")",
    "dumpFormat": "custom",
    "dumpFile": "postgres/${DB_NAME}.dump"
  },
  "minio": {
    "volume": "$(json_escape "$MINIO_VOL")",
    "archive": $MINIO_ARCHIVE_JSON
  },
  "images": $IMAGES_JSON,
  "warnings": [
    "config/.env 含主密钥 APOLLA_MASTER_KEY 与数据库/对象存储口令，本备份属敏感数据，须加密存放并限制访问",
    "恢复目标的 PostgreSQL 大版本必须 >= 备份来源版本"
  ]
}
EOF
}
if [ "$DRY_RUN" = 1 ]; then
  say "    [dry-run] 将写入 $DEST/manifest.json，内容形如："
  write_manifest | sed 's/^/      /'
else
  write_manifest > "$DEST/manifest.json"
  say "    ✓ manifest.json"
fi

# ——— 6) SHA256SUMS ———
step "生成 SHA256SUMS"
if [ "$DRY_RUN" = 1 ]; then
  say "    [dry-run] 将为备份目录内全部文件（除 SHA256SUMS / .INCOMPLETE）生成校验和"
else
  (
    cd "$DEST"
    : > SHA256SUMS
    find . -type f ! -name SHA256SUMS ! -name .INCOMPLETE | LC_ALL=C sort | while IFS= read -r f; do
      [ -n "$f" ] || continue
      sha256_tool "$f" >> SHA256SUMS
    done
  )
  say "    ✓ SHA256SUMS（$(wc -l < "$DEST/SHA256SUMS" | tr -d ' ') 个文件）"
  rm -f "$DEST/.INCOMPLETE"
fi

# ——— 7) 保留策略 ———
if [ "$KEEP" -gt 0 ]; then
  step "应用保留策略（保留最近 $KEEP 份）"
  ALL=()
  if [ -d "$OUT_ROOT" ]; then
    while IFS= read -r d; do
      [ -n "$d" ] && ALL+=("$d")
    done < <(find "$OUT_ROOT" -maxdepth 1 -type d -name 'apolla-backup-*' 2>/dev/null | LC_ALL=C sort)
  fi
  TOTAL=${#ALL[@]}
  if [ "$TOTAL" -le "$KEEP" ]; then
    say "    现有 $TOTAL 份，未超过 $KEEP，无需清理"
  else
    DELETE_N=$((TOTAL - KEEP))
    say "    现有 $TOTAL 份，删除最旧的 $DELETE_N 份（目录名带时间戳，字典序即时间序）"
    i=0
    while [ "$i" -lt "$DELETE_N" ]; do
      say "    - 删除 ${ALL[$i]}"
      run rm -rf "${ALL[$i]}"
      i=$((i + 1))
    done
  fi
fi

# ——— 8) 汇总 ———
trap - EXIT
say ""
if [ "$DRY_RUN" = 1 ]; then
  say "✅ DRY-RUN 结束：以上为将执行的动作，未产生任何改动。"
  say "   去掉 --dry-run 即可真正备份到：$DEST"
else
  say "✅ 备份完成：$DEST"
  say "   总大小：$(du -sh "$DEST" | cut -f1 | tr -d ' ')"
  say ""
  warn "本备份含密钥（config/.env 中的 APOLLA_MASTER_KEY、数据库与对象存储口令）。"
  warn "请按公司密级加密存放（如 age/gpg 加密后再传异地），并严格限制目录权限。"
  say ""
  say "下一步："
  say "  校验：bash infra/backup/verify-backup.sh \"$DEST\""
  say "  恢复：bash infra/backup/restore.sh \"$DEST\" --yes"
fi
