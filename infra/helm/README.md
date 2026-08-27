# Apolla Work Helm 部署指南（PRD T-211）

在 Kubernetes（1.29+）上部署 Apolla Work 全栈：`server` + 内置 `postgres` / `valkey` / `minio` / `litellm`（每个内置组件都可关掉改为外接企业设施）。服务拓扑与环境变量对齐 `infra/compose/compose.prod.yml`。

Chart 位置：`infra/helm/apolla/`（name `apolla`，version `0.1.0`，appVersion `0.1.0`）。

## 前置条件

- Kubernetes 1.29+，Helm 3.x
- 集群可拉取到镜像：
  - `apolla-server:dev`、`apolla-sandbox:dev` 需先构建并推送到企业镜像仓库（或在离线环境用 `infra/airgap-pack.sh` 的镜像 tar 导入各节点 / 内网 registry），并把 `server.image.repository` / `server.sandboxImage.repository` 改成含仓库前缀的完整名
  - 其余镜像：`postgres:16-alpine`、`valkey/valkey:8-alpine`、`minio/minio:latest`、`ghcr.io/berriai/litellm:main-latest`
- 默认 StorageClass（或在 values 里指定 `global.storageClass`）

## 安装

```bash
cd infra/helm

# 最小安装（dev 免登模式，内置全部组件）
helm install apolla ./apolla \
  --namespace apolla --create-namespace \
  --set secrets.masterKey=$(openssl rand -hex 24)

# 验证
kubectl -n apolla get pods
kubectl -n apolla port-forward svc/apolla-server 3001:3001
# 浏览器打开 http://localhost:3001
```

生产安装建议把敏感项放进自备 Secret（见下文 existingSecret），并用 values 文件：

```bash
helm install apolla ./apolla -n apolla --create-namespace -f my-values.yaml
```

## 升级 / 卸载

```bash
# 升级（复用已有 values；注意保持 secrets.* 不变，主密钥轮换会导致已加密数据无法解密）
helm upgrade apolla ./apolla -n apolla --reuse-values

# 卸载（PVC 不会随卸载删除，需手动清理）
helm uninstall apolla -n apolla
kubectl -n apolla delete pvc -l app.kubernetes.io/instance=apolla   # ⚠️ 会删数据
```

修改 `secrets.existingSecret` 指向的 Secret 内容后，需手动滚动重启使其生效：
`kubectl -n apolla rollout restart deploy -l app.kubernetes.io/instance=apolla`。

## values 关键项

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `secrets.masterKey` | `""`（必填） | 平台主密钥 `APOLLA_MASTER_KEY`；与 `existingSecret` 二选一 |
| `secrets.existingSecret` | `""` | 自备 Secret 名；须含键 `apolla-master-key`/`postgres-password`/`s3-access-key`/`s3-secret-key`/`model-api-key`，指定后 chart 不再创建 Secret |
| `secrets.postgresPassword` | `apolla` | DB 密码（拼入连接串，只用 URL 安全字符） |
| `secrets.s3AccessKey` / `s3SecretKey` | `apolla` / `apolla-secret` | 对象存储密钥（内置 MinIO 的 root 账号） |
| `secrets.modelApiKey` | `sk-apolla-dev` | 模型网关密钥（同时作为内置 LiteLLM 的 master_key 与 server 的 `MODEL_API_KEY`） |
| `auth.mode` | `dev` | `dev` 免登（试点）/ `oidc` 企业 IdP |
| `model.default` | `apolla-deep` | 默认模型档位（须与 LiteLLM `model_name` 一致） |
| `model.baseUrl` | `""` | 留空自动指向内置 LiteLLM；外接网关时填完整地址 |
| `server.image.repository` / `tag` | `apolla-server` / `dev` | server 镜像 |
| `server.replicas` | `1` | 副本数 |
| `server.executor` | `local` | 执行器；K8s Job 执行器属后续任务（ADR-005），届时取值 `k8s` |
| `server.queueDriver` | `bullmq` | 任务队列（`bullmq` 需 valkey；`inproc` 仅单副本） |
| `server.sandboxImage.repository` / `tag` | `apolla-sandbox` / `dev` | 沙箱镜像（供 docker/k8s 执行器） |
| `server.resources` 等 | 见 values | 各组件均有 `resources`；server 另有 `extraEnv`/`nodeSelector`/`tolerations`/`affinity` |
| `ingress.enabled` / `host` | `false` / `apolla.example.com` | 对外入口 |
| `ingress.className` / `annotations` | `""` / `{}` | Ingress 控制器相关 |
| `ingress.tls.enabled` / `secretName` | `false` / `""` | TLS 证书 Secret |
| `postgres.enabled` | `true` | 内置单副本 StatefulSet；`false` 时用 `postgres.external.*` 外接 |
| `postgres.persistence.size` / `storageClass` | `10Gi` / `""` | PVC 大小 / 存储类（空则继承 `global.storageClass`，再空则集群默认） |
| `valkey.enabled` / `valkey.external.url` | `true` / `""` | 内置或外接 Redis/Valkey（外接填完整 `redis://` 连接串） |
| `minio.enabled` / `minio.external.endpoint` | `true` / `""` | 内置或外接 S3 兼容存储 |
| `minio.persistence.size` | `20Gi` | MinIO PVC 大小 |
| `litellm.enabled` | `true` | 内置模型网关；`false` 时必须设 `model.baseUrl` |
| `litellm.config` | 内嵌自 `infra/litellm/config.yaml` | LiteLLM 完整配置（结构化 YAML，可整体覆盖；`master_key` 经环境变量注入） |
| `global.storageClass` | `""` | 全局存储类 |
| `imagePullSecrets` | `[]` | 私有仓库拉取凭证名称列表 |

## 常见场景示例

### 外接企业 PostgreSQL

```yaml
# my-values.yaml
postgres:
  enabled: false
  external:
    host: pg.infra.example.com
    port: 5432
    username: apolla
    database: apolla
secrets:
  masterKey: "<48位随机hex>"
  postgresPassword: "<企业DB密码，URL 安全字符>"
```

### 外接企业对象存储（S3 兼容）

```yaml
minio:
  enabled: false
  external:
    endpoint: https://oss.infra.example.com
secrets:
  s3AccessKey: "<AccessKey>"
  s3SecretKey: "<SecretKey>"
```

### 外接 Redis / 外接模型网关

```yaml
valkey:
  enabled: false
  external:
    url: redis://:pass@redis.infra.svc:6379/0
litellm:
  enabled: false
model:
  baseUrl: http://vllm-gateway.ml.svc:8000/v1
secrets:
  modelApiKey: "<网关密钥>"
```

### 使用自备 Secret（推荐生产）

```bash
kubectl -n apolla create secret generic apolla-prod-secrets \
  --from-literal=apolla-master-key=$(openssl rand -hex 24) \
  --from-literal=postgres-password=... \
  --from-literal=s3-access-key=... \
  --from-literal=s3-secret-key=... \
  --from-literal=model-api-key=...
```

```yaml
secrets:
  existingSecret: apolla-prod-secrets
```

### 修改 LiteLLM 指向企业内推理端点

```yaml
litellm:
  config:
    model_list:
      - model_name: apolla-deep
        litellm_params:
          model: openai/qwen3-72b
          api_base: http://vllm.ml.svc:8000/v1   # 集群内 vLLM/SGLang/MindIE OpenAI 兼容端点
          api_key: none
      - model_name: apolla-fast
        litellm_params:
          model: openai/qwen3-14b
          api_base: http://vllm-fast.ml.svc:8000/v1
          api_key: none
    router_settings:
      routing_strategy: simple-shuffle
    general_settings:
      master_key: os.environ/LITELLM_MASTER_KEY   # 保持不变，由 Secret 注入
```

## 执行器说明

- 本 chart 首版 `server.executor` 默认 `local`：任务在 server 容器内执行，隔离弱，适合试点与功能验证。
- `docker` 执行器依赖 `/var/run/docker.sock`，在 K8s 中不可用（也不安全），请勿在 K8s 里设置。
- 每任务一个 K8s Job 的执行器（`k8s`）属后续任务，届时 chart 将补充 ServiceAccount/RBAC 与 Job 模板。演进路径见 `docs/adr/ADR-005-k8s-deployment.md`。

## 验证程度（如实说明）

- 本 chart **未在真实 K8s 集群部署验证**（T-211 DoD 的“集群部署 + 黄金集”未执行）。
- 编写机上**没有 helm CLI**，因此 `helm lint` / `helm template` **未执行**。
- 已做的自检：
  - `Chart.yaml`、`values.yaml` 通过纯 YAML 语法解析（ruby YAML）；
  - `templates/` 各文件做了 Go template 括号配平检查（`{{` 与 `}}` 数量一致、文件非空）——这不能发现渲染期/清单结构错误。
- 首次上集群前请务必先执行 `helm lint ./apolla` 与 `helm template apolla ./apolla --set secrets.masterKey=test | kubectl apply --dry-run=server -f -`。
