---
name: finance-analyst
description: 当需要做财报分析时使用——从财报 PDF 或 Excel 抽取三大报表关键科目，计算营收/净利同比环比、毛利率、净利率、ROE、资产负债率、周转率与杜邦分析，并产出结论与报告。
allowed-tools: Read, Write, Edit, Bash, Skill, Artifact
---

# finance-analyst · 财报分析（组合技能）

这是一个**方法论 + 指标公式手册 + 计算助手**的组合技能。它本身不重复造轮子，而是编排
取数、算指标、画图、出报告四步，串起 pdf-toolkit / xlsx-analyst / dataviz / docx-report。

## 何时用
用户给出财报（年报/季报 PDF、或整理好的 Excel/CSV），希望得到财务指标、同环比、
杜邦分析或一份分析报告时。

## 环境与资料
- 计算助手：`scripts/fin_metrics.py`（纯 Python 标准库，无第三方依赖）。
- 公式手册：`references/metrics.md`——**动手算之前先 `Read` 它**，核对口径与公式。
- 技能目录记为 `<SKILL_DIR>`；`sys.path.insert(0, "<SKILL_DIR>/scripts")` 后 `import fin_metrics`。

## 四步工作流
### 1) 取数（Extract）
- **PDF 财报** → 调用 `Skill` 加载 **pdf-toolkit**：先 `extract_text` 定位“合并利润表/
  资产负债表/现金流量表”所在页，再对目标页 `extract_tables`（不可用则降级文本+规则）。
- **Excel/CSV** → 调用 `Skill` 加载 **xlsx-analyst**（或直接 pandas）读入。
- 清洗数值：去千分位逗号、全角空格；`(123)` = −123；统一单位（元/万元/百万元）与
  合并 vs 母公司口径。把关键科目整理成 `dict`（键名见 `fin_metrics.ACCOUNT_KEYS`）。

### 2) 算指标（Compute）
用 `fin_metrics` 计算，缺失科目留空即可（函数对缺失/除零返回 `None`，不会中断）：
```python
import sys
sys.path.insert(0, "<SKILL_DIR>/scripts")
from fin_metrics import compute_ratios, yoy_table, growth, cagr, fmt_pct, fmt_num

cur = {  # 本期科目（单位需一致，例：万元）
    "revenue": 1200, "cost_of_sales": 800, "operating_profit": 200,
    "ebit": 210, "ebt": 190, "tax": 40, "net_profit": 150,
    "net_profit_attributable": 140, "interest_expense": 20,
    "total_assets": 2000, "total_liabilities": 1200, "equity_attributable": 800,
    "current_assets": 900, "current_liabilities": 500, "inventory": 200,
    "accounts_receivable": 300, "operating_cash_flow": 170,
}
prev = {"revenue": 1000, "net_profit": 120, "net_profit_attributable": 112}

r = compute_ratios(cur)
print("毛利率", fmt_pct(r["gross_margin"]), "净利率", fmt_pct(r["net_margin"]),
      "ROE", fmt_pct(r["roe"]), "资产负债率", fmt_pct(r["debt_to_asset"]))
print("杜邦: ROE≈净利率×周转×乘数 =",
      fmt_pct(r["dupont_net_margin"]), "×", fmt_num(r["dupont_asset_turnover"]),
      "×", fmt_num(r["dupont_equity_multiplier"]), "=", fmt_pct(r["dupont_roe"]))
print("营收同比", fmt_pct(growth(cur["revenue"], prev["revenue"])),
      "归母净利同比", fmt_pct(growth(cur["net_profit_attributable"],
                                     prev["net_profit_attributable"])))
```
`compute_ratios` 输出键：`gross_margin / operating_margin / net_margin / roe / roa /
debt_to_asset / current_ratio / quick_ratio / equity_multiplier / interest_coverage /
asset_turnover / ar_turnover / inventory_turnover / effective_tax_rate /
ocf_to_net_profit / dupont_net_margin / dupont_asset_turnover /
dupont_equity_multiplier / dupont_roe`。
多期对比用 `yoy_table(current, previous)`（返回每个科目的 current/previous/delta/growth）；
多年趋势用 `cagr(begin, end, periods)`。公式与口径细节见 `references/metrics.md`。

### 3) 画图（Visualize）
调用 `Skill` 加载 **dataviz**：营收/净利多期用 `line_chart` 画趋势；毛利率/净利率用
`line_chart` 或 `bar_chart`；杜邦三因子用 `bar_chart`；资产结构用 `pie_chart`。生成 PNG 备用。

### 4) 出报告（Report）
调用 `Skill` 加载 **docx-report**（或 **pptx-builder**）：按“总览→盈利→营运偿债→现金质量
→风险展望”组织，用 `add_table_from_rows` 放指标表、`add_image` 插趋势图。最后 `Artifact` 登记。

## 分析框架（结论要点）
1. **总览**：营收/归母净利规模与同比，定调。
2. **盈利能力**：毛利率、净利率、ROE 水平与变动；用杜邦拆分定位是“提利润率、提周转、
   还是加杠杆”在驱动 ROE。
3. **营运与偿债**：应收/存货周转天数、资产负债率、流动/速动比率，判断效率与风险。
4. **现金质量**：净现比（经营现金流/净利润）>1 说明利润有现金支撑。
5. **风险提示**：基数效应、单期口径、非经常性损益、行业可比性等局限。

## 红线
- 只做**客观计算与描述性分析**。**不提供个性化投资建议、不给买卖结论**；用户若索要，
  说明本技能不承担投资顾问职责。
- 数值口径与单位必须一致并在报告中标注；抽取不确定时如实说明，绝不臆造缺失数据。
- 扫描件 PDF 无法直接抽文本时，告知需 OCR，不要编造数字。

## 产物登记（务必执行）
```
Artifact(path="<绝对路径>/财报分析报告.docx", title="XX 公司财报分析", kind="document")
```
