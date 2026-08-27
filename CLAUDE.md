# Apolla Work（ApollaCowork）

企业级 AI 智能体工作台：对标腾讯 WorkBuddy，Web 优先、服务端沙箱执行、全链路私有化部署。

## 单一事实来源

- **[docs/PRD.md](docs/PRD.md)** 是产品与工程的 SSOT：功能需求（§2）、架构（§4）、技术栈定稿（§5）、任务分解（§7）、工具/事件/技能规格（附录 A/B/C）。
- 本文件只放工程惯例与当前状态；与 PRD 冲突时以 PRD 为准。
- 架构决策变更 → 在 `docs/adr/` 增加一条 `ADR-NNN-标题.md`（背景/决策/后果，10 行内）。

## 当前阶段

**M0 · 骨架与技术验证**（任务 T-001 起）。仓库目前只有文档，尚未初始化代码。

## 开发工作流

1. 从 PRD §7 按顺序领取下一个未勾选任务 `T-xxx`；不跳里程碑、不并行开远超当前任务范围的坑。
2. 实现须满足该任务的 **DoD** 才算完成；完成后勾选 PRD 中的复选框，并在提交信息中引用任务号（如 `feat(runtime): agent loop v0 [T-005]`）。
3. 类型先行：事件、DTO、工具入参一律先在 `packages/protocol` 用 zod 定义，server/runtime/web 从那里导入；改 schema 必须升 payload 版本号 `v`。
4. 每个任务：先写最小可运行版本 + 对应测试，再补边界；不做 PRD 之外的「顺手优化」。

## 技术基线（详见 PRD §5，不得擅自更换）

- TypeScript 5.9 / Node ≥22 / pnpm 10 + turborepo；Python 3.12 仅用于 `apps/knowledge` 与技能脚本。
- 前端 React 19 + Vite + TanStack Query + zustand + Tailwind 4 + shadcn/ui + ECharts。
- 服务端 NestJS 11（Fastify 适配器）+ Prisma 6 + PostgreSQL 16 + BullMQ（Valkey）。
- runtime 无框架纯 TS；沙箱 = Docker 容器（镜像见 `infra/sandbox`）；模型一律经 LiteLLM 网关（禁止在代码中写死模型名）。
- 对象存储 MinIO（S3 协议）；向量库 Qdrant。

## 目录约定

```
apps/{web,server,runtime,knowledge,im-bridge}
packages/{protocol,agent-tools}
skills/        # SKILL.md 规范见 PRD 附录 C
infra/{compose,sandbox,litellm,keycloak,helm}
eval/          # 黄金场景评测（发布闸门）
docs/{PRD.md,adr/}
```

## 常用命令（T-001/T-002 落地后生效）

```bash
pnpm i && pnpm build && pnpm test          # 全仓构建与测试
docker compose -f infra/compose/compose.dev.yml up -d   # 开发基础设施
pnpm eval                                   # 跑黄金场景评测
```

## 红线

- 不复制 WorkBuddy/CodeBuddy 的代码、提示词、模板与素材；兼容其开放格式（SKILL.md/MCP/ACP）是允许的。
- 不引入 PRD §5.3 排除的重型依赖（LangChain 系、Kafka、Service Mesh 等）。
- 安全默认值不放松：沙箱默认禁出网、审批规则表不绕过、密钥不落明文、审计事件不可删。
- 中文注释与文档；用户可见文案走 i18n key。
