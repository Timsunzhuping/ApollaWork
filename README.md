# Apolla Work

企业级 AI 智能体工作台 —— 对标腾讯 WorkBuddy，但面向企业：**Web 优先、服务端沙箱执行、全链路私有化部署、数据不出内网**。

用一句话下达任务，Apolla 在隔离沙箱里自主规划、调用工具、操作文件，产出可交付的文档 / 表格 / PPT / 图表 / 网页，全程可视化、可审批、可审计。

> 完整产品与工程规格见 [docs/PRD.md](docs/PRD.md)（单一事实来源）。架构决策见 [docs/adr/](docs/adr/)。

## 能力一览

- **任务式 Agent**：自然语言 → 计划（TodoWrite）→ 工具调用（读写文件 / 执行命令 / 搜索 / 联网）→ 交付产物，SSE 实时可视化，支持中途插话、取消、断点重连回放。
- **权限模式**：`auto` / `plan` / `ask` 三档；危险命令强制审批 + 全量审计。
- **技能体系**：兼容 Claude Code 的 `SKILL.md` 约定，内置 6 个技能（Word/Excel/PPT/PDF/可视化/财报分析）。
- **连接器（MCP）**：Agent 可调用企业 MCP 连接器（`mcp__<server>__<tool>`）。
- **自动化**：cron 定时触发任务模板。
- **管理后台**：模型治理、用量看板、审计检索。
- **私有化**：单机 `docker compose` 一键部署；模型经 LiteLLM 网关指向企业自建 vLLM。

## 架构（简）

```
Web(React) ──SSE──> server(NestJS) ──> 任务管理器 ──> 执行器 ──> Agent 运行时(沙箱)
                         │                              ├─ 工具集(Read/Write/Bash/…)
                    事件总线(溯源)                       ├─ 技能(SKILL.md)
                    PostgreSQL/SQLite                    └─ MCP 连接器
                    MinIO(文件) · Valkey(队列)      模型 ──OpenAI兼容──> LiteLLM ──> vLLM
```

- **执行器**：`local`（进程内，开发默认，零容器）/ `docker`（每任务一沙箱容器，生产隔离）。
- **事件是唯一真相**：前端渲染、历史回放、审计全部由同一事件流派生（`packages/protocol` 定义）。

## 快速开始（开发，零外部依赖）

```bash
pnpm install
pnpm --filter @apolla/protocol --filter @apolla/agent-tools run build
pnpm --filter @apolla/runtime run build
# 初始化本地 SQLite 并写入种子（内置管理员 + 默认工作空间）
cd apps/server && DATABASE_URL_PRISMA="file:./dev.db" npx prisma db push && npx tsx prisma/seed.ts && cd ../..
# 启动（两个终端，或用 pnpm dev）
pnpm --filter @apolla/server run build && node apps/server/dist/main.js   # server → :3001
pnpm --filter @apolla/web run dev                                          # web → :5173
```

打开 http://localhost:5173 。默认 `MODEL_DEFAULT=mock`（确定性 Mock 模型，用于无 LLM 环境下跑通全链路）。
接真实模型：设 `MODEL_BASE_URL` / `MODEL_API_KEY` / `MODEL_DEFAULT` 指向 vLLM 或任意 OpenAI 兼容端点。

> server 用编译产物运行（`node dist/main.js`）而非 tsx —— NestJS 依赖 tsc 生成的装饰器元数据，见 [docs/adr/ADR-003](docs/adr/)。

## 命令行试跑（不启前端）

```bash
MODEL_DEFAULT=mock node apps/runtime/dist/cli.js run "<把脚本写进 [[ACTIONS]]…[[/ACTIONS]]>" --workspace ./demo --yes
```

## 测试与评测

```bash
pnpm -r run test          # 单元/集成测试（protocol/agent-tools/runtime/server）
pnpm --filter @apolla/eval exec tsx run.ts   # 10 个黄金场景（发布闸门），出 eval/report.md
```

## 私有化部署

```bash
bash infra/install.sh     # 生成密钥 → 构建镜像 → docker compose 起栈 → 自检
```

生产切换：`AUTH_MODE=oidc`（对接 Keycloak/企业 IdP）、`EXECUTOR=docker`（沙箱隔离）、
数据库切 PostgreSQL、存储切 MinIO/S3 —— 均由环境变量控制，见 [.env.example](.env.example)。

## 目录

| 路径 | 说明 |
|---|---|
| `packages/protocol` | 事件/工具/DTO 的 zod 类型（单一类型来源）|
| `packages/agent-tools` | 工具实现（Read/Write/Edit/Glob/Grep/Bash…）|
| `apps/runtime` | Agent Loop、模型接入、技能加载、MCP 客户端、沙箱入口 |
| `apps/server` | NestJS：REST + SSE 事件网关、任务编排、审批、审计、自动化、admin |
| `apps/web` | React SPA：WorkBuddy 式界面 |
| `skills/` | 内置技能（SKILL.md 规范）|
| `infra/` | compose / 沙箱镜像 / LiteLLM / 部署脚本 |
| `eval/` | 黄金场景评测（发布闸门）|

## 合规

对标 WorkBuddy 的**产品形态与开放协议**（SKILL.md / MCP / OpenAI 兼容），不复制其代码、提示词与素材。依赖以 MIT/Apache-2/BSD 为主。
