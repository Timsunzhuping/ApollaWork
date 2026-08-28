# 生产配置部署演练记录

> 2026-08-29。这是一次**真实执行**的部署演练，不是文档推演。
> 目的：在上真环境前，验证「生产配置」本身能不能跑起来。

## 演练范围与结果

| 生产项 | 配置 | 结果 |
|---|---|---|
| 数据库 | PostgreSQL 16（**`migrate deploy`，非 db push**） | ✅ 18 张表建成 |
| 对象存储 | MinIO（`STORAGE_DRIVER=s3`） | ✅ 上传与产物回写均落桶 |
| 队列 | BullMQ + Redis 7 | ✅ 7 个 job 完成 |
| 事件分发 | Redis Pub/Sub（`CLUSTER_MODE=1`） | ✅ 跨副本可见 |
| 副本数 | 2（:3001 / :3002） | ✅ 双副本同时服务 |
| 日志 | JSON 结构化 | ✅ |
| 数据留存 | 定时清理已启用 | ✅ 任务 180 / 用量 400 / 审计 730 天 |
| 主密钥 | 随机 32 字节 | ✅ preflight 通过 |
| CORS | 明确来源 | ✅ preflight 通过 |

**端到端验证**：文件上传 → 任务在副本 A 创建执行 → **副本 B 读到完整结果** →
产物写回 S3 → 计算正确（320+210=530）。
落库确认：PostgreSQL 1 任务 / 17 事件 / 1 审计；MinIO 内 `budget.csv` + `out.txt`；
Redis 内序号计数器与 BullMQ 完成队列。

## Preflight 闸门的实际表现

用真实生产配置启动时，`NODE_ENV=production` 下 preflight **拒绝启动**并列出 3 项：

```
[AUTH_MODE]     dev 模式免登录 → 设 AUTH_MODE=oidc
[EXECUTOR]      local 执行器把宿主 shell 开放给所有用户 → 设 EXECUTOR=docker
[SKILLS_VOLUME] 多副本下技能安装目录未共享 → 挂共享卷
生产就绪检查未通过（3 项）
```

它**没有**报主密钥、存储驱动、队列驱动、CORS —— 说明这四项在本次配置下确实合规。
闸门按设计工作：只报真问题，且每条都给可执行的修复命令。

本次演练用 `ALLOW_INSECURE_PRODUCTION=1` 显式豁免那 3 项以完成数据路径验证。
**真实上线时不得使用该豁免。**

## 仍未验证的三项（都缺外部依赖，不是代码问题）

| 项 | 缺什么 | 上线前必做 |
|---|---|---|
| `AUTH_MODE=oidc` | Keycloak 镜像拉不下来（本机 Docker 代理限制） | 部署 Keycloak，导入 `infra/keycloak/apolla-realm.json`，用真实账号走通登录 |
| `EXECUTOR=docker` | 沙箱镜像需 node/ubuntu 基础镜像，同样拉不动 | `docker build -f infra/sandbox/Dockerfile -t apolla-sandbox:1.0 .` 并跑一个容器模式任务 |
| `SKILLS_VOLUME` | 多副本需共享卷 | 给 `{STORAGE_DIR}/installed-skills` 挂 NFS / RWX PVC；单副本部署可忽略 |

## 复现本次演练

```bash
# 数据服务
docker run -d --name apolla-pg -e POSTGRES_USER=apolla -e POSTGRES_PASSWORD=<pw> \
  -e POSTGRES_DB=apolla -p 5455:5432 postgres:16-alpine
docker run -d --name apolla-redis -p 6390:6379 redis:7-alpine
docker run -d --name apolla-minio -p 9010:9000 \
  -e MINIO_ROOT_USER=apolla -e MINIO_ROOT_PASSWORD=<pw> minio/minio server /data

# 迁移（注意：schema.prisma 的 provider 需改为 postgresql）
cd apps/server && DATABASE_URL_PRISMA="postgresql://..." npx prisma migrate deploy
DATABASE_URL_PRISMA="postgresql://..." npx tsx prisma/seed.ts

# 起服务（生产配置）
NODE_ENV=production STORAGE_DRIVER=s3 QUEUE_DRIVER=bullmq CLUSTER_MODE=1 \
  APOLLA_MASTER_KEY=$(openssl rand -hex 32) ALLOWED_ORIGINS=https://<域名> \
  AUTH_MODE=oidc EXECUTOR=docker node apps/server/dist/main.js
```

> 演练中 `schema.prisma` 的 provider 需在 sqlite / postgresql 间切换。
> 这是当前设计的已知摩擦点（见 [ADR-002](adr/ADR-002-dev-datastore.md)），
> 上线时应固定为 postgresql 并把 sqlite 仅留给本地开发。
