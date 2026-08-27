#!/usr/bin/env bash
# Apolla Work 一键私有化部署（PRD T-120）。
# 用法：bash infra/install.sh   （在仓库根目录运行）
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Apolla Work 私有化部署向导"

# 1) 环境探测
command -v docker >/dev/null || { echo "缺少 docker，请先安装"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "缺少 docker compose v2"; exit 1; }
if command -v nvidia-smi >/dev/null 2>&1; then
  echo "  检测到 GPU：$(nvidia-smi --query-gpu=name --format=csv,noheader | head -1)"
  echo "  → 建议在 infra/litellm/config.yaml 中把模型指向本机 vLLM 端点"
else
  echo "  未检测到 GPU：将使用外部模型端点（在 infra/litellm/config.yaml 配置 api_base/api_key）"
fi

# 2) 生成配置（主密钥、DB 密码）
ENV_FILE=infra/compose/.env
if [ ! -f "$ENV_FILE" ]; then
  echo "==> 生成 $ENV_FILE"
  cat > "$ENV_FILE" <<EOF
APOLLA_VERSION=dev
APOLLA_MASTER_KEY=$(openssl rand -hex 24 2>/dev/null || head -c48 /dev/urandom | base64 | tr -dc 'a-f0-9' | head -c48)
POSTGRES_PASSWORD=$(openssl rand -hex 12 2>/dev/null || echo apolla-$(date +%s))
S3_ACCESS_KEY=apolla
S3_SECRET_KEY=$(openssl rand -hex 12 2>/dev/null || echo apolla-secret)
LITELLM_KEY=sk-apolla-$(openssl rand -hex 6 2>/dev/null || echo dev)
PORT=3001
AUTH_MODE=dev
EOF
  echo "  已生成随机密钥（主密钥/DB/存储）。请妥善保管 $ENV_FILE。"
fi

# 3) 构建镜像（server + sandbox）
echo "==> 构建镜像（首次约需数分钟）"
docker build -f infra/sandbox/Dockerfile -t apolla-sandbox:dev . 2>&1 | tail -3 || {
  echo "提示：sandbox 镜像需要 apps/runtime/dist —— 先在本机 pnpm build，或在 CI 构建。"
}
docker compose -f infra/compose/compose.prod.yml --env-file "$ENV_FILE" build server

# 4) 启动
echo "==> 启动服务栈"
docker compose -f infra/compose/compose.prod.yml --env-file "$ENV_FILE" up -d

# 5) 自检
echo "==> 等待 server 就绪…"
for i in $(seq 1 30); do
  if curl -sf "http://localhost:${PORT:-3001}/api/v1/me" >/dev/null 2>&1; then
    echo "  ✅ server 就绪"
    break
  fi
  sleep 2
done

echo ""
echo "✅ 部署完成 → http://localhost:${PORT:-3001}"
echo "   配置文件：$ENV_FILE　日志：docker compose -f infra/compose/compose.prod.yml logs -f server"
echo "   生产请把 AUTH_MODE 改为 oidc 并配置 Keycloak/企业 IdP（见 docs/PRD.md F1）"
