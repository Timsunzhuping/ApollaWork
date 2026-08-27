# ADR-002 · 开发期数据存储用 SQLite，生产用 PostgreSQL

**背景**：PRD §5 定生产数据库为 PostgreSQL 16。但要求「单机 60 分钟内可部署 / 开发者零配置起步」，开发期拉起 PG 容器是额外摩擦。

**决策**：
- Prisma schema 只使用可移植类型（全部 String/Int/DateTime/Boolean，无 PG 原生 enum、无 `@db.*`），使 SQLite ↔ PostgreSQL 切换只需改 `datasource.provider` 与连接串。
- 开发默认 SQLite（`file:./dev.db`），无需 compose 也能跑通 server + runtime + web。
- 生产（compose.prod / Helm）用 PostgreSQL；对象存储、向量库同理提供 fs/内存降级驱动。

**后果**：
- 好处：`pnpm dev` 零外部依赖即可启动，评测与本地演示无需 Docker。
- 代价：不能用 PG 专有特性（JSONB 索引、全文检索）；M2 资料库全文检索落地时，PG 分支单独实现，SQLite 分支降级为 LIKE。
- 迁移：`prisma migrate` 的 SQLite 迁移与 PG 迁移分目录管理。
