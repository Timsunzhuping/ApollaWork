# PostgreSQL 迁移

生产使用 PostgreSQL。步骤：

1. 把 `prisma/schema.prisma` 的 `provider` 改为 `postgresql`
   （或用 `PRISMA_PROVIDER` 环境变量方案；当前保持显式改动，避免隐式行为）
2. `DATABASE_URL_PRISMA=postgresql://... npx prisma migrate deploy`

`20260828000000_init/migration.sql` 是与 SQLite 基线等价的 PG 版本，已在
PostgreSQL 16 上实跑验证（建表 + 种子 + 端到端任务 + 事件溯源全部通过）。

> schema 只使用可移植类型（String/Int/DateTime/Boolean），因此两套迁移由同一
> schema 生成，不存在分叉。见 docs/adr/ADR-002。
