# @apolla/desktop — Apolla Work 桌面客户端（Electron）

面向企业 AI 智能体平台「Apolla Work」的桌面应用（PRD T-302，M3）。核心价值是 **本地执行模式**：把 `apps/server` 以 `local` 执行器 + SQLite + 本地文件存储在用户机器上跑起来，**无需任何部署**，数据只留在本机。

## 它做了什么

启动时，Electron 主进程会：

1. 探测从 `3001` 起的第一个空闲端口；
2. 组装本地执行模式环境并 **spawn 内嵌 server 子进程**（`node apps/server/dist/main.js`），注入：
   - `SERVE_WEB=1`（让 server 用 `@fastify/static` 托管 `apps/web/dist`）
   - `EXECUTOR=local`、`STORAGE_DRIVER=fs`、`QUEUE_DRIVER=inproc`、`AUTH_MODE=dev`（零外部依赖）
   - `STORAGE_DIR=<userData>/storage`、`DATABASE_URL_PRISMA=file:<userData>/apolla.db`
   - `WEB_DIST=<web/dist 绝对路径>`
   - `MODEL_DEFAULT` / `MODEL_BASE_URL` / `MODEL_API_KEY`（从设置读，见下）
3. **首次启动**（SQLite 不存在时）先串行执行 `prisma db push` 建表、再跑 `apps/server/prisma/seed.ts` 灌入组织/管理员/默认工作台 —— 因为 server 侧的 PrismaClient 不会自动建表；
4. 轮询 `http://127.0.0.1:<port>/api/v1/me`，返回 `200` 即认为就绪（dev 认证下该接口在 seed 完成后才 200，所以它同时代表「已启动 + 已建库」）；
5. 就绪后把 `BrowserWindow` 从内嵌加载页切到 `http://127.0.0.1:<port>`。就绪前显示中文加载页「正在启动 Apolla 本地服务…」。

退出时（`before-quit`）会 kill server 子进程。

## 与 server / web / runtime 的关系

桌面端不重复实现任何业务逻辑，只是 **宿主**：

- `apps/server`（NestJS）：被拉起的后端，同时托管前端静态资源；
- `apps/web`（Vite SPA）：由 server 在 `/` 托管，桌面端只是加载它；
- `apps/runtime`：`local` 执行器在跑智能体任务时调用；
- 仓库根 `skills/`：技能目录，server 依据其工作目录（cwd）定位。

主进程用 `src/lib/paths.ts` 统一解析这些位置：**开发态**从仓库源码定位（`apps/desktop/dist` 向上回溯仓库根）；**打包态**从 `process.resourcesPath` 定位（见「打包」）。

## 开发运行

前置：Node ≥ 22、pnpm。仓库根先安装依赖：

```bash
pnpm install
```

启动（会自动先构建 server/web/runtime 再构建本包，然后 `electron .`）：

```bash
pnpm --filter @apolla/desktop start
```

若相关包已构建过，可用快速启动（只构建本包）：

```bash
pnpm --filter @apolla/desktop run start:quick
```

单独构建（tsc 编译 `src` → `dist`，含主进程与 preload）：

```bash
pnpm --filter @apolla/desktop run build
```

> 首次启动会在应用的 userData 目录建库并灌种子（几秒）。userData 位置：
> macOS `~/Library/Application Support/Apolla Work`，Windows `%APPDATA%/Apolla Work`。

## 设置模型

菜单 **Apolla → 设置…**（`Cmd/Ctrl+,`）打开设置窗口，可填写：

- `MODEL_DEFAULT`：默认模型名，如 `qwen3:8b`；填 `mock` 用内置确定性模型（**无需 LLM 环境**即可跑通链路）。
- `MODEL_BASE_URL`：OpenAI 兼容端点，如 Ollama 的 `http://localhost:11434/v1`。
- `MODEL_API_KEY`：端点密钥（本地 Ollama 可随意填）。

保存到 `<userData>/settings.json`（仅本机，不上传）。点「保存并重启服务」即重启内嵌 server 使之生效。也可用菜单 **Apolla → 重启本地服务**。

## 安全

- `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`。
- 主窗口 preload（`src/preload.ts`）只暴露只读的 `window.apolla = { version, platform, versions }`，不开放任何 Node 能力。
- 设置窗口 preload（`src/preload-settings.ts`）仅通过 IPC 暴露 `get/save` 两个方法。
- 外部 `http(s)` 链接交系统浏览器打开，应用内不开新窗口。

## 打包（配置已写全，默认不执行）

打包目标：mac `dmg` + win `nsis`，配置见 `electron-builder.yml`（`appId: ai.apolla.work`，`productName: Apolla Work`）。

```bash
pnpm --filter @apolla/desktop run dist       # 按当前平台
pnpm --filter @apolla/desktop run dist:mac    # mac dmg
pnpm --filter @apolla/desktop run dist:win    # win nsis
```

打包时通过 `extraResources` 把 `server` / `web` / `runtime` / `skills` 落到 `Contents/Resources/` 下，主进程用 `process.resourcesPath` 定位；`server` 子进程的 cwd 设为 `<Resources>`，使 server 的 `config.ts` 中 `skillRoots[0] = <Resources>/skills` 命中。用 `process.execPath` + `ELECTRON_RUN_AS_NODE=1` 让 Electron 二进制以纯 Node 运行 server（无需另装 Node）。

> 注意（pnpm monorepo）：`extraResources` 需要把各子包的 `node_modules` 一并打入。pnpm 的符号链接结构对打包不友好，实际出包前建议对被内嵌的包用 `node-linker=hoisted` 或 `pnpm deploy` 生成扁平化 `node_modules`；`seed.ts` 通过 `tsx` 运行，故 server 的 `node_modules` 需包含 `prisma` 与 `tsx`。本仓库不实际执行 electron-builder（下载体积大），上述为配置说明。

## 测试

```bash
# 纯函数单元测试（无需 Electron / server / 网络）：端口探测、环境组装、就绪轮询、设置读写、路径解析、建库前置。
pnpm --filter @apolla/desktop run build
pnpm --filter @apolla/desktop test

# 集成冒烟（真实拉起内嵌 server，不含 GUI）：需先构建 server/web/runtime。
pnpm --filter @apolla/server --filter @apolla/web --filter @apolla/runtime run build
pnpm --filter @apolla/desktop run smoke
```

**关于 GUI 冒烟**：Electron 的窗口需要显示环境，无法在无显示（headless/CI）环境启动，这是正常的。因此本包把所有可测逻辑抽到 `src/lib`（不 import electron），用上面的 `test` 覆盖纯函数、用 `smoke` 覆盖「拉起 server → 建库 → seed → 托管前端 → 接口连通」的端到端链路。**完整 GUI 冒烟请在有显示环境的机器上执行 `pnpm --filter @apolla/desktop start` 人工验证。**

## 目录结构

```
apps/desktop/
├─ src/
│  ├─ main.ts              # Electron 主进程：窗口 / 菜单 / IPC / 生命周期
│  ├─ preload.ts           # 主窗口 preload（最小只读桥）
│  ├─ preload-settings.ts  # 设置窗口 preload（IPC 桥）
│  ├─ ui/pages.ts          # 内嵌页面（加载 / 错误 / 缺构建 / 设置），data URL
│  └─ lib/                 # 纯逻辑（可无显示环境单测）
│     ├─ paths.ts          # 开发/打包两态路径解析
│     ├─ net.ts            # 空闲端口探测
│     ├─ env.ts            # server 环境变量组装
│     ├─ ready.ts          # 就绪轮询
│     ├─ settings.ts       # settings.json 读写
│     ├─ database.ts       # 首启建库（db push + seed）
│     └─ orchestrator.ts   # 完整拉起编排
├─ test/
│  ├─ unit.cjs             # 纯函数单元测试
│  └─ smoke.cjs            # 集成冒烟（真实拉起 server）
├─ electron-builder.yml    # 打包配置（mac dmg + win nsis）
├─ tsconfig.json           # CommonJS 输出（Electron 主进程最稳）
└─ package.json
```
