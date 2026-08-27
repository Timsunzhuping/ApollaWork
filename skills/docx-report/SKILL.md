---
name: docx-report
description: 当需要生成结构化 Word（.docx）报告时使用——带标题层级、目录、表格、配图与统一中文字体样式的正式文档（周报、分析报告、方案、纪要等）。
allowed-tools: Read, Write, Edit, Bash, Artifact
---

# docx-report · 结构化 Word 报告生成

用 `python-docx` 生成排版规范的 `.docx`。核心难点是**中文字体**：只设 `font.name`
不够，必须同时写 `w:eastAsia`，否则中文会回退成默认西文字体导致字形错乱。本技能的
`scripts/docx_helpers.py` 已封装好这些细节，优先复用它，不要从零手搓 XML。

## 环境
- 运行时预装 `python-docx`，用 `Bash` 执行 `python3`。
- 技能加载时的提醒会给出本技能目录的绝对路径（下称 `<SKILL_DIR>`）。
- 引用助手：在脚本开头 `sys.path.insert(0, "<SKILL_DIR>/scripts")` 后 `import docx_helpers`。

## 标准流程
1. 明确报告结构（封面/目录/各级标题/表格/图表/结论），必要时先用 `TodoWrite` 列计划。
2. 若需图表，先用 **dataviz** 技能出 PNG，再在文档里 `add_image` 插入。
3. 写一个 Python 脚本组织内容，`doc.save("<工作区路径>/xxx.docx")`。
4. 用 `Artifact` 工具登记产物（见文末）。

## 助手函数（scripts/docx_helpers.py）
- `set_default_font(doc, cn_font="宋体", latin_font="Times New Roman", size=11)`：设正文默认字体。
- `set_margins(doc, top, bottom, left, right)`：页边距（厘米）。
- `add_heading_cn(doc, text, level, cn_font="微软雅黑", color=None, size=None)`：带中文字体的标题，`level=0` 为大标题（Title）。
- `add_paragraph_cn(doc, text, size, bold, color, align, line_spacing, first_line_indent)`：正文段落；`first_line_indent=2` 表示首行缩进 2 字符。
- `add_table_from_rows(doc, rows, header=True, header_bg="2E5EAA", col_widths_cm=None)`：二维列表建表，首行作表头（加粗+底色+白字）。
- `set_cell_bg(cell, "2E5EAA")`：单元格底色。
- `add_toc(doc)`：插入目录域（Word 打开后需“更新域”才渲染条目，属正常现象）。
- `add_image(doc, path, width_in=6.0, caption=None)`：居中插图+图注。
- `set_run_font(run, cn_font, latin_font, size, bold, color)`：精细控制单个 run。

颜色参数用 6 位十六进制字符串（带不带 `#` 均可）。

## 代码范例
```python
import sys
sys.path.insert(0, "<SKILL_DIR>/scripts")
from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx_helpers import (set_default_font, set_margins, add_heading_cn,
                          add_paragraph_cn, add_table_from_rows, add_toc, add_image)

doc = Document()
set_default_font(doc, cn_font="宋体", latin_font="Times New Roman", size=11)
set_margins(doc)

# 封面
add_heading_cn(doc, "2025 年度经营分析报告", level=0, color="2E5EAA")
add_paragraph_cn(doc, "财务部 · 2026-01", size=12, color="808080",
                 align=WD_ALIGN_PARAGRAPH.CENTER)
doc.add_page_break()

# 目录
add_heading_cn(doc, "目录", level=1)
add_toc(doc)
doc.add_page_break()

# 正文
add_heading_cn(doc, "一、经营概况", level=1)
add_paragraph_cn(doc, "报告期内公司实现营业收入 1,200 万元，同比增长 20%……",
                 size=11, first_line_indent=2, line_spacing=1.5)

add_heading_cn(doc, "二、关键指标", level=1)
add_table_from_rows(doc, [
    ["科目", "本期", "上期", "同比"],
    ["营业收入", "1,200", "1,000", "+20.0%"],
    ["净利润", "150", "120", "+25.0%"],
], header_bg="2E5EAA", col_widths_cm=[5, 3, 3, 3])

# 配图（先用 dataviz 技能生成 trend.png）
add_image(doc, "trend.png", width_in=6.0, caption="图 1 季度营收趋势")

doc.save("经营分析报告.docx")
print("done")
```

把脚本存到 `<SKILL_DIR>` 之外（如工作区或 scratchpad）后 `python3 脚本.py` 执行。
也可直接 `python3 <SKILL_DIR>/scripts/docx_helpers.py` 跑内置自测，确认环境可用。

## 表格样式说明
`add_table_from_rows` 默认套用内置样式 `Table Grid`（有边框）。若想要更精致的样式，可传
`style="Light Grid Accent 1"` 等 Word 内置样式名；模板不含该样式时会自动忽略、不会报错。

## 产物登记（务必执行）
文档生成后，用 `Artifact` 工具登记，便于前端预览与交付：
```
Artifact(path="<绝对路径>/经营分析报告.docx", title="2025 年度经营分析报告", kind="document")
```

## 常见坑
- 中文变成方框或衬线错乱 → 一定用本技能的 `set_*`/`add_*` 函数，它们已写 `w:eastAsia`。
- 目录页打开是空的 → 正常，Word 里右键目录→“更新域”即可；这是 TOC 域机制，非 bug。
- 插入图片前确认 PNG 已生成且路径正确；宽度 `width_in` 以英寸计，A4 正文区约 6 英寸宽。
