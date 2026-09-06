# Apolla Work 运维手册

面向部署与运维 Apolla Work 私有化实例的 IT 管理员。产品与工程规格见 [PRD.md](PRD.md)（SSOT），
本文只讲**跑起来之后怎么管**：备份恢复、CI 闸门、升级、监控、故障排查。

> 制品清单
> | 路径 | 用途 |
> |---|---|
> | `.github/workflows/ci.yml` | 构建 / 测试 / 评测闸门 |
> | `.github/workflows/security.yml` | 漏洞审计 · 依赖清单 · 许可合规 |
> | `.github/workflows/release.yml` | 镜像构建 + 离线包 |
> | `.github/scripts/check-licenses.mjs` | 许可合规检查（CI 硬闸门） |
> | `infra/backup/backup.sh` | 全量备份 |
> | `infra/backup/restore.sh` | 从备份恢复（破坏性，需 `--yes`） |
> | `infra/backup/verify-backup.sh` | 备份完整性校验 |
> | `Makefile` | 上述命令的本地入口（`make help`） |

---

## 1. 备份与恢复

### 1.1 备份什么、为什么

Apolla 的状态分三块，缺一不可：

| 组件 | 内容 | 丢了会怎样 |
|---|---|---|
| PostgreSQL | 任务、**事件流**、审批、审计、用量、连接器（密文）、自动化、资料库元数据 | 全部历史消失。事件是唯一真相，事件没了历史任务无法回放 |
| MinIO 对象 | 任务产物（文档/表格/PPT/图表）、上传的原始文件 | 数据库里还有产物记录，点开是 404 |
| `.env` 配置 | `APOLLA_MASTER_KEY`、数据库与对象存储口令 | **主密钥丢失 = 连接器与模型密钥永久解不开**，即使库恢复了也要全部重配 |

> ⚠️ 主密钥单独说一次：`APOLLA_MASTER_KEY` 是连接器凭据与模型密钥的加密根。
> 它必须与数据库同源备份，且必须**离线另存一份**（密码保险箱），不能只躺在备份盘里。

### 1.2 日常备份

```bash
# 最简：备份到 ./backups
bash infra/backup/backup.sh

# 生产推荐：异地目录 + 只留最近 7 份
bash infra/backup/backup.sh --out /srv/apolla-backup --keep 7

# 先看看会做什么（不动任何数据）
bash infra/backup/backup.sh --dry-run
```

产出目录结构：

```
apolla-backup-20260828-020000/
├── postgres/apolla.dump        # pg_dump -Fc（custom 格式，可 pg_restore --list）
├── minio/minio-data.tar.gz     # 对象存储卷快照
├── config/.env                 # ⚠️ 含密钥，权限 0600
├── config/litellm-config.yaml
├── config/compose.prod.yml
├── manifest.json               # 组件版本、镜像、Git 提交、PG 版本
└── SHA256SUMS
```

设计要点：

- **不覆盖历史**：每次跑生成独立的时间戳目录，可以放心加进 cron。
- **中断可识别**：跑到一半失败会在目录里留 `.INCOMPLETE`，`verify` 与 `restore` 见到就拒绝。
- **不依赖宿主机工具**：`pg_dump` 在 postgres 容器里跑，卷打包用一次性容器（默认复用
  `postgres:16-alpine`，离线环境不必额外准备 alpine/busybox）。宿主机只要有 docker。

定时任务示例（每天 02:00，保留 7 天）：

```cron
0 2 * * * cd /opt/apolla && bash infra/backup/backup.sh --out /srv/apolla-backup --keep 7 >> /var/log/apolla-backup.log 2>&1
```

### 1.3 校验备份（恢复前必做）

```bash
bash infra/backup/verify-backup.sh /srv/apolla-backup/apolla-backup-20260828-020000
```

7 项检查：完成标记 → SHA256 全量比对 → `manifest.json` 合法性 → dump 魔数（`PGDMP`）
→ **`pg_restore --list` 真解析**（本机没有 `pg_restore` 就用一次性容器）→ 归档 gzip/tar 完整性
→ `config/.env` 权限不宽于 0600。任何一项失败退出码为 1。

> 备份不校验等于没有备份。建议把 `verify-backup.sh` 也挂进 cron，每周跑一次最近那份。

### 1.4 恢复

**恢复是破坏性操作**：会 `DROP DATABASE` 重建、清空并覆盖对象存储卷。
因此 `restore.sh` 默认**只打印计划**，必须显式传 `--yes` 才真正执行。

```bash
# 第一步：看计划（安全，什么都不改）
bash infra/backup/restore.sh /srv/apolla-backup/apolla-backup-20260828-020000

# 第二步：确认无误后执行
bash infra/backup/restore.sh /srv/apolla-backup/apolla-backup-20260828-020000 --yes
```

执行顺序：

1. **预检** —— 跑 `verify-backup.sh`，不全绿就中止（`--skip-verify` 可强行跳过，不推荐）
2. **安全网** —— 先给**当前**数据做一份 `-pre-restore` 备份；这一步失败会中止整个恢复
   （宁可不恢复，也不在无回滚点的情况下覆盖数据）。`--no-pre-backup` 可关。
3. 停 `server`（停止一切写入）
4. `DROP DATABASE ... WITH (FORCE)` → `CREATE` → `pg_restore --exit-on-error`
5. 停 `minio` → `find /data -mindepth 1 -delete` 清空卷 → 解包归档 → 起 `minio`
6. `docker compose up -d` → 轮询 `/readyz` 就绪探针（老版本回落 `/api/v1/me`）

**配置文件默认不覆盖**。因为多数恢复场景是「往现有环境灌回数据」，直接覆盖 `.env`
会把当前环境的端口、模型端点、IdP 配置一起冲掉。迁移到新机器时才加 `--restore-config`。
无论哪种方式，**`APOLLA_MASTER_KEY` 必须与备份时一致**，否则连接器与模型密钥解不开。

恢复完成后人工确认三件事：

1. 历史任务与事件能完整回放（事件是唯一真相）
2. 打开一个历史任务的产物文件（验证对象存储）
3. 管理后台 →「模型接入」做一次连通测试（验证主密钥能解密）

### 1.5 RPO / RTO 建议

RPO = 最多能接受丢多少数据；RTO = 出事后多久必须恢复服务。

| 部署规模 | 备份频率 | RPO | RTO（实测口径） | 做法 |
|---|---|---|---|---|
| 试点 / 单部门（< 50 人） | 每日 1 次 | 24h | 1h | cron 每日全量 + `--keep 7`，异地拷贝 |
| 生产 / 全公司 | 每 6h 一次 | 6h | 30min | 全量每日 + PG WAL 归档（见下）+ 异地同步 |
| 关键业务 | 连续归档 | < 5min | 15min | PG 流复制备库 + MinIO 站点复制 |

RTO 的构成（单机 compose，数据量按数十 GB 估）：

- 校验备份：1–2 分钟
- 恢复 PG：与 dump 大小成正比，custom 格式可 `-j` 并行
- 恢复对象：解包耗时约等于归档大小 / 磁盘写入速度
- 起栈 + 健康检查：1–3 分钟

> **诚实说明**：上表是基于组件特性给出的**建议目标**，不是本仓库实测数字。
> 真实 RTO 必须在你自己的硬件上、用真实数据量做一次恢复演练才算数。
> 建议每季度演练一次并把实测时间记回本表。

**低于 24h RPO 的做法**：本脚本是全量逻辑备份（`pg_dump`），做不到分钟级 RPO。
需要更低 RPO 时，在 postgres 上开 WAL 归档（`archive_mode=on` + `archive_command`
推到对象存储）或直接上流复制备库；对象存储侧用 MinIO 的站点复制。
这两项属部署架构调整，需要改 compose/Helm，不在本脚本范围内。

### 1.6 已验证 / 未验证

**已在本机真实验证**（postgres:16-alpine 容器 + 带 compose 标签的数据卷）：

- 全量备份 → 校验 → 破坏数据 → 恢复 → 数据与对象逐条比对一致（含中文内容、
  `.minio.sys/` 这类点开头的隐藏对象）
- 篡改备份中一个字节 → `verify-backup.sh` 报校验和不匹配并退出 1
- 连续恢复两次结果一致（幂等）
- `--keep N` 正确删除最旧的、保留最新的
- `--dry-run` 全流程只打印、零改动

**未验证**：真实生产数据量下的耗时、MinIO 服务在跑的情况下的热备份一致性
（当前实现是停机一致性 —— 恢复时会先停 minio；备份时是在线打卷，
MinIO 正在写入的对象可能被抓到中间态，建议在业务低峰执行）。

---

## 2. CI 闸门

三条流水线，`.github/workflows/` 下。**注意：未在真实 GitHub Actions 环境实跑过**
（本地无 `act`），仅做了 YAML 语法/结构静态校验 + 逐条命令在本机执行验证，详见 §2.4。

### 2.1 哪些是硬闸门

| 流水线 | 步骤 | 类型 | 失败后果 |
|---|---|---|---|
| `ci.yml` | `pnpm -r run build` | **硬闸门** | 阻断 |
| `ci.yml` | `pnpm -r run test` | **硬闸门** | 阻断 |
| `ci.yml` | 黄金场景评测 `eval/run.ts` | **硬闸门** | 阻断（PRD 定义的发布门槛） |
| `ci.yml` | 红队 `REDTEAM_STRICT=1` | **硬闸门** | 阻断（零缺口：连已知 xfail 缺口也算不通过） |
| `ci.yml` | 性能基准 `perf/run.ts` | 软闸门 | 不阻断，只产出报告 |
| `ci.yml` | `apps/knowledge` Python 语法 | **硬闸门** | 阻断 |
| `security.yml` | 许可合规 `check-licenses.mjs` | **硬闸门** | 阻断 |
| `security.yml` | `pnpm audit --audit-level=high` | 软闸门 | 不阻断，只产出报告 |

**为什么性能基准是软闸门**：结果受 runner 机型与邻居负载影响很大，做硬闸门会产生大量
假红，久而久之被无脑重跑绕过。它的价值在于趋势，不在于单次通过与否 —— 看 artifact 里的
`eval/perf/report.md`。

**为什么 `pnpm audit` 是软闸门**：漏洞库每天更新。一条新披露的传递依赖 CVE 不该让一个
没动过代码的历史提交突然变红、阻塞无关发布。结果进 Job Summary，由人决定升级还是记豁免。

**为什么许可合规是硬闸门**：许可只在有人**新增依赖**时才会变，是可控的、确定的。
直接依赖里混进 GPL/AGPL 会传染整个仓库，必须零容忍。

### 2.2 许可合规的口径

```bash
make licenses                              # 本地跑，只打终端（不在仓库里留文件）
node .github/scripts/check-licenses.mjs --md-out /tmp/lic.md --json-out /tmp/lic.json  # 要报告文件时
```

- 判定源：`pnpm licenses list --json`（pnpm 原生命令，在本仓库实测覆盖 643 个包）。
- **直接依赖**里出现强 copyleft（GPL / AGPL / SSPL / CPAL / BUSL 系）→ 退出码 1，阻断。
- **传递依赖**里出现 → 只告警。它们多半是构建期工具，是否进入分发物机器判不了，交给人。
- LGPL / MPL / EPL 等弱 copyleft → 列出来，不阻断。
- SPDX 双许可（如 `(MPL-2.0 OR Apache-2.0)`）按 `OR` 取最宽松的一支 —— 我们有权选。
- 例外可用 `--allow pkg1,pkg2` 豁免，但**必须在本节记录理由**。

**当前豁免清单**：无。

**MinIO 是 AGPL-3.0 为什么不算违规**：它是**独立进程**，经 S3 HTTP 协议调用，
不与本仓库代码链接、不打进任何 npm 包 —— 属「聚合」而非「衍生作品」。
本检查只覆盖 npm 依赖树；容器镜像内的第三方组件由 `infra/airgap-pack.sh` 产出的
`manifest.json` 记录。若法务要求完整 SBOM（CycloneDX/SPDX），需在镜像层引入 syft，
属后续任务（PRD T-212 DoD 已标注 SBOM 为占位）。

**本仓库实测结果**（2026-08-28，643 个包 / 50 个直接依赖）：

| 类别 | 数量 |
|---|---|
| 宽松（MIT 479 / ISC 60 / Apache-2.0 55 / BSD 系 29 / BlueOak 10 / 其他 8） | 641 |
| 弱 copyleft | 2（`lightningcss`、`lightningcss-darwin-arm64`，均为 MPL-2.0，且都是**传递**依赖，来自 Tailwind 4） |
| **强 copyleft** | **0** |
| 许可未知/未声明 | 0 |

→ 直接依赖中零 GPL/AGPL/SSPL，闸门通过（退出码 0）。

> 这个数字随依赖变动，不必手工维护 —— 以 CI 每次跑出的 `license-report.md` 为准，
> 本表只是一个「基线快照」，用来判断某次变更是不是引入了新的许可风险。

### 2.3 SBOM 的实际口径

`security.yml` 产出的是 **`sbom-licenses.json`（许可清单）**，不是完整 SBOM。

原因：pnpm 的虚拟 store 布局与 `npm ls` 不兼容，`@cyclonedx/cyclonedx-npm` 在 pnpm
workspace 下无法稳定产出。工作流里保留了一步 best-effort 的 CycloneDX 尝试
（`continue-on-error`），跑通就多一份 `sbom.cdx.json`，跑不通不影响流水线。
需要正式 SBOM 时推荐用 `syft`（对容器镜像和源码树都友好），但那要引入新工具，属独立任务。

### 2.4 CI 的验证状态（诚实说明）

| 项 | 状态 |
|---|---|
| 三个 workflow YAML 语法（PyYAML `safe_load`） | ✅ 通过 |
| 结构校验（每个 step 恰好有 `uses` 或 `run`；job 有 `runs-on`/`timeout-minutes`） | ✅ 通过 |
| Action 版本存在性 | ✅ 人工核对（checkout@v4、setup-node@v4、setup-python@v5、upload-artifact@v4、pnpm/action-setup@v4、setup-buildx-action@v3、login-action@v3、build-push-action@v6） |
| 各 CI 步骤的命令在本机执行 | ✅ 全部退出码 0：`pnpm -r --workspace-concurrency=1 run build`、`pnpm -r run test`（protocol 7 / im-bridge 38 / desktop 13 / agent-tools 15 / runtime 9 / server 27）、黄金场景 10/10、红队严格模式零缺口、性能基准 M1/M2 达标、许可检查、`python -m compileall apps/knowledge skills` |
| **在真实 GitHub Actions runner 上跑过** | ❌ **未跑**。本机没有 `act`，也没有可用的 GH 仓库环境。首次推送后需盯一遍。 |
| `release.yml` 的 docker 镜像构建与离线打包 | ❌ **未跑**（构建 sandbox 镜像需拉 ubuntu24 + LibreOffice，耗时与磁盘成本高） |

**首次推送后重点盯这几处**：

1. `pnpm/action-setup@v4` 是否正确从 `package.json` 的 `packageManager` 读到 pnpm 9.12.0
2. `ELECTRON_SKIP_BINARY_DOWNLOAD=1` 下 `@apolla/desktop` 的 `tsc` 编译是否还能拿到
   `electron.d.ts`（类型声明在 npm 包里，不在下载的二进制里 —— 本机已验证 13 个单测全绿；
   万一 CI 上不行，改用 `pnpm install --filter '!@apolla/desktop'` 并在 workflow 注明原因）
3. `actions/setup-node@v4` 的 `cache: pnpm` 是否命中（必须排在 `pnpm/action-setup` 之后）

### 2.5 已知缺口：sandbox 镜像的 node_modules

`infra/sandbox/Dockerfile` 直接 `COPY apps/runtime/node_modules`。pnpm 默认的
`node_modules` 是指向 `.pnpm` 虚拟 store 的**符号链接**，Docker 的 `COPY` 按符号链接原样
拷贝，进到镜像里就是悬空链接。

`release.yml` 里的变通：镜像构建前用 `pnpm install --node-linker=hoisted` 重装一次，
得到 npm 式的扁平真实目录，并断言 `apps/runtime/node_modules` 不是符号链接
（断言失败即让流水线红掉，而不是产出一个装着悬空链接的镜像）。

> ⚠️ **这个变通未经实跑验证** —— 验证它需要在本机做一次 hoisted 重装，会打乱当前
> 工作树的 node_modules 布局。首次跑 `release.yml` 时请重点看这一步。

**根治办法**是把 sandbox 改成多阶段构建（在构建阶段装依赖、只把产物拷到运行阶段）。
那是 Dockerfile 层面的架构改动，应该单开一条 ADR，不在本次运维制品范围内。

---

## 3. 升级流程

### 3.1 标准升级（单机 compose）

```bash
# 1) 升级前必做：留档，并单独确认主密钥另存了一份
bash infra/backup/backup.sh --out /srv/apolla-backup --label pre-upgrade
bash infra/backup/verify-backup.sh /srv/apolla-backup/apolla-backup-*-pre-upgrade

# 2) 取新版本
git fetch --tags && git checkout v<新版本>

# 3) 构建 / 载入镜像
#    联网机：
docker compose -f infra/compose/compose.prod.yml --env-file infra/compose/.env build server
docker build -f infra/sandbox/Dockerfile -t apolla-sandbox:<新版本> .
#    离线机：先 bash install.sh（离线包内），它会 docker load

# 4) 滚动重启（数据库迁移由 server 镜像启动时自动执行，见 §3.2）
docker compose -f infra/compose/compose.prod.yml --env-file infra/compose/.env up -d

# 5) 自检
curl -sf http://localhost:${PORT:-3001}/readyz && echo " server ready"
docker compose -f infra/compose/compose.prod.yml ps
```

### 3.2 数据库迁移注意事项

server 镜像的启动命令是：

```
npx prisma migrate deploy || npx prisma db push --skip-generate; node dist/main.js
```

含义与风险：

- **`migrate deploy` 只应用已存在的迁移文件，不会生成新迁移**，这是生产的正确做法。
- 那个 `||` 兜底到 `db push` 是**开发便利**，在生产上是个隐患：`db push` 会按 schema
  直接改库，可能**丢列丢表**。生产升级前，先确认 `apps/server/prisma/migrations/`
  里有对应的迁移文件，别让它掉进 `db push` 分支。
- 迁移**不可逆**。Prisma 没有 down migration。回滚版本必须靠恢复升级前的备份，
  这就是 §3.1 第 1 步不能省的原因。
- 大表加索引/加非空列会**锁表**。上线前在测试库用生产量级数据跑一遍，
  必要时手写迁移拆成「加可空列 → 回填 → 加约束」三步。

升级前检查迁移会做什么：

```bash
# 看有哪些迁移待应用
docker compose -f infra/compose/compose.prod.yml exec -T server npx prisma migrate status
```

### 3.3 回滚

```bash
git checkout v<旧版本>
docker compose -f infra/compose/compose.prod.yml --env-file infra/compose/.env up -d
# 若新版本已跑过迁移，代码回滚不够 —— 必须连数据一起回滚：
bash infra/backup/restore.sh /srv/apolla-backup/apolla-backup-<时间戳>-pre-upgrade --yes
```

---

## 4. 监控建议

### 4.1 OpenTelemetry 接入

server 已内置 OTLP 导出（PRD T-121）。开启方式 —— 在 `infra/compose/.env` 里：

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318   # 留空则完全不外发
OTEL_DEBUG=0                                             # 设 1 时把 span 打到 stdout，排查用
```

> 默认留空 = 不外发任何遥测，符合「数据不出内网」的默认值。开启前请确认
> collector 也在内网，且不会把 prompt/产物内容带出去。

推荐落地：OTel Collector → Prometheus（指标）+ 内网 Jaeger/Tempo（链路）+ Grafana（看板）。

### 4.2 关键指标

| 指标 | 怎么看 | 阈值建议 | 说明 |
|---|---|---|---|
| **任务成功率** | `task.finished` 事件里 `status=succeeded` 占比 | < 90% 告警 | 最重要的单一健康指标；掉下来通常是模型端点或沙箱出问题 |
| **任务首个流式响应** | 从任务创建到首个 `message.delta` | M1 < 3s / M2 < 2s（PRD §1.6） | 这是用户感知的「卡不卡」。平台侧开销是毫秒级，真实值由模型 TTFT 决定 |
| **任务端到端时延** | P50 / P95 / P99 | P95 突增 2 倍告警 | 看绝对值不如看变化率 |
| **token 消耗** | 按工作空间/用户/模型分组累计 | 按配额设 | 直接对应成本；也是发现「某个自动化跑飞了」的最快信号 |
| **队列深度** | BullMQ waiting + delayed 任务数 | 持续 > 并发上限 2 倍告警 | 持续增长 = 执行节点不够或有任务卡住 |
| **运行中任务数 / 并发上限** | 运行中任务数 | > 80% 上限预警 | 对照 PRD §1.6 单节点并发目标（M1 ≥ 20 / M2 ≥ 50） |
| **审批等待时长** | `approval.requested` → `approval.decided` | > 30min 提醒 | 卡审批的任务会一直占着并发额度 |
| **沙箱容器异常退出** | OOMKilled / 非零退出计数 | 任意即告警 | 通常是内存上限太低或技能脚本有问题 |
| **模型网关错误率** | LiteLLM 的 5xx / 超时比例 | > 1% 告警 | 区分「模型不行」与「平台不行」的关键 |

### 4.3 健康探测

server 暴露两个**免鉴权**探针（`apps/server/src/health/health.controller.ts`）：

| 端点 | 语义 | 用途 |
|---|---|---|
| `GET /healthz` | 存活。进程在跑就 200，返回 `{status,uptime}` | K8s liveness / 进程守护 |
| `GET /readyz` | 就绪。真查 DB（`SELECT 1`）+ 存储可达；任一失败返回 **503** 并在 `checks` 里指名道姓 | K8s readiness / LB 摘流 / 恢复后自检 |

两者都在限流白名单里（不会被 rate-limit 挡掉），所以可以高频探测。

```bash
# 容器级健康（compose 自带 healthcheck）
docker compose -f infra/compose/compose.prod.yml ps

# 存活
curl -sf http://localhost:${PORT:-3001}/healthz && echo

# 就绪（未就绪时 503，body 会说明是 database 还是 storage 挂了）
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:${PORT:-3001}/readyz
curl -s http://localhost:${PORT:-3001}/readyz | jq .
```

> `infra/backup/restore.sh` 的恢复后自检优先打 `/readyz`，老版本 server 没有这个端点时
> 回落到 `/api/v1/me`。注意回落路径在 `AUTH_MODE=oidc` 下不带 token 会返回 401，
> 那种情况探测结果不可靠 —— 以 `docker compose ps` 为准。

---

## 5. 故障排查手册

统一约定（下文用 `$DC` 代替）：

```bash
DC="docker compose -f infra/compose/compose.prod.yml --env-file infra/compose/.env"
```

### 5.1 server 起不来

```bash
# 1) 先看它到底报了什么
$DC logs --tail 200 server

# 2) 容器在不在、退出码多少
$DC ps -a
docker inspect --format '{{.State.ExitCode}} {{.State.Error}}' $($DC ps -aq server)

# 3) 依赖是否就绪（server 依赖 postgres 健康）
$DC ps postgres
$DC exec -T postgres pg_isready -U apolla

# 4) 数据库连得上吗（在 server 容器里用它自己的 DATABASE_URL_PRISMA 试）
$DC exec -T server sh -c 'node -e "console.log(process.env.DATABASE_URL_PRISMA)"'
$DC exec -T postgres psql -U apolla -d apolla -c 'SELECT 1'

# 5) 迁移是不是卡住了
$DC exec -T server npx prisma migrate status
```

常见成因：

| 症状 | 成因 | 处理 |
|---|---|---|
| `必须设置主密钥` 后立刻退出 | `.env` 里没有 `APOLLA_MASTER_KEY`（compose 用 `:?` 强校验） | 补上，且必须和历史数据同一把 |
| `Nest can't resolve dependencies` | 用 tsx 而非编译产物跑（装饰器元数据丢失） | 必须 `node dist/main.js`，见 [ADR-003](adr/ADR-003-server-runtime-execution.md) |
| `P1001 Can't reach database` | postgres 没起来或口令不对 | 看第 3、4 步；确认 `POSTGRES_PASSWORD` 前后一致 |
| 端口被占 | `PORT` 与宿主机其他服务冲突 | `lsof -i :3001`，改 `.env` 的 `PORT` |
| 启动即 restart 循环 | 迁移失败后进程退出，`restart: unless-stopped` 反复拉起 | 先 `$DC stop server`，手动跑 `migrate deploy` 看报错 |

### 5.2 任务一直卡在 running

```bash
# 1) 卡了多久、卡在哪个阶段（事件是唯一真相，直接查事件流）
$DC exec -T postgres psql -U apolla -d apolla -c \
  "SELECT id, status, updated_at, now()-updated_at AS stuck_for FROM \"Task\" WHERE status='running' ORDER BY updated_at;"

# 2) 该任务最后几条事件说明它停在哪
$DC exec -T postgres psql -U apolla -d apolla -c \
  "SELECT type, created_at FROM \"TaskEvent\" WHERE task_id='<任务ID>' ORDER BY id DESC LIMIT 20;"

# 3) 队列积压情况
$DC exec -T valkey valkey-cli LLEN bull:tasks:wait
$DC exec -T valkey valkey-cli KEYS 'bull:tasks:*' | head

# 4) 沙箱容器还在不在（EXECUTOR=docker 时每任务一容器）
docker ps --filter "ancestor=apolla-sandbox:${APOLLA_VERSION:-dev}"
docker logs --tail 100 <沙箱容器ID>
```

对号入座：

- **最后一条事件是 `approval.requested`** → 不是卡住，是在等人审批。去审批中心处理，
  或检查审批通知有没有发出去。
- **最后一条是 `tool.started` 且长时间无后续** → 工具执行卡住。多半是 `Bash` 在等
  stdin，或某条命令没有超时保护。看沙箱容器日志。
- **队列 waiting 一直涨、running 不动** → 执行节点不够或 worker 挂了。
  `$DC restart server`（worker 与 server 同进程时）。
- **沙箱容器已经消失但任务仍是 running** → 容器被 OOM kill 了。
  `docker inspect` 看 `OOMKilled: true`，调大沙箱内存上限。
- **模型端点无响应** → 见 §5.4。

### 5.3 SSE 断流（前端不再更新）

事件是唯一真相，SSE 只是投递通道 —— **断流不丢数据，刷新页面会走回放补齐**。
先确认是投递问题还是产生问题：

```bash
# 1) 直接用 curl 订阅，看服务端还在不在推
curl -N -sf "http://localhost:${PORT:-3001}/api/v1/tasks/<任务ID>/events?lastEventId=0" | head -20

# 2) 数据库里事件还在不在涨（在涨 = 后端正常，纯投递问题）
watch -n2 "$DC exec -T postgres psql -U apolla -d apolla -tAc \
  \"SELECT count(*) FROM \\\"TaskEvent\\\" WHERE task_id='<任务ID>'\""

# 3) 中间层有没有掐断长连接
$DC logs --tail 100 server | grep -i -E "sse|stream|abort|econnreset"
```

常见成因：

| 症状 | 成因 | 处理 |
|---|---|---|
| 固定 60s / 30s 后必断 | 反向代理（Nginx/网关）的 `proxy_read_timeout` | 该 location 设 `proxy_read_timeout 3600s; proxy_buffering off;` |
| 断了但事件数还在涨 | 纯投递问题 | 前端带 `lastEventId` 重连即可完整回放，不用重跑任务 |
| 事件数也不涨 | 后端真卡住 | 按 §5.2 排查 |
| 浏览器控制台报 CORS / 混合内容 | HTTPS 页面连 HTTP 端点 | 统一走 HTTPS |

### 5.4 模型连不上

```bash
# 1) 从 server 容器里打网关（而不是从宿主机 —— 容器网络才是真实路径）
$DC exec -T server sh -c 'curl -sS -o /dev/null -w "%{http_code}\n" \
  "$MODEL_BASE_URL/models" -H "Authorization: Bearer $MODEL_API_KEY"'

# 2) 网关自身健康 + 它到底能路由到哪些模型
$DC logs --tail 100 litellm
$DC exec -T litellm sh -c 'curl -sS http://localhost:4000/v1/models'

# 3) 网关到底层 vLLM/厂商端点通不通
$DC exec -T litellm sh -c 'curl -sS -o /dev/null -w "%{http_code}\n" <上游端点>/v1/models'

# 4) 用内置 mock 模型旁路验证「是模型的问题还是平台的问题」
MODEL_DEFAULT=mock pnpm --filter @apolla/eval exec tsx run.ts
```

对号入座：

| HTTP / 现象 | 成因 | 处理 |
|---|---|---|
| 连接被拒 / DNS 失败 | 容器网络里解析不到上游主机名 | 用容器网络内可解析的名字；宿主机服务用 `host.docker.internal` 或宿主 IP |
| 401 / 403 | `MODEL_API_KEY` 与 LiteLLM 的 `master_key` 不一致 | 对齐 `.env` 的 `LITELLM_KEY` 与 `infra/litellm/config.yaml` |
| 404 model not found | `MODEL_DEFAULT` 不在网关的 `model_list` 里 | 改 `infra/litellm/config.yaml` 加映射，或改 `MODEL_DEFAULT`。**别在代码里写死模型名**（CLAUDE.md 红线） |
| 429 | 上游限流或配额用尽 | 在 LiteLLM 配多个 deployment 做负载均衡 |
| 超时但 `/models` 正常 | 上游推理慢或显存不足 | 看 vLLM 日志与 `nvidia-smi`；下调 `max_tokens`/并发 |
| 管理后台「连通测试」失败但 curl 正常 | 存的密钥解不开 | `APOLLA_MASTER_KEY` 变过 —— 在管理后台重填一次模型密钥 |

### 5.5 对象存储 / 产物打不开

```bash
$DC logs --tail 100 minio
$DC exec -T server sh -c 'curl -sS -o /dev/null -w "%{http_code}\n" "$S3_ENDPOINT/minio/health/live"'
docker volume inspect apolla_minio
df -h    # 磁盘写满是最常见的原因
```

### 5.6 一键取证包

出问题需要找人帮看时，先收集这些（注意：日志里可能含业务内容，按密级处理）：

```bash
mkdir -p /tmp/apolla-diag && cd /tmp/apolla-diag
$DC ps -a                      > ps.txt 2>&1
$DC logs --tail 500 server     > server.log 2>&1
$DC logs --tail 200 postgres   > postgres.log 2>&1
$DC logs --tail 200 litellm    > litellm.log 2>&1
docker version                 > docker.txt 2>&1
df -h                          > disk.txt 2>&1
$DC exec -T postgres psql -U apolla -d apolla -c \
  "SELECT status, count(*) FROM \"Task\" GROUP BY status;" > task-stats.txt 2>&1
# ⚠️ 不要把 .env 放进取证包 —— 里面有主密钥
tar czf ../apolla-diag.tar.gz .
```

---

## 6. 仓库卫生：建议补的 .gitignore 条目

运维脚本会在仓库里生成产物目录。以下路径**尚未**进 `.gitignore`，建议补上
（本次交付的文件范围不含 `.gitignore`，所以没有替你改）：

```gitignore
backups/            # backup.sh 的默认输出目录（含密钥，绝不能提交）
dist-airgap/        # airgap-pack.sh 的离线包目录
apolla-airgap-*.tar # 离线包归档
security-reports/   # CI 的漏洞/许可报告（本地 `make licenses` 只打终端，不落文件）
```

> `backups/` 里有 `config/.env`，包含 `APOLLA_MASTER_KEY`。**一旦误提交，
> 主密钥就进了 Git 历史**，必须轮换密钥而不只是删文件。这条优先级最高。

---

## 7. 快速索引

```bash
make help              # 所有可用目标
make ci                # 本地跑一遍 CI 的硬闸门（build + test + 黄金 + 红队严格）
make licenses          # 许可合规检查
make lint-workflows    # 静态校验 workflow YAML
make backup            # 全量备份（BACKUP_OUT=... 指定目录）
make backup-dry        # 备份 dry-run
make verify-backup BACKUP=<目录>
make restore BACKUP=<目录>          # 只打印计划
make restore-yes BACKUP=<目录>      # 真正执行
```

## 审计不可变（T-405）

审计「不可删」是两道 DB 层机制，不是代码约定：

1. **触发器**（migration `20260906000000_audit_immutable`）：任何连接对 `AuditEvent` 的
   UPDATE / DELETE / TRUNCATE 一律拒绝；只有留存清理任务在同一事务内显式
   `SET LOCAL apolla.retention_job = 'on'` 才能删除。
2. **角色分离**（[infra/sql/roles.sql](../infra/sql/roles.sql)）：应用运行时用 `apolla_app`
   （对审计表仅 INSERT/SELECT），迁移用 owner，清理任务用 `apolla_retention`：

   ```bash
   psql -U apolla -d apolla -v app_pw='<强密码>' -v ret_pw='<强密码>' -f infra/sql/roles.sql
   # 运行时：DATABASE_URL=postgresql://apolla_app:...   迁移：DATABASE_URL_PRISMA=postgresql://apolla:...
   ```

**删除前先归档**：超过留存期的审计行先写成带哈希链的 JSONL
（`_system/audit-archive/<截止月>/audit-<时间>.jsonl`，链头记在 `_system/audit-archive/chain.json`），
每行 `h = sha256(prev + 规范化行)`，任何篡改/删行/插行都会让后续哈希对不上。
用 S3 驱动时建议给该前缀开 Object Lock（WORM）。校验：

```bash
pnpm --filter @apolla/server verify-audit-archive <文件或目录>   # 也可 --prev <上一段链头>
```

## 主密钥轮换（T-406）

`APOLLA_MASTER_KEY` 用信封加密保护全部连接器配置与模型 API Key。密文带主钥指纹（kid），
轮换不停机：

```bash
# 1) 新钥设为当前，旧钥放进 PREVIOUS（逗号分隔可多把）；重启服务 —— 新旧双读，无中断
APOLLA_MASTER_KEY=<新钥> APOLLA_MASTER_KEY_PREVIOUS=<旧钥>
# 2) 批量把全部密文重加密为新钥（先 --dry-run 看影响面）
pnpm --filter @apolla/server rotate-key --dry-run
pnpm --filter @apolla/server rotate-key
# 3) 输出「待轮换 0」后，删掉 APOLLA_MASTER_KEY_PREVIOUS 再重启
```

轮换本身会写一条审计（`secret.rotate`）。若有密文用未知主钥加密，`rotate-key` 会逐条报出并以非零退出，
不会静默跳过。
