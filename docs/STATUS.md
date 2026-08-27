# Apolla Work 开发状态

> 快照日期：2026-08-28。任务编号对应 [PRD §7](PRD.md)。图例：✅ 完成并验证 · 🟡 部分/已搭骨架 · ⬜ 未开始。

## 汇总

- **可运行**：`pnpm dev` 起服务，浏览器打开即用（mock 模型零依赖跑通全链路）。
- **质量门**：37 个单元/集成测试（protocol 7 · agent-tools 15 · runtime 9 · server 6）+ 10/10 黄金场景（`pnpm eval`）全绿。
- **已构建包**：`protocol` `agent-tools` `runtime` `server` `web` `knowledge` + 6 内置技能 + 部署制品。

## M0 · 骨架与技术验证

| 任务 | 状态 | 说明 |
|---|---|---|
| T-001 Monorepo | ✅ | pnpm workspaces，6 包统一构建/测试 |
| T-002 开发基础设施 | 🟡 | compose.dev.yml 就绪（PG/Valkey/MinIO/Qdrant/LiteLLM）；开发默认走 SQLite+fs 无需启动 |
| T-003 protocol | ✅ | zod 事件/工具/DTO；7 测试 |
| T-004 模型网关 | ✅ | 模型工厂（OpenAI 兼容 + mock）+ LiteLLM 配置 |
| T-005 Agent Loop | ✅ | 流式 + 工具调用 + 取消 + 压缩 |
| T-006 核心工具 | ✅ | Read/Write/Edit/Glob/Grep/Bash + 危险规则；15 测试 |
| T-007 沙箱镜像 | 🟡 | Dockerfile + sandbox-main 入口就绪；镜像未在本机构建 |
| T-009 CLI 试跑器 | ✅ | `apolla-dev run` |
| T-010 黄金评测 | ✅ | 10 场景，含安全闸门；发布门 |
| T-011 模型定档 | 🟡 | 评测框架就绪；待接真实模型跑分定默认路由 |

## M1 · MVP

| 任务 | 状态 | 说明 |
|---|---|---|
| T-101 数据库 Schema | ✅ | 22 表，Prisma；SQLite↔PG 可移植 |
| T-102 任务服务与状态机 | ✅ | 队列+并发+预热概念；LocalExecutor 跑通 |
| T-103 事件网关 | ✅ | SSE + 持久化 + Last-Event-ID 回放；6 测试证 replay==live |
| T-104 文件与产物 | ✅ | 上传/下载/预览；产物面板 |
| T-105 审批 | ✅ | 生命周期 + 本任务全允许 |
| T-106 权限模式 | ✅ | ask/plan/auto |
| T-107 上下文管理 | ✅ | 计量 + 压缩 + 计划外化 |
| T-108 技能加载 | ✅ | SKILL.md 渐进披露 |
| T-109 MCP 客户端 | ✅ | stdio；2 集成测试 |
| T-110 内置技能 6 件 | ✅ | docx/xlsx/pptx/pdf/dataviz/finance |
| T-111 WebFetch/Search | ✅ | 域白名单 + SearxNG 可选 |
| T-112–116 前端 | ✅ | WorkBuddy 式 UI：侧栏/欢迎/流式时间线/审批/产物/文件/会话回放 |
| T-117 Keycloak/SSO | 🟡 | dev 免登录可用；OIDC guard 留桩，待接 Keycloak |
| T-118 审计与用量 | ✅ | 拦截留痕 + usage 汇总 |
| T-119 管理后台 | ✅ | 模型/用量/审计（雏形，见 Admin 页） |
| T-120 部署 | ✅ | compose.prod + 服务/沙箱 Dockerfile + install.sh |
| T-121 OTel/Langfuse | ⬜ | 依赖已列，未接线 |
| T-122 评测回归/内测 | 🟡 | 评测回归就绪；内测待真实模型 |

## M2 · 企业化

| 任务 | 状态 | 说明 |
|---|---|---|
| T-201 解析管道 | 🟡 | txt/md/csv 原生解析 + 分块（stdlib）；pdf/docx 需 pypdf/python-docx |
| T-202 检索与引用 | ✅ | FTS5 + CJK bigram + BM25 + 引用溯源；经 MCP `kb_search` 暴露；1 集成测试 |
| T-203 资料库 UI | ⬜ | 后端可用；管理页未建 |
| T-204 自动化 | ✅ | croner 定时 + 触发 + 运行历史 |
| T-205/206 IM 通道 | ⬜ | SDK 依赖已列；需 Bot 凭据接线 |
| T-207 Connector Hub | 🟡 | 运行时 MCP 客户端 + 凭据信封加密就绪；集中注册 UI 未建 |
| T-208 子代理/专家 | ✅ | Agent 工具 + 3 内置专家；2 测试 |
| T-209 管理后台完整 | 🟡 | 看板/审计有雏形；配额中心待补 |
| T-210 沙箱加固 | 🟡 | 出网白名单 + safe-bin 语义 + 非 root；gVisor 待 K8s 启用 |
| T-211/212 K8s/离线包 | ⬜ | 单机 compose 就绪；Helm/airgap 待做 |
| T-213 安全冲刺 | 🟡 | 提示注入基线（外部内容标记为数据）+ 路径/危险命令闸门（评测覆盖）；红队集待扩 |

## M3 · 生态与桌面

| 任务 | 状态 |
|---|---|
| T-301 技能/连接器市场 | ⬜ |
| T-302 桌面壳 Electron | ⬜ |
| T-303 评测-微调闭环 | ⬜ |
| T-304 信创适配 | ⬜ |
| T-305 多模态技能 | ⬜ |

## 接真实模型

默认 `MODEL_DEFAULT=mock`（确定性，验证链路）。设以下环境变量即接入任意 OpenAI 兼容端点（vLLM/LiteLLM/云）：
```
MODEL_BASE_URL=http://<litellm>/v1  MODEL_API_KEY=<key>  MODEL_DEFAULT=<model-name>
```
届时黄金场景脚本从 mock 脚本改为自然语言 prompt，校验点复用（T-011/T-122）。
