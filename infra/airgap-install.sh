#!/usr/bin/env bash
# =============================================================================
# Apolla Work 离线安装脚本（PRD T-212）
#
# 在“无外网的目标机”上运行。前提：目标机已安装 docker 与 docker compose v2。
# 用法（在解包后的离线包目录内，包内此脚本名为 install.sh）：
#   tar -xf apolla-airgap-<版本>-<日期>.tar
#   cd dist-airgap
#   bash install.sh
#
# 步骤：校验 SHA256 → docker load 全部镜像 → 生成 .env（若无）→
#       docker compose up -d → 健康检查循环。
# 可重复执行：已有 .env 会保留；docker load 与 compose up 均幂等。
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")" # 切到离线包目录（脚本所在目录）

COMPOSE_FILE="compose/compose.prod.yml"
ENV_FILE=".env"

# sha256 工具适配（Linux 用 sha256sum，macOS 用 shasum -a 256）
sha256_verify() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -c "$1"
  else
    shasum -a 256 -c "$1"
  fi
}

# 随机十六进制串（无 openssl 时退化用 /dev/urandom + od）
rand_hex() {
  local n="$1"
  openssl rand -hex "$n" 2>/dev/null \
    || head -c "$n" /dev/urandom | od -An -tx1 | tr -d ' \n'
}

echo "==> Apolla Work 离线安装"

# 1) 环境检查
command -v docker >/dev/null 2>&1 || { echo "❌ 缺少 docker，请先安装（离线环境可用 docker 官方二进制包/发行版源）"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "❌ 缺少 docker compose v2（compose 插件），请先安装"; exit 1; }
docker info >/dev/null 2>&1 || { echo "❌ docker 守护进程未运行或当前用户无权限（可尝试 sudo 或加入 docker 组）"; exit 1; }
[ -f "$COMPOSE_FILE" ] || { echo "❌ 未找到 $COMPOSE_FILE —— 请在解包后的离线包目录内运行本脚本"; exit 1; }

# 2) 校验 SHA256（防止拷贝损坏/被篡改）
if [ -f SHA256SUMS ]; then
  echo "==> 校验文件完整性（SHA256）…"
  if sha256_verify SHA256SUMS >/dev/null; then
    echo "    ✅ 校验通过（$(wc -l < SHA256SUMS | tr -d ' ') 个文件）"
  else
    echo "❌ SHA256 校验失败，安装包可能损坏或不完整，请重新拷贝后再试。"
    echo "   查看失败明细：sha256sum -c SHA256SUMS | grep -v OK"
    exit 1
  fi
else
  echo "⚠️  未找到 SHA256SUMS，跳过完整性校验"
fi

# 3) 读取版本号（打包时写入；.env 已存在时以 .env 为准）
APOLLA_VERSION="dev"
[ -f VERSION ] && APOLLA_VERSION="$(cat VERSION)"
if [ -f "$ENV_FILE" ] && grep -q '^APOLLA_VERSION=' "$ENV_FILE"; then
  APOLLA_VERSION="$(grep '^APOLLA_VERSION=' "$ENV_FILE" | head -1 | cut -d= -f2)"
fi
echo "==> 部署版本：${APOLLA_VERSION}"

# 4) 导入镜像（逐个 docker load；docker load 支持 gzip 压缩包，幂等）
shopt -s nullglob
tars=(images/*.tar.gz images/*.tar)
if [ "${#tars[@]}" -eq 0 ]; then
  echo "⚠️  images/ 目录为空：跳过导入（假定目标机已预先载入所需镜像）"
else
  for f in "${tars[@]}"; do
    echo "==> 导入镜像 $f"
    docker load -i "$f" | sed 's/^/    /'
  done
fi
shopt -u nullglob

# 5) 检查必需镜像是否齐备（打包时缺失的镜像需在目标机自行准备）
REQUIRED=(
  "postgres:16-alpine"
  "valkey/valkey:8-alpine"
  "minio/minio:latest"
  "ghcr.io/berriai/litellm:main-latest"
  "apolla-server:${APOLLA_VERSION}"
  "apolla-sandbox:${APOLLA_VERSION}"
)
NOT_FOUND=()
for img in "${REQUIRED[@]}"; do
  docker image inspect "$img" >/dev/null 2>&1 || NOT_FOUND+=("$img")
done
if [ "${#NOT_FOUND[@]}" -gt 0 ]; then
  echo "❌ 以下必需镜像缺失（离线环境无法自动拉取），请先手动 docker load 后重试："
  for img in "${NOT_FOUND[@]}"; do echo "    - $img"; done
  echo "   说明：apolla-sandbox 为任务沙箱镜像（docker 执行器运行任务必需）。"
  exit 1
fi
echo "==> 必需镜像齐备（${#REQUIRED[@]} 个）"

# 6) 生成配置 .env（已存在则保留，保证可重复执行且密钥不轮换）
if [ ! -f "$ENV_FILE" ]; then
  echo "==> 生成 $ENV_FILE（随机主密钥 / DB 密码 / 存储密钥）"
  cat > "$ENV_FILE" <<EOF
APOLLA_VERSION=${APOLLA_VERSION}
APOLLA_MASTER_KEY=$(rand_hex 24)
POSTGRES_PASSWORD=$(rand_hex 12)
S3_ACCESS_KEY=apolla
S3_SECRET_KEY=$(rand_hex 12)
LITELLM_KEY=sk-apolla-$(rand_hex 6)
PORT=3001
AUTH_MODE=dev
EOF
  chmod 600 "$ENV_FILE"
  echo "    已生成随机密钥，请妥善保管 $(pwd)/$ENV_FILE（丢失主密钥将无法解密平台数据）"
else
  echo "==> 检测到已有 $ENV_FILE，沿用现有配置（不轮换密钥）"
fi
PORT="$( { grep '^PORT=' "$ENV_FILE" | head -1 | cut -d= -f2; } 2>/dev/null || true)"
PORT="${PORT:-3001}"

# 7) 启动服务栈（镜像已在本地，不会触发拉取/构建）
echo "==> 启动服务栈（docker compose up -d）"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --no-build

# 8) 健康检查循环：等待 server 就绪（最长约 3 分钟，覆盖首次数据库迁移）
echo "==> 等待 server 就绪（http://localhost:${PORT}）…"
HEALTH_OK=0
if command -v curl >/dev/null 2>&1; then
  for i in $(seq 1 90); do
    if curl -sf "http://localhost:${PORT}/api/v1/me" >/dev/null 2>&1; then
      HEALTH_OK=1
      break
    fi
    sleep 2
  done
else
  echo "⚠️  目标机无 curl，改用容器状态判断（不校验 HTTP 可用性）"
  for i in $(seq 1 90); do
    if docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" ps --status running 2>/dev/null | grep -q server; then
      HEALTH_OK=1
      break
    fi
    sleep 2
  done
fi

# 9) 结果汇总
echo ""
if [ "$HEALTH_OK" -eq 1 ]; then
  echo "✅ 部署完成 → http://localhost:${PORT}"
  echo "   配置文件：$(pwd)/$ENV_FILE"
  echo "   查看日志：docker compose -f $COMPOSE_FILE --env-file $ENV_FILE logs -f server"
  echo "   模型端点：请按需修改 litellm/config.yaml（指向企业内 vLLM/MindIE 的 OpenAI 兼容端点）后"
  echo "             docker compose -f $COMPOSE_FILE --env-file $ENV_FILE restart litellm"
  echo "   生产建议：把 $ENV_FILE 中 AUTH_MODE 改为 oidc 并对接企业 IdP（见 docs/PRD.md F1）"
else
  echo "❌ 健康检查未通过（等待约 3 分钟后 server 仍未就绪）。排查："
  echo "   docker compose -f $COMPOSE_FILE --env-file $ENV_FILE ps"
  echo "   docker compose -f $COMPOSE_FILE --env-file $ENV_FILE logs server | tail -50"
  exit 1
fi
