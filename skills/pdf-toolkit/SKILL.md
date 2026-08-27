---
name: pdf-toolkit
description: 当需要处理 PDF 文件时使用——合并、拆分、抽取指定页、提取文本或表格，或为后续分析（如财报解析）从 PDF 取出可处理的文本/结构化数据。
allowed-tools: Read, Write, Edit, Bash, Artifact
---

# pdf-toolkit · PDF 处理

用 `pypdf` 做页级操作（合并/拆分/抽页/提取文本），表格用 `pdfplumber`（可用时）提取、
不可用则降级到纯文本。`scripts/pdf_helpers.py` 既是模块也是命令行工具。

## 环境
- 运行时预装 `pypdf`；`pdfplumber` 若安装则用于表格，未装时自动降级。
- 技能目录绝对路径记为 `<SKILL_DIR>`。脚本可直接用 `Bash` 调用（依赖惰性导入）。
- 页码一律 **1-based**；页集合表达式如 `1,3,5-8`。

## 命令行用法（推荐，最省事）
```bash
# 合并
python3 <SKILL_DIR>/scripts/pdf_helpers.py merge a.pdf b.pdf c.pdf -o merged.pdf
# 按页拆成单页 PDF
python3 <SKILL_DIR>/scripts/pdf_helpers.py split big.pdf -d out_dir/
# 抽取指定页另存
python3 <SKILL_DIR>/scripts/pdf_helpers.py extract-pages src.pdf -p 1,3,5-8 -o subset.pdf
# 提取文本（-p 省略则全篇；-o 省略则打印到标准输出）
python3 <SKILL_DIR>/scripts/pdf_helpers.py text src.pdf -p 1-3 -o text.txt
# 提取表格，输出 JSON（pdfplumber 不可用会给出降级提示并以退出码 2 结束）
python3 <SKILL_DIR>/scripts/pdf_helpers.py tables src.pdf -p 2
```

## 作为模块调用
```python
import sys
sys.path.insert(0, "<SKILL_DIR>/scripts")
import pdf_helpers as pdf

pdf.merge(["a.pdf", "b.pdf"], "merged.pdf")
pdf.extract_pages("src.pdf", pdf.parse_pages("2-4,7"), "subset.pdf")
text = pdf.extract_text("src.pdf", pages=[1, 2, 3])   # 返回字符串
tables = pdf.extract_tables("src.pdf", pages=[2])       # None 表示 pdfplumber 不可用
```

函数清单：`merge(inputs, output)`、`split_all(input, out_dir)`、
`extract_pages(input, pages, output)`、`extract_text(input, pages=None)`、
`extract_tables(input, pages=None)`、`parse_pages("1,3,5-8")`。

## 「抽文本做后续分析」的标准流程
很多任务（尤其**财报分析**）第一步是把 PDF 变成可处理文本/表格：
1. 先 `extract_text` 通读，定位目标章节（如“合并资产负债表”“合并利润表”所在页）。
2. 对目标页优先 `extract_tables`（pdfplumber）拿到二维表；若返回 `None`（未装 pdfplumber）
   或表格错乱，则回退用 `extract_text` 的纯文本，再用正则/规则抽取科目与数值。
3. 把抽取到的科目整理成结构化数据（如 `dict` 或写入临时 csv），交给 **xlsx-analyst** 计算、
   **dataviz** 画图、**finance-analyst** 算指标。
4. 数值清洗要点：去掉千分位逗号与全角空格；括号数字 `(123)` 表示负数 `-123`；
   注意单位（元/万元/百万元）与合并 vs 母公司口径，保持全表一致。

```python
text = pdf.extract_text("annual_report.pdf")           # 先全篇定位
# 找到利润表在第 42 页后，抽该页表格
rows = pdf.extract_tables("annual_report.pdf", pages=[42])
if rows is None:                                        # 降级
    page_text = pdf.extract_text("annual_report.pdf", pages=[42])
    # ... 用规则从 page_text 解析 ...
```

## 说明与产物登记
- 扫描件（图片型 PDF）`extract_text` 会得到空串：本技能不含 OCR，遇到扫描件应告知用户需 OCR 能力，不要伪造内容。
- 生成新 PDF（merge/extract-pages/split）后，如作为交付物用 `Artifact` 登记：
```
Artifact(path="<绝对路径>/merged.pdf", title="合并文档", kind="document")
```

## 常见坑
- 页码从 1 开始，别用 0；越界页会被静默跳过。
- `tables` 子命令退出码为 2 且提示“pdfplumber 不可用”→ 按上面的降级流程改用 `text`。
- 合并大量文件时按传入顺序拼接，注意实参顺序即页序。
