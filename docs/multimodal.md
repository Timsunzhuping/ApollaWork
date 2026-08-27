# 多模态能力（PRD T-305）

Apolla 的多模态分两条线：

## 1. 图像/文档「生成」（已具备）

- `dataviz` 技能：matplotlib 统一风格图表 PNG。
- `poster-design` 技能（市场）：海报 / 信息图合成。
- `docx-report` / `pptx-builder`：文档与幻灯片内嵌图表、图片。

这些走 Python，在沙箱内执行，无需额外模型，已可用。

## 2. 图像/文档「理解」（需配置 VLM）

看图回答、OCR、图表读数需要多模态大模型（VLM）。Apolla 模型接入是 **OpenAI 兼容协议**，因此：

1. 在管理后台「模型接入」配置一个视觉模型端点（如 Qwen2.5-VL / GLM-4V 经 vLLM 暴露的 `/v1`，或云端 VLM）。
2. 运行时扩展点（`apps/runtime/src/model.ts`）：把 `Read` 到的图片作为 `image_url`/base64 content part 附加到消息（OpenAI 多模态消息格式）。当前 `Read` 对图片返回元信息占位，改为按模型能力附图即可——接口已按 OpenAI content-parts 预留，属**增量改动，不动架构**。

### 落地清单（增量）
- [ ] 模型元数据加 `vision: true` 标记（ModelProvider 增字段）。
- [ ] runtime `Read` 图片时，若当前模型 vision=true，则以 content-part 形式回传图像。
- [ ] 新增 `image-insight` 技能：引导「读图→结构化提取→写结论」。

> 结论：生成侧已交付；理解侧是「配置 VLM + 一处 runtime 附图」的增量，平台架构无需改动。
