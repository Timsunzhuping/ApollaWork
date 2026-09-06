#!/usr/bin/env bash
# =============================================================================
# 备份恢复演练（T-415）—— 备份没恢复过等于没有备份。
#
# 在**隔离的 compose 项目** apolla-drill 里走完整流程，不碰生产栈：
#   1) backup.sh 给当前生产栈做一份带 drill 标签的备份
#   2) verify-backup.sh 校验
#   3) 起一套空的 apolla-drill 栈（端口 3901，独立卷）
#   4) restore.sh --yes -p apolla-drill 把备份恢复进去
#   5) /readyz 就绪 + 任务/审计行数与源库核对
#   6) 销毁演练栈（含卷）
# 任一步失败非零退出。产出摘要写到 <备份目录>/DRILL_RESULT.txt，作为上线/审计留证。
#
# 用法：bash infra/backup/drill.sh [--keep]   # --keep 保留演练栈供人工检查
# =============================================================================
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROD="$REPO_ROOT/infra/compose/compose.prod.yml"
OVERRIDE="$REPO_ROOT/infra/backup/compose.drill.yml"
DRILL_PROJECT="apolla-drill"
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

MERGED="$(mktemp -t apolla-drill-compose.XXXXXX.yml)"
cleanup() {
  if [ "$KEEP" = 0 ]; then
    docker compose -p "$DRILL_PROJECT" -f "$MERGED" down -v --remove-orphans >/dev/null 2>&1 || true
  else
    echo "保留演练栈：docker compose -p $DRILL_PROJECT -f $MERGED down -v 以销毁"
  fi
  [ "$KEEP" = 0 ] && rm -f "$MERGED"
}
trap cleanup EXIT

step() { printf '\n==> %s\n' "$*"; }

step "1/6 备份生产栈"
BACKUP_DIR="$(bash "$REPO_ROOT/infra/backup/backup.sh" --label drill | grep -oE '[^ ]*apolla-backup-[^ ]*' | tail -1)"
[ -d "$BACKUP_DIR" ] || { echo "❌ 未找到备份目录输出"; exit 1; }
echo "备份目录：$BACKUP_DIR"

step "2/6 校验备份"
bash "$REPO_ROOT/infra/backup/verify-backup.sh" "$BACKUP_DIR"

step "3/6 起空的演练栈（$DRILL_PROJECT，端口 3901）"
docker compose -f "$PROD" -f "$OVERRIDE" config > "$MERGED"
docker compose -p "$DRILL_PROJECT" -f "$MERGED" up -d postgres minio valkey
sleep 8

step "4/6 恢复到演练栈"
bash "$REPO_ROOT/infra/backup/restore.sh" "$BACKUP_DIR" --yes -p "$DRILL_PROJECT" -f "$MERGED" --no-pre-backup --skip-verify

step "5/6 核对"
for i in $(seq 1 30); do
  if curl -fsS http://localhost:3901/readyz >/dev/null 2>&1; then break; fi
  sleep 3
  [ "$i" = 30 ] && { echo "❌ 演练栈 60s 内未就绪"; docker compose -p "$DRILL_PROJECT" -f "$MERGED" logs server | tail -30; exit 1; }
done
count() { docker compose -p "$1" -f "$2" exec -T postgres psql -U apolla -d apolla -tAc "select count(*) from \"$3\"" | tr -d '[:space:]'; }
SRC_TASKS="$(count apolla "$PROD" Task)"; DST_TASKS="$(count "$DRILL_PROJECT" "$MERGED" Task)"
SRC_AUDIT="$(count apolla "$PROD" AuditEvent)"; DST_AUDIT="$(count "$DRILL_PROJECT" "$MERGED" AuditEvent)"
echo "Task：源 $SRC_TASKS / 恢复 $DST_TASKS · AuditEvent：源 $SRC_AUDIT / 恢复 $DST_AUDIT"
# 源库在备份后可能又有新写入：恢复库行数应 ≤ 源库且 ≥ 备份时刻（这里要求 ≥ 源库的 95%）
python3 - "$SRC_TASKS" "$DST_TASKS" "$SRC_AUDIT" "$DST_AUDIT" <<'PY'
import sys
s_t, d_t, s_a, d_a = map(int, sys.argv[1:5])
ok = d_t >= int(s_t * 0.95) and d_a >= int(s_a * 0.95)
print("✅ 行数核对通过" if ok else "❌ 恢复库行数明显少于源库")
sys.exit(0 if ok else 1)
PY

step "6/6 记录"
{
  echo "drill_at=$(date -u +%FT%TZ)"
  echo "backup_dir=$BACKUP_DIR"
  echo "tasks_src=$SRC_TASKS tasks_restored=$DST_TASKS"
  echo "audit_src=$SRC_AUDIT audit_restored=$DST_AUDIT"
  echo "result=PASS"
} > "$BACKUP_DIR/DRILL_RESULT.txt"
echo "✅ 恢复演练通过，记录：$BACKUP_DIR/DRILL_RESULT.txt"
