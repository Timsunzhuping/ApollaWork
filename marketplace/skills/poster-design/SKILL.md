---
name: poster-design
description: 当需要生成海报/信息图/数据大图（PNG）时使用——用 matplotlib 排版标题、要点、指标数字与配图，产出可直接用的高清图片。
---

# 海报 / 信息图生成

用 Python（matplotlib + PIL）把主题与要点合成一张排版讲究的信息图 PNG。属于「多模态生成」能力（生成图像）。

## 步骤

1. 明确：主题标题、3–6 条要点或关键指标（数字+标签）、配色倾向（默认用 Apolla 绿 #0F7A5C + 中性灰）、画幅（默认 1080×1350 竖版，或 1200×630 横版）。
2. 用 Bash 运行 python 脚本，用 matplotlib 绘制：
   - 设中文字体（尝试 'PingFang SC' / 'Noto Sans CJK SC' / 'Arial Unicode MS'，`plt.rcParams['axes.unicode_minus']=False`）。
   - 顶部大标题 + 副标题；中部用色块卡片排关键指标（大号数字 + 小标签）；底部落款。
   - 用 `fig = plt.figure(figsize=(w/100,h/100), dpi=200)`、`fig.patch.set_facecolor(...)`、`ax.axis('off')`、`ax.text(...)` 精确定位（0–1 坐标）。
   - `plt.savefig('poster.png', dpi=200, bbox_inches='tight')`。
3. 如需照片/图标配图，用 PIL 合成（`Image.open`/`paste`）；无素材则用几何色块与线条装饰，保持留白与对齐。
4. 检查：中文无方块、无元素重叠、对比度足够。

## 产出

把图片写入工作区 `poster.png`（或按主题命名），用 Artifact 登记为「信息图」（kind: chart）。附一句设计说明（主色、版式、突出的指标）。

## 说明（图像理解）

本技能是「图像生成」。若需「图像理解」（读图/OCR/看图表回答），需在管理后台配置多模态（VLM）模型；平台的模型接入为 OpenAI 兼容协议，配置视觉模型后可扩展 Read 图片直接送模型理解——见 docs/multimodal.md。
