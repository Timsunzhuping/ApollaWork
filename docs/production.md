# Apolla Work 生产上线指南

> 面向 IT 管理员。开发环境请看 [README](../README.md)。
> 运维日常（备份/CI/排障）见 [ops.md](ops.md)。

## 0. 上线前必读：安全默认值不是生产默认值

开发默认值刻意做成「零依赖即可跑通」，**其中三项在生产环境是严重风险**：

| 开发默认 | 生产风险 | 生产必须 |
|---|---|---|
| `AUTH_MODE=dev` | 免登录，任何能访问端口的人都是管理员 | `AUTH_MODE=oidc` |
| `EXECUTOR=local` | Agent 的 Bash 以 server 进程权限在宿主执行 | `EXECUTOR=docker` |
| `APOLLA_MASTER_KEY` 默认值 | 连接器/模型密钥等同明文存储 | 随机主密钥 |

程序会**主动拦截**：`NODE_ENV=production` 下若检出上述问题，直接拒绝启动并给出修复命令
（见 `apps/server/src/common/preflight.ts`）。确需强行启动才设 `ALLOW_INSECURE_PRODUCTION=1`。

## 1. 架构与副本模型

```
[反代/Ingress] → [apolla-server ×N] → [沙箱容器（每任务一个）]
                        │
        ┌───────────────┼────────────────┬──────────────┐
   PostgreSQL       Valkey/Redis      MinIO/S3      LiteLLM → vLLM
   (事件溯源/业务)   (队列+事件分发)    (工作区文件)    (模型网关)
```

**单副本**：`QUEUE_DRIVER=inproc`、`CLUSTER_MODE=0`、存储可用 `fs`。
**多副本**：必须 `QUEUE_DRIVER=bullmq` + `CLUSTER_MODE=1` + `STORAGE_DRIVER=s3`，
且 `{STORAGE_DIR}/installed-skills` 需挂**共享卷**（NFS / RWX PVC）——
对象存储只覆盖工作区文件，不含技能包；不共享会导致「在 A 副本装的技能，
B 副本上的任务看不到」，表现为技能时有时无，极难排查。
原因：事件分发要跨副本（否则任务在 A 执行、用户 SSE 连在 B 就看不到进度），
文件要共享（否则副本之间看不到彼此产物）。preflight 会校验这些组合。

## 2. 部署步骤

### 2.1 准备
```bash
cp .env.example .env
# 生成主密钥与数据库密码
echo "APOLLA_MASTER_KEY=$(openssl rand -hex 32)" >> .env
```

### 2.2 数据库迁移（不要用 db push）
```bash
cd apps/server
# 把 schema.prisma 的 provider 改为 postgresql
DATABASE_URL_PRISMA="postgresql://..." npx prisma migrate deploy
DATABASE_URL_PRISMA="postgresql://..." npx tsx prisma/seed.ts   # 首次
```
> `db push` 无版本、无回滚，仅供开发。生产一律 `migrate deploy`。
> PG 迁移见 `apps/server/prisma/migrations-pg/`（已在 PostgreSQL 16 实跑验证）。

### 2.3 构建沙箱镜像（生产隔离的前提）
```bash
pnpm --filter @apolla/runtime run build
docker build -f infra/sandbox/Dockerfile -t apolla-sandbox:1.0 .
```

### 2.4 起服务
```bash
docker compose -f infra/compose/compose.prod.yml --env-file infra/compose/.env up -d
# 或 K8s
helm install apolla infra/helm/apolla -f my-values.yaml
```

### 2.5 接入 SSO
1. 部署 Keycloak（`infra/compose/compose.dev.yml` 的 `sso` profile 含示例 realm）。
2. 导入 `infra/keycloak/apolla-realm.json`，或在既有 IdP 建一个 public client（授权码 + PKCE）。
3. 回调地址填 `https://<你的域名>/`。
4. 给管理员分配 realm 角色 `apolla-admin`（映射为平台 admin）。
5. 设 `AUTH_MODE=oidc`、`OIDC_ISSUER`、`OIDC_CLIENT_ID`。

### 2.6 配置模型
两种方式，**DB 配置优先于环境变量**：
- 管理后台 →「模型接入」填 OpenAI 兼容端点，带连通性测试，改完即时生效。
- 或设 `MODEL_BASE_URL` / `MODEL_API_KEY` / `MODEL_DEFAULT`（可加 `MODEL_FAST` / `MODEL_DEEP` 分档）。

### 2.7 自检
```bash
curl -f https://<域名>/healthz     # 存活
curl -f https://<域名>/readyz      # 就绪（含 DB 与存储可达性）
```

## 3. 权限模型

| 层级 | 角色 | 能力 |
|---|---|---|
| 组织 | `admin` | 模型/连接器/技能市场/审计/用量；对本组织全部空间有 owner 权限 |
| 组织 | `member` | 只能访问自己是成员的空间 |
| 空间 | `owner` | 管成员、删空间 |
| 空间 | `editor` | 建任务、读写文件、审批 |
| 空间 | `viewer` | 只读 |

越权一律返回 404（不泄露资源是否存在），权限不足返回 403。

## 4. 安全清单（上线勾选）

- [ ] `AUTH_MODE=oidc`，已用真实账号走通登录
- [ ] `EXECUTOR=docker`，沙箱镜像已构建
- [ ] `APOLLA_MASTER_KEY` 为随机值且已存入密钥管理系统
- [ ] `ALLOWED_ORIGINS` 为明确域名
- [ ] 反代开启 HTTPS 与 HSTS；反代日志**屏蔽 `access_token` 查询参数**
      （SSE 与文件下载无法带请求头，令牌走查询参数）
- [ ] `WEBFETCH_ALLOWLIST` 按需最小化；纯内网部署留空
- [ ] 沙箱出网白名单只放行 LiteLLM / server / MinIO / 连接器
- [ ] 配额 `QUOTA_*` 按预算设置
- [ ] 备份任务已配（`infra/backup/backup.sh`），并**演练过一次恢复**
- [ ] IM 通道若启用：三通道密钥已配（未配则拒绝所有回调，这是安全默认值）
- [ ] 已跑 `REDTEAM_STRICT=1 pnpm --filter @apolla/eval exec tsx redteam/run.ts`

## 5. 容量建议

| 规模 | server | 沙箱并发 | PG | 模型 |
|---|---|---|---|---|
| ≤50 人 | 1 副本 4C8G | 20 | 2C4G | Qwen3-32B(AWQ) ×1 卡组 |
| ≤200 人 | 2–3 副本 | 50/副本 | 4C8G 主从 | 旗舰模型 ×多卡 |

`MAX_CONCURRENT_TASKS` 控制单副本并发；沙箱容器默认 2C/4G，在管理后台可调。

## 6. 升级

```bash
# 1. 备份（必做）
bash infra/backup/backup.sh --out /backup
# 2. 拉新镜像并迁移
docker compose pull
cd apps/server && npx prisma migrate deploy
# 3. 滚动重启
docker compose up -d
```
迁移向后兼容；跨大版本先读 CHANGELOG。重启期间正在执行的任务会被标记为
失败（启动恢复逻辑），用户可重新发起 —— 这是刻意设计，避免任务永久卡在 running。
