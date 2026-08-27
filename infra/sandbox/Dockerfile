# Apolla Work 任务沙箱镜像（PRD §4.5 / T-007）
# ubuntu24 + node22 + python3.12(uv) + LibreOffice + 中文字体 + 常用数据/文档库。
# 每个任务在此镜像的一个容器实例中执行（非 root、资源受限、出网白名单）。
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    PYTHONIOENCODING=utf-8 \
    PIP_NO_CACHE_DIR=1

# 系统依赖：python、libreoffice（office→pdf 预览与转换）、中文字体、ripgrep、常用工具
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

# Python 数据/文档栈（与内置技能对齐：pandas/openpyxl/python-docx/python-pptx/pypdf/matplotlib/pdfplumber）
RUN pip3 install --break-system-packages \
      pandas openpyxl python-docx python-pptx pypdf pdfplumber \
      matplotlib tabulate lxml Pillow

# 内置技能与 runtime 产物（构建时从仓库拷入）
WORKDIR /opt/apolla
COPY skills /opt/apolla/skills
COPY apps/runtime/dist /opt/apolla/runtime/dist
COPY apps/runtime/node_modules /opt/apolla/runtime/node_modules
COPY packages /opt/apolla/packages

# 非 root 执行用户
RUN useradd -m -u 1001 apolla && mkdir -p /workspace && chown apolla:apolla /workspace
USER apolla
WORKDIR /workspace

# 由 DockerExecutor 以 `node /opt/apolla/runtime/dist/sandbox-main.js` 启动
CMD ["node", "/opt/apolla/runtime/dist/sandbox-main.js"]
