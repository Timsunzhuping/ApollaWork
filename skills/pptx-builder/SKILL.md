---
name: pptx-builder
description: 当需要把大纲/要点转成成片 PowerPoint（.pptx）时使用——生成含封面、目录、要点内容页、图表页、图片页与结束页，统一配色与中文字体的演示文稿。
allowed-tools: Read, Write, Edit, Bash, Artifact
---

# pptx-builder · 大纲 → 成片 PPT

用 `python-pptx` 从结构化大纲生成 `.pptx`。为保证配色与中文字体一致、不受母版影响，
本技能统一在**空白版式**上手工排版，`scripts/pptx_helpers.py` 提供了各类页面的一行式函数。

## 环境
- 运行时预装 `python-pptx`，用 `Bash` 执行 `python3`。
- 技能目录绝对路径记为 `<SKILL_DIR>`；`sys.path.insert(0, "<SKILL_DIR>/scripts")` 后 `import pptx_helpers`。
- 中文字体同样需要写东亚字体属性（`a:ea`），助手已处理，勿只设 `font.name`。

## 标准流程
1. 先把内容整理成大纲：封面信息 → 目录条目 → 每页标题+要点 → 需要的图表/图片 → 结束语。
2. 图表两条路：数据简单用 `add_chart_slide`（PPT 原生图表，可在 PPT 内改数）；已用
   **dataviz** 出了 PNG 则用 `add_image_slide` 插图更省心、样式更统一。
3. 逐页调用助手函数追加 slide，最后 `prs.save(...)`。
4. `Artifact` 登记产物。

## 助手函数（scripts/pptx_helpers.py）
- `new_presentation(widescreen=True)`：新建（16:9）。
- `add_title_slide(prs, title, subtitle="", footer="")`：封面页。
- `add_toc_slide(prs, items, title="目录")`：目录页（自动编号）。
- `add_bullet_slide(prs, title, bullets)`：要点页。`bullets` 元素为字符串，或 `(文本, 层级)` 元组做次级缩进。
- `add_image_slide(prs, title, image_path, caption="")`：图片页（等比缩放居中）。
- `add_table_slide(prs, title, rows, col_widths_in=None)`：表格页（首行作表头）。
- `add_chart_slide(prs, title, categories, series, chart_type="col")`：原生图表页，`series` 为 `{系列名:[值]}`，`chart_type` ∈ `col/bar/line/pie`。
- `add_closing_slide(prs, text="谢谢", subtitle="")`：结束页。
- `THEME`：配色字典（`primary`/`accent`/`text`/`muted`）；`set_run_font`/`add_textbox`/`add_band` 供自定义排版。

坐标与尺寸单位为英寸；颜色为 6 位十六进制字符串。

## 代码范例
```python
import sys
sys.path.insert(0, "<SKILL_DIR>/scripts")
from pptx_helpers import (new_presentation, add_title_slide, add_toc_slide,
                          add_bullet_slide, add_chart_slide, add_image_slide,
                          add_table_slide, add_closing_slide)

prs = new_presentation(widescreen=True)

add_title_slide(prs, "2025 年度经营分析", "财务部 · 2026-01", footer="Apolla Work")
add_toc_slide(prs, ["经营概况", "收入分析", "盈利能力", "风险与展望"])

add_bullet_slide(prs, "经营概况", [
    "全年营收 1,200 万元，同比 +20%",
    ("华东区贡献 45%，为第一大市场", 1),
    ("线上渠道增速最快（+35%）", 1),
    "归母净利 140 万元，净利率提升 1.2pct",
])

add_chart_slide(prs, "季度营收（万元）", ["Q1", "Q2", "Q3", "Q4"],
                {"2024": [220, 260, 250, 270], "2025": [270, 300, 310, 320]},
                chart_type="col")

# 若已用 dataviz 生成 gross_margin.png：
add_image_slide(prs, "毛利率趋势", "gross_margin.png", caption="数据来源：管理报表")

add_table_slide(prs, "关键指标对比", [
    ["指标", "2025", "2024"],
    ["毛利率", "33.3%", "31.0%"],
    ["净利率", "12.5%", "12.0%"],
])

add_closing_slide(prs, "谢谢", "Q & A")
prs.save("经营分析.pptx")
print("done")
```

`python3 <SKILL_DIR>/scripts/pptx_helpers.py` 可跑内置自测验证环境。

## 排版建议
- 每页要点不超过 6 条、每条不超过两行；层级最多用到 1（次级）。
- 想改主色：修改 `THEME["primary"]`/`THEME["accent"]` 再生成，全篇统一变色。
- 需要自定义块，用 `add_textbox(slide, left, top, w, h, text, size, bold, color, align)` 与 `add_band(...)` 自由摆放。

## 产物登记（务必执行）
```
Artifact(path="<绝对路径>/经营分析.pptx", title="2025 年度经营分析", kind="presentation")
```

## 常见坑
- 中文字体不对/变默认 → 用助手的文本函数，勿绕过（已写 `a:ea`）。
- 图片被拉伸 → 用 `add_image_slide`，它按原图比例缩放；不要自己硬设 width 和 height。
- 原生图表数据要改 → `add_chart_slide` 生成的是可编辑图表，双击即可在 PPT 内改数据。
