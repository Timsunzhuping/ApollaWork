#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""pdf-toolkit 技能助手：合并 / 拆分 / 提取页 / 提取文本 / 提取表格。

既可作为模块 import，也可直接当 CLI 用（依赖 pypdf；表格提取优先 pdfplumber）::

    python3 pdf_helpers.py merge a.pdf b.pdf -o merged.pdf
    python3 pdf_helpers.py split big.pdf -d out_dir/
    python3 pdf_helpers.py extract-pages src.pdf -p 1,3,5-8 -o subset.pdf
    python3 pdf_helpers.py text src.pdf -p 1-3 -o text.txt
    python3 pdf_helpers.py tables src.pdf -p 2      # 输出 JSON

页码一律 1-based。依赖为惰性导入，故 --help 无需装库即可运行。
"""
import argparse
import json
import os
import sys


def merge(inputs, output):
    """按顺序合并多个 PDF。"""
    from pypdf import PdfWriter

    writer = PdfWriter()
    for path in inputs:
        writer.append(path)
    with open(output, "wb") as fh:
        writer.write(fh)
    return output


def split_all(input_path, out_dir):
    """把每一页拆成单独的 PDF，返回生成文件列表。"""
    from pypdf import PdfReader, PdfWriter

    os.makedirs(out_dir, exist_ok=True)
    reader = PdfReader(input_path)
    base = os.path.splitext(os.path.basename(input_path))[0]
    outputs = []
    for i, page in enumerate(reader.pages):
        writer = PdfWriter()
        writer.add_page(page)
        out = os.path.join(out_dir, "%s_p%d.pdf" % (base, i + 1))
        with open(out, "wb") as fh:
            writer.write(fh)
        outputs.append(out)
    return outputs


def extract_pages(input_path, pages, output):
    """抽取指定页（1-based 列表）另存为新 PDF。"""
    from pypdf import PdfReader, PdfWriter

    reader = PdfReader(input_path)
    writer = PdfWriter()
    total = len(reader.pages)
    for p in pages:
        if 1 <= p <= total:
            writer.add_page(reader.pages[p - 1])
    with open(output, "wb") as fh:
        writer.write(fh)
    return output


def extract_text(input_path, pages=None):
    """提取文本。pages 为 None 则全篇；返回拼接后的字符串。"""
    from pypdf import PdfReader

    reader = PdfReader(input_path)
    total = len(reader.pages)
    indices = pages or range(1, total + 1)
    chunks = []
    for p in indices:
        if 1 <= p <= total:
            chunks.append(reader.pages[p - 1].extract_text() or "")
    return "\n\n".join(chunks)


def extract_tables(input_path, pages=None):
    """提取表格：优先 pdfplumber。

    返回 [{"page": n, "table": [[cell,...], ...]}]；若 pdfplumber 不可用返回 None，
    调用方应回退到 extract_text 再自行解析。
    """
    try:
        import pdfplumber
    except Exception:
        return None
    results = []
    with pdfplumber.open(input_path) as pdf:
        total = len(pdf.pages)
        indices = pages or range(1, total + 1)
        for p in indices:
            if 1 <= p <= total:
                for table in pdf.pages[p - 1].extract_tables():
                    results.append({"page": p, "table": table})
    return results


def parse_pages(expr):
    """把 '1,3,5-8' 解析为 [1, 3, 5, 6, 7, 8]。"""
    pages = []
    for part in str(expr).split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            start, end = part.split("-", 1)
            pages.extend(range(int(start), int(end) + 1))
        else:
            pages.append(int(part))
    return pages


def main(argv=None):
    parser = argparse.ArgumentParser(description="PDF toolkit（pypdf/pdfplumber）")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_merge = sub.add_parser("merge", help="合并多个 PDF")
    p_merge.add_argument("inputs", nargs="+")
    p_merge.add_argument("-o", "--output", required=True)

    p_split = sub.add_parser("split", help="按页拆分")
    p_split.add_argument("input")
    p_split.add_argument("-d", "--out-dir", required=True)

    p_pages = sub.add_parser("extract-pages", help="抽取指定页另存")
    p_pages.add_argument("input")
    p_pages.add_argument("-p", "--pages", required=True)
    p_pages.add_argument("-o", "--output", required=True)

    p_text = sub.add_parser("text", help="提取文本")
    p_text.add_argument("input")
    p_text.add_argument("-p", "--pages")
    p_text.add_argument("-o", "--output")

    p_tables = sub.add_parser("tables", help="提取表格（JSON）")
    p_tables.add_argument("input")
    p_tables.add_argument("-p", "--pages")

    args = parser.parse_args(argv)
    if args.cmd == "merge":
        print(merge(args.inputs, args.output))
    elif args.cmd == "split":
        for out in split_all(args.input, args.out_dir):
            print(out)
    elif args.cmd == "extract-pages":
        print(extract_pages(args.input, parse_pages(args.pages), args.output))
    elif args.cmd == "text":
        pages = parse_pages(args.pages) if args.pages else None
        text = extract_text(args.input, pages)
        if args.output:
            with open(args.output, "w", encoding="utf-8") as fh:
                fh.write(text)
            print(args.output)
        else:
            print(text)
    elif args.cmd == "tables":
        pages = parse_pages(args.pages) if args.pages else None
        result = extract_tables(args.input, pages)
        if result is None:
            print("pdfplumber 不可用：请改用 `text` 子命令提取文本后再解析。",
                  file=sys.stderr)
            sys.exit(2)
        print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
