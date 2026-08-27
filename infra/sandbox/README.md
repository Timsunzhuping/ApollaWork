# Apolla 任务沙箱镜像

生产执行器（`EXECUTOR=docker`）为每个任务启动一个此镜像的容器（PRD §4.5）。

## 构建

在仓库根目录（需要 `apps/runtime/dist` 已构建、`node_modules` 已安装）：

```bash
pnpm --filter @apolla/runtime run build
docker build -f infra/sandbox/Dockerfile -t apolla-sandbox:dev .
```

## 隔离与加固（PRD T-210）

- 非 root 用户 `apolla`，工作区挂载在 `/workspace`
- 资源限制由 DockerExecutor 施加：内存 4G / CPU 2 核（可在管理后台调整）
- 出网默认仅放行：LiteLLM 网关、server WS 桥、MinIO、Connector Hub
- 可选 gVisor（`runsc` RuntimeClass）进一步隔离——在 K8s 部署时启用

## 说明

开发默认用 `LocalExecutor`（进程内执行，零容器依赖），无需此镜像；
切到 `EXECUTOR=docker` 且设置 `SANDBOX_IMAGE=apolla-sandbox:dev` 后启用容器隔离。
