# Apolla Work 开发状态

> 快照：2026-08-28。任务编号对应 [PRD §7](PRD.md)。✅ 完成并验证 · 🟡 部分/骨架 · ⬜ 未开始。

## 汇总

- **功能完整度**：PRD M0–M3 全部里程碑落地（47 任务完成 / 6 部分 / 1 客户验收门）。
- **生产加固**：P0/P1/P2 全部关闭，含 7 个真实缺陷修复（越权、丢数据、并发撞号、
  ask 模式挂起、软链接穿透…）。详见 [production-readiness.md](production-readiness.md)。
- **本地部署可用**：`bash scripts/start-local.sh` 单进程起 Web+API；配 `MODEL_*`
  或在管理后台「模型接入」填 OpenAI 兼容端点即用真实模型。
- **真实环境验证**：ollama qwen3:4b 全链路任务、PostgreSQL 16、MinIO（S3 端到端）、
  Redis 7（跨副本事件 + 原子 seq + BullMQ 分发）。
- **质量门全绿**：134 单元/集成测试 + 黄金 10/10 + 红队 48/48（严格零缺口）+ 性能达标。
- **规模**：9 包 + 9 内置/市场技能 + 部署制品，约 15k 行 TS/Py。

## M0 骨架 ✅
T-001 Monorepo ✅ · T-002 compose 🟡（dev 默认 SQLite/fs 免启） · T-003 protocol ✅ · T-004 模型网关 ✅ · T-005 Loop ✅ · T-006 工具 ✅ · T-007 沙箱镜像 ✅（已 build 成 apolla-sandbox:1.0，容器模式实测跑通、非 root 实证） · T-009 CLI ✅ · T-010 黄金评测 ✅ · T-011 模型定档 ✅（管理后台配置+连通测试；真实跑分待更强模型）

## M1 MVP ✅
T-101 Schema ✅ · T-102 任务服务 ✅ · T-103 事件网关（SSE+回放）✅ · T-104 文件/产物 ✅ · T-105 审批 ✅ · T-106 权限模式 ✅ · T-107 上下文管理 ✅ · T-108 技能加载 ✅ · T-109 MCP ✅ · T-110 6 技能 ✅ · T-111 WebFetch/Search ✅ · T-112–116 前端 ✅ · T-117 Keycloak/OIDC ✅（JWT 验签+JIT+角色，realm+compose；离线单测）· T-118 审计/用量 ✅ · T-119 管理后台 ✅ · T-120 部署 ✅（compose.prod+install.sh+单进程）· T-121 OTel ✅（OTLP 导出+事件溯源回放端点）· T-122 评测回归 ✅（内测待真实模型）

## M2 企业化 ✅（除下列）
T-201 解析管道 🟡（txt/md/csv 原生；pdf/docx 需 pypdf/python-docx）· T-202 检索+引用 ✅ · T-203 资料库 UI ✅ · T-204 自动化 ✅ · T-205/206 IM 通道 ✅（企微/钉钉/飞书桥+3 测试；真实收发需 Bot 凭据）· T-207 Connector Hub ✅（注册/加密/测试/注入+UI）· T-208 子代理/专家 ✅ · T-209 管理后台完整 ✅（配额中心 🟡）· T-210 沙箱加固 🟡（非 root+出网白名单+危险规则+realpath；gVisor 待 K8s）· T-211 K8s Helm ✅（chart 全套；未在真实集群 lint/apply）· T-212 离线包 ✅（pack/install 脚本+SBOM 占位）· T-213 安全冲刺 ✅（48 红队用例全防御，修复 2 个实测漏洞）

## M3 生态与桌面 ✅（除下列）
T-301 技能市场 ✅（浏览/安装/SHA256+UI+3 市场技能）· T-302 桌面壳 ✅（Electron，13 测试+真实启动冒烟；GUI 窗口需有显示的机器）· T-303 评测-微调闭环 ✅（事件→SFT 数据集导出脚本）· T-304 信创适配 🟡（鲲鹏/昇腾/麒麟指南 docs/xinchuang.md，未实测硬件）· T-305 多模态 🟡（生成侧 poster-design/dataviz 已交付；理解侧需配 VLM，见 docs/multimodal.md）

## 剩余待办（明确边界）
- **需外部系统才能"实测"**：IM 真实收发（Bot 凭据）、K8s 集群 apply、信创硬件、GPU 上更强模型的黄金跑分。以上均已交付可运行代码/配置/文档，缺的是运行环境而非实现。
- **OIDC 差最后一次浏览器点击**：真实 Keycloak 26 的令牌签发/验签/拒绝/JIT/角色映射 8 项已实测；code→token 交换需人工登录一次（我不向任何表单填密码）。
- **纯增量**：配额中心 UI、gVisor RuntimeClass 启用、VLM 图像理解的 runtime 附图（一处改动，见 multimodal.md）。

## 一键使用
```bash
# 1) 起真实模型（示例，任选其一）
ollama pull qwen2.5:7b            # 或指向企业 vLLM
# 2) 部署（单进程，Web+API 同端口 3001）
MODEL_BASE_URL=http://localhost:11434/v1 MODEL_API_KEY=ollama MODEL_DEFAULT=qwen2.5:7b \
  bash scripts/start-local.sh
# 3) 打开 http://localhost:3001 ；或在「管理后台→模型接入」里配置模型
```
