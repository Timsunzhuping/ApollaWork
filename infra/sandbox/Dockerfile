# Apolla Work 任务沙箱镜像（PRD §4.5 / T-007）
# 每个任务在此镜像的一个容器实例中执行（非 root、资源受限、出网白名单）。
#
# 多阶段构建：
#   builder —— 用 pnpm 的 hoisted node-linker 装依赖并编译，产出**真实文件**
#              （pnpm 默认的 node_modules 是指向全局 store 的符号链接，
#                直接 COPY 进镜像会变成悬空链接 —— 这里在镜像内安装以避免该问题）
#   runtime —— 精简运行环境 + 编译产物

# ---------- builder ----------
FROM node:22-bookworm-slim AS builder
RUN corepack enable
WORKDIR /build
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/runtime ./apps/runtime
# hoisted：生成真实目录而非符号链接，便于跨阶段 COPY
RUN pnpm install --node-linker=hoisted --ignore-scripts --filter @apolla/runtime... \
 && pnpm --filter @apolla/protocol --filter @apolla/agent-tools run build \
 && pnpm --filter @apolla/runtime run build

# ---------- runtime ----------
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    PYTHONIOENCODING=utf-8 \
    PIP_NO_CACHE_DIR=1 \
    NODE_ENV=production

# 系统依赖：python、libreoffice（office→pdf）、中文字体、ripgrep
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git ripgrep \
      python3 python3-pip python3-venv \
      libreoffice-calc libreoffice-writer libreoffice-impress \
      fonts-noto-cjk fonts-noto-color-emoji \
      poppler-utils \
    && rm -rf /var/lib/apt/lists/*

# Node 22
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs && rm -rf /var/lib/apt/lists/*

# Python 数据/文档栈（与内置技能对齐）
RUN pip3 install --break-system-packages --no-cache-dir \
      pandas openpyxl python-docx python-pptx pypdf pdfplumber \
      matplotlib tabulate lxml Pillow

WORKDIR /opt/apolla
# 整棵目录树原样拷入：pnpm 的 workspace 依赖是**相对符号链接**
# （node_modules/@apolla/agent-tools -> ../../packages/agent-tools），
# 拆开拷会让链接指向不存在的路径 —— 之前就是这么失败的。
COPY --from=builder /build  /opt/apolla
COPY skills                 /opt/apolla/skills

# 非 root 执行用户
RUN useradd -m -u 1001 apolla && mkdir -p /workspace && chown -R apolla:apolla /workspace /opt/apolla
USER apolla
WORKDIR /workspace

# 自检：确保依赖链完整（构建期失败胜过运行期失败）
RUN node -e "require('/opt/apolla/apps/runtime/dist/index.js'); console.log('runtime ok')" \
 && python3 -c "import pandas, openpyxl, docx, pptx, pypdf, matplotlib; print('python ok')"

CMD ["node", "/opt/apolla/apps/runtime/dist/sandbox-main.js"]
