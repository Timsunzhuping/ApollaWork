# 信创适配指南（T-304 文档先行）

> **状态：指南，非实测。** 本文为 T-304（麒麟/欧拉 OS、ARM、昇腾路径）的前置文档，内容基于公开资料与架构推演整理，**尚未在真实信创环境验证**。每节末尾列出验证清单，实测通过后应回填结论并移除“未验证”标注。

Apolla Work 的信创适配面主要有三块：CPU 架构（鲲鹏 ARM64）、AI 加速卡（昇腾 NPU 推理）、操作系统（麒麟/欧拉上的容器底座）。平台自身是标准容器化应用（Node.js + PostgreSQL + Valkey + MinIO + LiteLLM），不含 x86 专有依赖，适配以“重建镜像 + 换推理端点”为主。

## 1. ARM64（鲲鹏）构建注意 —— 未验证

基础镜像均有官方 arm64 版本：`node:22-slim`、`postgres:16-alpine`、`valkey/valkey:8-alpine`、`minio/minio`、`ubuntu:24.04` 都是多架构镜像；`ghcr.io/berriai/litellm` 官方提供 amd64/arm64（生产请锁定具体版本标签后确认）。需要自建的是 `apolla-server` 与 `apolla-sandbox` 两个镜像：

```bash
# 在 x86 构建机上交叉构建（需 binfmt/qemu：docker run --privileged tonistiigi/binfmt --install arm64）
docker buildx create --use --name apolla-builder   # 首次
docker buildx build --platform linux/arm64,linux/amd64 \
  -f infra/server/Dockerfile -t registry.example.com/apolla-server:0.1.0 --push .
docker buildx build --platform linux/arm64,linux/amd64 \
  -f infra/sandbox/Dockerfile -t registry.example.com/apolla-sandbox:0.1.0 --push .
```

注意点：

- **优先在鲲鹏机器上原生构建**。qemu 交叉构建 sandbox 镜像很慢（LibreOffice、中文字体、pip 装 pandas/matplotlib 等大包），且个别 Python 包在 qemu 下编译易超时。
- sandbox 镜像的 NodeSource 安装脚本（`setup_22.x`）支持 arm64；`libreoffice-*`、`fonts-noto-cjk`、`poppler-utils`、`ripgrep` 在 Ubuntu 24.04 arm64 仓库均有包。pip 依赖（pandas/matplotlib/Pillow/lxml）在 arm64 上有 manylinux wheel（离线环境需预先下载 arm64 wheel 或建内网 PyPI 镜像）。
- server 镜像内含 Prisma：Prisma 引擎需要 `linux-arm64-openssl-3.0.x` 二进制，`node:22-slim`（Debian）arm64 下官方支持；离线构建时确认 pnpm 缓存里带上了该架构引擎。
- **离线打包**：`infra/airgap-pack.sh` 打的是本机架构的镜像层。给鲲鹏环境打包必须在 arm64 机器上执行（或对多架构镜像先 `docker pull --platform linux/arm64` 再打包），并在目标机安装前核对 `docker image inspect <镜像> --format '{{.Architecture}}'` 为 `arm64`。

验证清单：鲲鹏 920 实机构建两镜像；黄金集在 arm64 全跑通；Prisma 迁移与 LibreOffice 转换抽查。

## 2. 昇腾推理路径 —— 未验证，平台零改动

平台经 LiteLLM 网关消费 **OpenAI 兼容端点**（`MODEL_BASE_URL` → LiteLLM → `api_base`），因此昇腾适配不触碰平台代码，只需推理层暴露 OpenAI 兼容 API：

- **vLLM-Ascend**（vllm-project/vllm-ascend 插件）：在昇腾 NPU 上运行 vLLM，原生提供 `/v1/chat/completions`。
- **MindIE**（华为推理引擎）：MindIE Service 提供 OpenAI 兼容接口（部分版本路径/参数有差异，必要时在 LiteLLM 里按 `openai/` 前缀 + 自定义 `api_base` 方式接入并实测流式与超参透传）。

接入方式就是改 LiteLLM 配置（compose 部署改 `infra/litellm/config.yaml`；Helm 部署改 `values.litellm.config`）：

```yaml
model_list:
  - model_name: apolla-deep
    litellm_params:
      model: openai/qwen3-32b            # openai/ 前缀 = 按 OpenAI 协议转发
      api_base: http://mindie.ml.svc:1025/v1   # vLLM-Ascend 或 MindIE 的 OpenAI 兼容端点
      api_key: none
```

注意点：驱动/固件与 CANN、vLLM-Ascend/MindIE 版本matrix 必须严格对齐（这是昇腾部署的主要坑）；长上下文与并发吞吐建议先跑压测再定档位（apolla-deep/apolla-fast 分档路由）；流式（SSE）与 `tool_calls` 兼容性需用平台黄金集实测。

验证清单：Atlas 800/300I 上起 vLLM-Ascend 或 MindIE；LiteLLM 打通流式对话与工具调用；黄金集端到端通过。

## 3. 麒麟 OS 上的 Docker / K8s 注意点 —— 未验证

麒麟（Kylin V10 SP2/SP3，含 openEuler 内核系）上跑容器的已知注意点（社区经验汇总，非本项目实测）：

- **容器引擎版本**：系统源里的 docker 往往偏旧（18.x/19.x），建议装较新的 docker-ce（或内网镜像源），并确认 `docker compose` v2 插件可用——`infra/airgap-install.sh` 依赖 compose v2。麒麟系也常见 iSulad；本项目脚本按 docker CLI 编写，用 iSulad 需自行改造或走 K8s（containerd）路径。
- **cgroup**：Kylin V10 默认 cgroup v1（内核 4.19 系）。新版 K8s（1.29+）与 containerd 在 cgroup v1 上仍支持但趋于淘汰；systemd cgroup 驱动要与 kubelet/容器运行时配置一致（`SystemdCgroup = true`），否则 Pod 反复重启。
- **内核与安全模块**：部分镜像（尤其较新 glibc 的 alpine/debian 基础镜像）对老内核 syscall 有要求，遇 `clone3`/`faccessat2` 报错可升级 runc/containerd 或放开 seccomp；麒麟的安全增强（KySec/SELinux）可能拦 overlay 与特权操作，容器起不来时先查安全模块日志再考虑调策略（不要一刀切关闭）。
- **K8s 发行版**：麒麟上常见组合为 kubeadm + containerd、openEuler 系 K8s 或国产容器云平台。Helm chart 本身不感知 OS；重点核对 StorageClass（本地盘/国产存储 CSI）与镜像仓库证书（内网 CA 需配置到 containerd）。
- **时间与证书**：离线内网机时钟漂移会导致 TLS/JWT 校验失败，部署前对时（chrony 指向内网 NTP）。
- **字体/办公转换**：sandbox 镜像自带 LibreOffice 与 Noto CJK 字体，文档转换不依赖宿主 OS 字体，麒麟上无需额外装字体。

验证清单：Kylin V10 SP3（鲲鹏）实机跑 `airgap-install.sh` 全流程；kubeadm 集群上 `helm install` 全组件 Running；沙箱任务（office→pdf、pandas 分析）抽查。

## 4. 汇总：交付形态

| 场景 | 交付物 | 适配动作 |
| --- | --- | --- |
| x86 + NVIDIA | 现有 compose/离线包/Helm | 无 |
| 鲲鹏 ARM64 | arm64 镜像 + 离线包（arm64 机器上打包） | buildx/原生重建两镜像 |
| 昇腾 NPU | 同上任一 + vLLM-Ascend/MindIE | 仅改 LiteLLM `api_base` |
| 麒麟/欧拉 OS | 同上 | 容器底座核对（docker-ce/compose v2/cgroup/安全模块） |

再次强调：以上均为**指南性内容，未经实测**；T-304 验证完成前，不应向客户承诺信创环境 SLA。
