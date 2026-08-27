---
name: dataviz
description: 当需要用 Python 生成统一风格的统计图表 PNG（柱状图、折线图、饼/环形图、散点图）时使用——自动处理中文字体、和谐配色与高清导出，供报告/PPT 插图。
allowed-tools: Read, Write, Edit, Bash, Artifact
---

# dataviz · 统一风格数据可视化

用 `matplotlib` 出**风格统一**的图表 PNG：中文字体自动探测（杜绝方块）、一套和谐配色、
去除多余边框、200dpi 高清导出。`scripts/plot_helpers.py` 提供开箱即用的绘图函数。

## 环境
- 运行时预装 `matplotlib`（含 `numpy`），镜像装有 Noto CJK 字体；用 `Bash` 执行 `python3`。
- 必须用非交互后端：脚本已在导入时 `matplotlib.use("Agg")`，请勿改回交互后端。
- 技能目录绝对路径记为 `<SKILL_DIR>`；`sys.path.insert(0, "<SKILL_DIR>/scripts")` 后 `import plot_helpers`。

## 关键点：中文字体
调 `setup_cjk_font()` 会在候选列表（`PingFang SC`/`Noto Sans CJK SC`/`Microsoft YaHei`/
`Heiti SC`/`Arial Unicode MS`/`SimHei` 等）中挑选系统真实存在的字体，并关闭负号乱码
（`axes.unicode_minus=False`）。各绘图函数内部已自动调用，一般无需手动调。若返回 `None`
说明系统无 CJK 字体，此时中文可能显示为方块——应改用英文标签或提示用户装字体。

## 助手函数（scripts/plot_helpers.py）
所有函数返回保存路径；`values` 传 `[..]` 为单系列，传 `{系列名:[..]}` 为多系列。
- `setup_cjk_font(preferred=None)`：设置中文字体，返回选中的字体名。
- `bar_chart(categories, values, path, title, xlabel, ylabel, horizontal=False, value_labels=True)`
- `line_chart(categories, values, path, title, xlabel, ylabel, markers=True)`
- `pie_chart(labels, values, path, title, donut=False, show_percent=True)`
- `scatter_chart(x, y, path, title, xlabel, ylabel, labels=None)`
- `PALETTE`：10 色和谐色板（十六进制）；`TEXT_COLOR`/`GRID_COLOR` 供自定义。

## 代码范例
```python
import sys
sys.path.insert(0, "<SKILL_DIR>/scripts")
from plot_helpers import bar_chart, line_chart, pie_chart, scatter_chart, PALETTE

# 单系列柱状图
bar_chart(["华东", "华北", "华南", "西南"], [1200, 900, 1500, 700],
          "region_bar.png", title="各区域销售额", ylabel="万元")

# 多系列分组柱状图
bar_chart(["Q1", "Q2", "Q3", "Q4"],
          {"2024": [220, 260, 250, 270], "2025": [270, 300, 310, 320]},
          "quarter_bar.png", title="季度营收对比", ylabel="万元")

# 多系列折线（趋势）
line_chart(["1月", "2月", "3月", "4月", "5月", "6月"],
           {"收入": [100, 120, 110, 140, 160, 180], "成本": [70, 80, 78, 95, 105, 118]},
           "trend.png", title="收入与成本趋势", ylabel="万元")

# 环形图（占比）
pie_chart(["直销", "分销", "线上"], [45, 30, 25], "channel_pie.png",
          title="渠道占比", donut=True)

# 散点图
scatter_chart([1, 2, 3, 4, 5], [2, 4, 3, 6, 5], "scatter.png",
              title="投入产出", xlabel="投入", ylabel="产出",
              labels=["A", "B", "C", "D", "E"])
print("done")
```

`python3 <SKILL_DIR>/scripts/plot_helpers.py` 会在 `/tmp` 生成几张示例图验证环境。

## 与其它技能协作
- 图表是**中间产物**：生成 PNG 后交给 **docx-report**（`add_image`）或 **pptx-builder**
  （`add_image_slide`）插入，无需单独交付。
- 若同一份报告有多图，保持相同 `figsize` 与配色（默认即统一），观感更专业。

## 风格与定制
- 默认风格：白底、隐藏上/右边框、浅灰 y 轴网格、标题加粗、柱顶数值标签（≤3 系列时）。
- 想自定义颜色传 `colors=["#2E5EAA", "#E07B39", ...]` 或复用 `PALETTE` 切片。
- 需要更复杂图（堆叠、双轴、箱线等）可直接用 matplotlib，但请先 `setup_cjk_font()` 再作图，
  并用 `fig.savefig(path, dpi=200, bbox_inches="tight", facecolor="white")` 导出以保持一致。

## 产物登记（可选）
若图表本身作为独立交付物：
```
Artifact(path="<绝对路径>/trend.png", title="收入与成本趋势", kind="image")
```

## 常见坑
- 中文方块 → 确认 `setup_cjk_font()` 返回非 None；返回 None 时系统缺 CJK 字体。
- 负号显示成方块 → 已由 `axes.unicode_minus=False` 处理，勿覆盖该设置。
- 图片糊 → 保持 `dpi=200`（助手默认），不要降 dpi。
