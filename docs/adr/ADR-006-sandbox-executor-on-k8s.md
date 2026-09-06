# ADR-006 · K8s 上的沙箱执行形态

**背景**：PRD T-211 曾标「K8s Job 执行器已实现」，2026-09 核实并不存在——只有 local 与 docker 两种执行器。
生产要上 K8s，必须定案任务沙箱在集群里怎么跑。

**决策**：首版采用 **Docker 执行器 + 专用沙箱节点池**：
- server 以 nodeSelector 调度到带 dockerd 的沙箱节点池，直连该节点 dockerd 创建任务容器（NetworkMode none、
  只读根、CapDrop ALL、stdio 控制通道 —— 与 T-402/T-403 在真实容器上验证过的路径完全一致）；
- 沙箱节点池与业务节点池隔离，NetworkPolicy 对 `component: sandbox` 全拒绝（防御纵深，容器本身已无网）；
- 原生 **K8s Job 执行器**（每任务一 Job、工作区经共享卷 materialize、RBAC 最小化）列为 v1.1，
  接口已由 `Executor` 抽象预留，实现时只需新增 `k8s-executor.ts`，不改调用方。

**后果**：
- 优点：复用已实测的隔离链路，零新代码即可上 K8s；节点池隔离把「沙箱逃逸」的影响面限制在专用节点。
- 代价：server 必须与 dockerd 同节点（DaemonSet 或节点亲和），弹性伸缩粒度为节点而非 Pod；
  沙箱镜像需预拉到该节点池。
- 触发重评：客户明确禁止节点级 dockerd，或单集群任务并发超过节点池容量。
