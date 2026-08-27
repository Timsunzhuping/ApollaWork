#!/usr/bin/env bash
# =============================================================================
# Apolla Work 离线安装包打包脚本（PRD T-212）
#
# 在“有镜像的机器”（联网构建机 / CI）上运行，产出可拷贝到无外网环境的安装包：
#   bash infra/airgap-pack.sh
#
# 产物：
#   dist-airgap/                    离线包目录（可整体拷贝）
#     images/*.tar.gz               docker save 的各镜像（gzip 压缩）
#     compose/compose.prod.yml      生产编排文件
#     litellm/config.yaml           模型网关配置（compose 以 ../litellm/ 相对路径挂载）
#     install.sh                    目标机安装脚本（即 infra/airgap-install.sh）
#     manifest.json                 镜像清单（docker image inspect 输出，SBOM 占位）
#     VERSION                       打包时的 APOLLA_VERSION
#     SHA256SUMS                    全部文件校验和
#   apolla-airgap-<版本>-<日期>.tar  上述目录的单文件归档（便于拷贝）
#
# 可重复执行：每次运行先清空 dist-airgap/ 重新生成。
# 镜像缺失时：打印警告并跳过该镜像，照样产出包（目标机需自行准备缺失镜像）。
#
# 环境变量：
#   APOLLA_VERSION  apolla-server / apolla-sandbox 的镜像标签（默认 dev）
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.." # 切到仓库根目录

APOLLA_VERSION="${APOLLA_VERSION:-dev}"
OUT="dist-airgap"

# 需要打包的镜像清单（与 infra/compose/compose.prod.yml 对齐）
IMAGES=(
  "postgres:16-alpine"
  "valkey/valkey:8-alpine"
  "minio/minio:latest"
  "ghcr.io/berriai/litellm:main-latest"
  "apolla-server:${APOLLA_VERSION}"
  "apolla-sandbox:${APOLLA_VERSION}"
)

# sha256 工具适配（Linux 用 sha256sum，macOS 用 shasum -a 256）
sha256_tool() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$@"
  else
    shasum -a 256 "$@"
  fi
}

echo "==> Apolla Work 离线包打包（版本：${APOLLA_VERSION}）"

# 0) 环境检查
command -v docker >/dev/null 2>&1 || { echo "❌ 缺少 docker，无法导出镜像"; exit 1; }
command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 \
  || { echo "❌ 缺少 sha256sum/shasum，无法生成校验和"; exit 1; }

# 1) 重建输出目录（保证每次产出一致、可重复执行）
rm -rf "$OUT"
mkdir -p "$OUT/images" "$OUT/compose" "$OUT/litellm"

# 2) 导出镜像（缺失则警告并跳过，不中断打包）
MISSING=()  # 本机不存在、未能打包的镜像
PRESENT=()  # 成功打包的镜像
for img in "${IMAGES[@]}"; do
  if docker image inspect "$img" >/dev/null 2>&1; then
    file="$OUT/images/$(echo "$img" | tr '/:' '__').tar.gz"
    echo "==> 导出镜像 $img"
    docker save "$img" | gzip > "$file"
    echo "    → $file（$(du -h "$file" | cut -f1 | tr -d ' ')）"
    PRESENT+=("$img")
  else
    echo "⚠️  警告：本机不存在镜像 $img，已跳过（目标机需另行准备该镜像）"
    MISSING+=("$img")
  fi
done

# 3) 生成镜像清单 manifest.json（SBOM 占位：docker image inspect 的完整 JSON。
#    真正的 SBOM（syft/SPDX）属后续任务，见 docs/PRD.md T-212 DoD）
if [ "${#PRESENT[@]}" -gt 0 ]; then
  docker image inspect "${PRESENT[@]}" > "$OUT/manifest.json"
else
  echo "[]" > "$OUT/manifest.json"
fi
echo "==> 已生成镜像清单 $OUT/manifest.json（${#PRESENT[@]} 个镜像）"

# 4) 拷贝部署制品：compose 文件 + litellm 配置 + 安装脚本
#    目录结构保持 compose/ 与 litellm/ 平级，compose.prod.yml 中
#    ../litellm/config.yaml 的相对挂载路径在包内依然成立。
cp infra/compose/compose.prod.yml "$OUT/compose/compose.prod.yml"
cp infra/litellm/config.yaml "$OUT/litellm/config.yaml"
cp infra/airgap-install.sh "$OUT/install.sh"
chmod +x "$OUT/install.sh"
echo "$APOLLA_VERSION" > "$OUT/VERSION"
echo "==> 已拷贝 compose 编排、LiteLLM 配置与安装脚本"

# 5) 生成 SHA256SUMS（覆盖包内除自身外的全部文件；路径为包内相对路径）
(
  cd "$OUT"
  files="$(find . -type f ! -name SHA256SUMS | LC_ALL=C sort)"
  : > SHA256SUMS
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    sha256_tool "$f" >> SHA256SUMS
  done <<< "$files"
)
echo "==> 已生成校验和 $OUT/SHA256SUMS（$(wc -l < "$OUT/SHA256SUMS" | tr -d ' ') 个文件）"

# 6) 归档为单文件（镜像已 gzip，归档不再压缩）
PKG="apolla-airgap-${APOLLA_VERSION}-$(date +%Y%m%d).tar"
tar -cf "$PKG" "$OUT"
echo "==> 已归档 $PKG（$(du -h "$PKG" | cut -f1 | tr -d ' ')）"

# 7) 汇总
echo ""
echo "✅ 打包完成：$OUT/（归档：$PKG）"
if [ "${#MISSING[@]}" -gt 0 ]; then
  echo "⚠️  注意：以下镜像本次未打包（本机不存在），目标机安装前需自行 docker load/构建："
  for img in "${MISSING[@]}"; do echo "    - $img"; done
  echo "    提示：apolla-server/apolla-sandbox 可先执行 infra/install.sh 或手动 docker build 后重新打包。"
fi
echo ""
echo "下一步：把 $PKG 拷贝到目标机，解包后执行安装："
echo "  tar -xf $PKG && cd $OUT && bash install.sh"
