"""Apolla 资料库存储（PRD T-201/202）。

stdlib-only：SQLite FTS5 全文检索 + 结构化分块 + 引用溯源（文档+分块号+页码）。
生产可无缝换向量库（Qdrant）+ 嵌入重排——检索接口 search() 保持不变。

解析：txt/md/csv 用 stdlib；pdf/docx 若装了 pypdf/python-docx 则用，否则优雅降级。
"""
from __future__ import annotations
import os
import re
import sqlite3
import json
import hashlib
from dataclasses import dataclass, asdict
from typing import Optional

DEFAULT_DB = os.environ.get("KB_DB", os.path.join(os.path.dirname(__file__), "kb.db"))
CHUNK_CHARS = 800
CHUNK_OVERLAP = 120


@dataclass
class Hit:
    base: str
    doc: str
    chunk_no: int
    page: Optional[int]
    text: str
    score: float

    def to_dict(self):
        return asdict(self)


def _connect(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.execute(
        """CREATE TABLE IF NOT EXISTS documents(
            id TEXT PRIMARY KEY, base TEXT, name TEXT, pages INTEGER, chunks INTEGER)"""
    )
    # FTS5：seg 为分词后可检索列（CJK 转 bigram，解决 unicode61 不切中文的问题）；
    # body 为原文（UNINDEXED，仅用于展示与引用）。
    conn.execute(
        """CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
            base, doc, chunk_no UNINDEXED, page UNINDEXED, body UNINDEXED, seg,
            tokenize='unicode61')"""
    )
    return conn


_CJK = r"一-鿿㐀-䶿"


def _segment(text: str) -> str:
    """把文本转为空格分隔的可检索 token：CJK 出 overlapping bigram（+ 单字），ASCII 词保留。"""
    tokens: list[str] = []
    for m in re.finditer(rf"[{_CJK}]+|[A-Za-z0-9]+", text):
        s = m.group(0)
        if re.match(rf"[{_CJK}]", s):
            if len(s) == 1:
                tokens.append(s)
            else:
                tokens.extend(s[i : i + 2] for i in range(len(s) - 1))  # bigram
                tokens.extend(list(s))  # 单字兜底，提升召回
        else:
            tokens.append(s.lower())
    return " ".join(tokens)


# ---------- 解析 ----------
def _extract(path: str) -> list[tuple[Optional[int], str]]:
    """返回 [(page_or_None, text), ...]。按页保留页码用于引用定位。"""
    ext = os.path.splitext(path)[1].lower()
    if ext in (".txt", ".md", ".csv", ".json", ".log", ".tsv"):
        with open(path, encoding="utf-8", errors="ignore") as f:
            return [(None, f.read())]
    if ext == ".pdf":
        try:
            from pypdf import PdfReader

            reader = PdfReader(path)
            return [(i + 1, (p.extract_text() or "")) for i, p in enumerate(reader.pages)]
        except Exception as e:
            return [(None, f"[PDF 解析需要 pypdf：{e}]")]
    if ext == ".docx":
        try:
            from docx import Document

            doc = Document(path)
            return [(None, "\n".join(p.text for p in doc.paragraphs))]
        except Exception as e:
            return [(None, f"[docx 解析需要 python-docx：{e}]")]
    # 兜底：按文本读
    with open(path, encoding="utf-8", errors="ignore") as f:
        return [(None, f.read())]


def _chunk(text: str) -> list[str]:
    """按段落聚合到 ~CHUNK_CHARS，带重叠。表格/换行敏感的简单实现。"""
    text = re.sub(r"\n{3,}", "\n\n", text.strip())
    if not text:
        return []
    paras = [p.strip() for p in text.split("\n\n") if p.strip()]
    chunks, cur = [], ""
    for p in paras:
        if len(cur) + len(p) + 2 <= CHUNK_CHARS:
            cur = f"{cur}\n\n{p}" if cur else p
        else:
            if cur:
                chunks.append(cur)
            if len(p) > CHUNK_CHARS:
                # 超长段落硬切
                for i in range(0, len(p), CHUNK_CHARS - CHUNK_OVERLAP):
                    chunks.append(p[i : i + CHUNK_CHARS])
                cur = ""
            else:
                cur = p
    if cur:
        chunks.append(cur)
    return chunks


# ---------- 公共 API ----------
def add_document(base: str, path: str, db_path: str = DEFAULT_DB) -> dict:
    conn = _connect(db_path)
    name = os.path.basename(path)
    doc_id = hashlib.sha1(f"{base}/{name}".encode()).hexdigest()[:16]
    conn.execute("DELETE FROM chunks WHERE base=? AND doc=?", (base, name))
    conn.execute("DELETE FROM documents WHERE id=?", (doc_id,))
    pages = _extract(path)
    n = 0
    max_page = 0
    for page, text in pages:
        for ch in _chunk(text):
            conn.execute(
                "INSERT INTO chunks(base, doc, chunk_no, page, body, seg) VALUES (?,?,?,?,?,?)",
                (base, name, n, page, ch, _segment(ch)),
            )
            n += 1
        if page:
            max_page = max(max_page, page)
    conn.execute(
        "INSERT INTO documents(id, base, name, pages, chunks) VALUES (?,?,?,?,?)",
        (doc_id, base, name, max_page, n),
    )
    conn.commit()
    conn.close()
    return {"doc": name, "base": base, "chunks": n, "pages": max_page}


def _fts_query(q: str) -> str:
    # 与索引一致：把查询也 bigram 分词，OR 连接（召回优先，bm25 负责排序）
    seg = _segment(q).split()
    terms = [t for t in dict.fromkeys(seg)][:24]  # 去重、限长
    if not terms:
        return '""'
    return " OR ".join(f'"{t}"' for t in terms)


def search(query: str, base: Optional[str] = None, k: int = 5, db_path: str = DEFAULT_DB) -> list[Hit]:
    conn = _connect(db_path)
    match = _fts_query(query)
    sql = (
        "SELECT base, doc, chunk_no, page, body, bm25(chunks) AS score "
        "FROM chunks WHERE seg MATCH ?"
    )
    params: list = [match]
    if base:
        sql += " AND base = ?"
        params.append(base)
    sql += " ORDER BY score LIMIT ?"
    params.append(k)
    rows = conn.execute(sql, params).fetchall()
    conn.close()
    hits = []
    for base_, doc, chunk_no, page, text, score in rows:
        hits.append(Hit(base_, doc, chunk_no, page, text.strip(), round(-float(score), 3)))
    return hits


def list_docs(base: Optional[str] = None, db_path: str = DEFAULT_DB) -> list[dict]:
    conn = _connect(db_path)
    if base:
        rows = conn.execute("SELECT base, name, pages, chunks FROM documents WHERE base=?", (base,)).fetchall()
    else:
        rows = conn.execute("SELECT base, name, pages, chunks FROM documents").fetchall()
    conn.close()
    return [{"base": b, "name": n, "pages": p, "chunks": c} for b, n, p, c in rows]


def format_citations(hits: list[Hit]) -> str:
    if not hits:
        return "（未在资料库中找到相关内容）"
    out = []
    for i, h in enumerate(hits, 1):
        loc = f"{h.doc}" + (f" 第{h.page}页" if h.page else f" #{h.chunk_no}")
        out.append(f"[{i}] 来源：{loc}\n{h.text}")
    return "\n\n".join(out)


if __name__ == "__main__":
    # 自测：建库 → 入档 → 检索
    import tempfile

    d = tempfile.mkdtemp()
    db = os.path.join(d, "t.db")
    p = os.path.join(d, "policy.md")
    open(p, "w").write(
        "# 差旅报销政策\n\n员工出差住宿标准为每晚不超过500元。\n\n"
        "交通费凭票据实报销，高铁二等座、经济舱机票可报。\n\n"
        "报销需在出差结束后30天内提交，超期不予受理。"
    )
    print(add_document("hr", p, db))
    hits = search("住宿标准多少钱", base="hr", db_path=db)
    assert hits and "500" in hits[0].text, "检索未命中"
    print("检索命中：", hits[0].doc, "page", hits[0].page)
    print(format_citations(hits)[:200])
    print("KB 自测通过 ✅")
