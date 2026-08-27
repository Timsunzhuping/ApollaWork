# ADR-005 · K8s 部署的执行器演进：local → K8s Job

**背景**：T-211 引入 Helm chart（infra/helm/apolla）。现有 docker 执行器依赖挂载 docker.sock，在 K8s 中不可用且不安全。

**决策**：
- Helm 首版 server 默认 `EXECUTOR=local`：任务在 server 容器内执行，隔离弱，仅用于试点与功能验证（values 已预留 `server.executor` 字段）。
- 下一步实现 K8sJobExecutor：每任务一个 Job（apolla-sandbox 镜像、非 root、resources/NetworkPolicy 受限），server 经 ServiceAccount+RBAC 创建并 watch Job，工作区文件经 S3 传递；chart 届时补充 RBAC 与 Job 模板，`server.executor` 取值 `k8s`。
- 应用层零改动：执行器已按端口抽象（`apps/server/src/executor/executor.ts` 的 Executor 接口，现有 local/docker 两实现），新增实现即可切换。

**后果**：首版 K8s 部署即可用，但任务隔离低于 compose 的 docker 执行器；切换执行器只改 values 不改代码。沙箱镜像需预先推送到集群可达的镜像仓库。
