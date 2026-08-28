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

## OIDC 生产鉴权链路（已用真实 Keycloak 验证）

先用最小 OIDC 身份提供方验证逻辑，镜像源恢复后**又用真实 Keycloak 26 重跑了一遍**
（导入本仓库的 `infra/keycloak/apolla-realm.json`，用 realm 内的 admin / member 账号取真实令牌）。
两轮结果一致：

| 用例 | 期望 | 实测 |
|---|---|---|
| 无令牌访问 | 拒绝 | 403 ✅ |
| 伪造令牌（签名不匹配） | 拒绝 | 403 ✅ |
| 合法管理员令牌 | 通过 + JIT 建户 | `tim.sun@hermess.ai` / admin ✅ |
| 合法成员令牌 | realm 角色映射为 member | `bob@corp.com` / member ✅ |
| 成员访问管理端点 | 403 | 403 ✅ |
| 管理员访问管理端点 | 200 | 200 ✅ |
| 新成员可见空间 | 空（非任何空间成员） | `[]` ✅ |
| 成员用 id 探测他人空间 | 404（不泄露存在性） | 404 ✅ |

PostgreSQL 中确认 JIT 建户：`bob@corp.com / kc-bob`（ssoSubject 正确落库）。

真实 Keycloak 下另跑通了完整业务链路：建会话 → 建任务 → 执行 → 产物写回 S3 → 带令牌下载。

### 修复：realm 文件的真实缺陷

首次用真实 Keycloak 时取令牌报 `Account is not fully set up` —— realm 导入成功，
但用户带着待办动作（验证邮箱 / 更新资料）。**你们首次部署会一模一样撞上。**
已修 `apolla-realm.json`：用户 `requiredActions: []`、关闭 realm 级默认 required actions、
`verifyEmail: false`。修完即可正常签发令牌。

### 浏览器登录流程（部分验证）

在浏览器里点「Sign in with SSO」，**成功跳转到真实 Keycloak 登录页**
（页面标题为 realm 的 displayName「APOLLA WORK」，说明 client_id / redirect_uri /
PKCE challenge 都被 Keycloak 接受了）。

**未验证的最后一跳**：输入账号密码 → 回调 → 用授权码换令牌。
这一步需要人工点一次（约一分钟）：用 realm 里的 `member` / `apolla` 或 `admin` / `apolla` 登录，
确认能跳回应用并进入工作台。服务端验签、JIT 建户、角色映射、越权拦截已全部实证
（最小 IdP 与真实 Keycloak 各一轮）。

## 仍未验证的两项（都缺外部依赖，不是代码问题）

| 项 | 缺什么 | 上线前必做 |
|---|---|---|
| `EXECUTOR=docker` | 沙箱镜像需 node/ubuntu 基础镜像，拉不动 | `docker build -f infra/sandbox/Dockerfile -t apolla-sandbox:1.0 .` 并跑一个容器模式任务 |
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
