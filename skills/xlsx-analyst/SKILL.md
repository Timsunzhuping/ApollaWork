---
name: xlsx-analyst
description: 当需要对表格数据（csv/xlsx）做清洗、分组透视、汇总计算，并输出带样式、数字格式、条件格式与原生图表的 Excel（.xlsx）时使用。
allowed-tools: Read, Write, Edit, Bash, Artifact
---

# xlsx-analyst · Excel 数据分析

分工：**pandas 读数与算**（读取、清洗、分组、透视），**openpyxl 写与画**（表头样式、
数字格式、条件格式、Excel 原生图表）。`scripts/xlsx_helpers.py` 封装了写出与图表部分。

## 环境
- 运行时预装 `pandas` 与 `openpyxl`，用 `Bash` 执行 `python3`。
- 技能目录绝对路径记为 `<SKILL_DIR>`；`sys.path.insert(0, "<SKILL_DIR>/scripts")` 后 `import xlsx_helpers`。

## 标准流程
1. 用 `Read` 或直接 pandas 读入数据，先看列名、dtype、缺失、异常值。
2. 清洗：类型转换、去重、缺失填充、异常过滤。
3. 分析：`groupby`/`pivot_table` 做分组汇总或透视。
4. 写出：`write_df_with_style` 分 sheet 写；对关键列加数字格式与条件格式；插图表。
5. `Artifact` 登记产物。

## 助手函数（scripts/xlsx_helpers.py）
- `read_table(path, sheet=0)`：按扩展名自动读 csv/tsv/xlsx → DataFrame。
- `write_df_with_style(wb, df, sheet_name, number_formats=None, freeze_header=True, autofilter=True)`：写入并套表头样式（主色底+白字）、边框、冻结首行、筛选、自适应列宽。`number_formats` 形如 `{"金额":"#,##0.00", "占比":"0.0%"}`。
- `drop_default_sheet(wb)`：删掉 `Workbook()` 自带的空 `Sheet`。
- `add_bar_chart(ws, data_min_col, data_max_col, header_row, last_row, cats_col, anchor, title, horizontal=False)`：柱状图。
- `add_line_chart(...)` 同参：折线图（趋势）。
- `add_pie_chart(ws, data_col, header_row, last_row, cats_col, anchor, title)`：饼图。
- `add_color_scale(ws, "B2:B20")` / `add_data_bar(ws, "C2:C20")` / `highlight_gt(ws, "D2:D20", 阈值)`：条件格式。

图表列区间**含表头行**（`header_row`）用于系列名；分类列（`cats_col`）自动取表头下一行到末行。

## 代码范例
```python
import sys
sys.path.insert(0, "<SKILL_DIR>/scripts")
import pandas as pd
from openpyxl import Workbook
from xlsx_helpers import (read_table, write_df_with_style, drop_default_sheet,
                          add_bar_chart, add_line_chart, add_color_scale)

# 1) 读入 + 清洗
df = read_table("销售明细.csv")
df["date"] = pd.to_datetime(df["date"], errors="coerce")
df = df.dropna(subset=["amount"])
df["amount"] = df["amount"].astype(float)

# 2) 分组汇总
by_region = df.groupby("region", as_index=False)["amount"].sum().sort_values("amount", ascending=False)
by_month = (df.assign(month=df["date"].dt.strftime("%Y-%m"))
              .groupby("month", as_index=False)["amount"].sum())

# 3) 写出多 sheet
wb = Workbook()
ws1 = write_df_with_style(wb, by_region, "区域汇总", number_formats={"amount": "#,##0"})
ws2 = write_df_with_style(wb, by_month, "月度趋势", number_formats={"amount": "#,##0"})

# 4) 图表 + 条件格式
add_bar_chart(ws1, data_min_col=2, data_max_col=2, header_row=1,
              last_row=ws1.max_row, cats_col=1, anchor="E2", title="各区域销售额")
add_line_chart(ws2, data_min_col=2, data_max_col=2, header_row=1,
               last_row=ws2.max_row, cats_col=1, anchor="E2", title="月度销售趋势")
add_color_scale(ws1, "B2:B%d" % ws1.max_row)

drop_default_sheet(wb)
wb.save("销售分析.xlsx")
print("done")
```

`python3 <SKILL_DIR>/scripts/xlsx_helpers.py` 可跑内置自测验证环境。

## 透视表提示
需要交叉透视时用 pandas，再整体写出：
```python
pivot = pd.pivot_table(df, index="region", columns="channel",
                       values="amount", aggfunc="sum", fill_value=0).reset_index()
write_df_with_style(wb, pivot, "区域×渠道", number_formats={c: "#,##0" for c in pivot.columns[1:]})
```

## 产物登记（务必执行）
```
Artifact(path="<绝对路径>/销售分析.xlsx", title="销售分析", kind="spreadsheet")
```

## 常见坑
- 金额显示成科学计数或无千分位 → 用 `number_formats` 指定格式串，不要把数字转成字符串。
- 图表空白/系列名错 → 确认 `header_row` 指向表头那一行、`last_row=ws.max_row`。
- 中文列宽偏窄 → `write_df_with_style` 已按中文 2 倍宽估算，仍可手动设 `ws.column_dimensions["A"].width`。
- 需要公式而非静态值时，直接给单元格赋 `"=SUM(B2:B10)"` 字符串（openpyxl 写公式）。
