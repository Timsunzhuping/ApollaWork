# apolla-knowledge · 资料库（RAG）

企业知识库检索服务（PRD F8 / T-201·202）。**stdlib-only**，无需外部依赖即可运行。

## 组成

- `kb_store.py` — SQLite FTS5 存储：文档解析（txt/md/csv 原生；pdf 需 pypdf、docx 需 python-docx）、结构化分块、CJK bigram 分词（解决中文检索）、BM25 排序、引用溯源（文档+页码/分块号）。
- `kb_mcp.py` — MCP stdio 服务器，把检索暴露为工具 `kb_search`。Agent 以连接器形式调用，「资料库即工具」。

## 用法

```bash
# 入档
python3 -c "import kb_store; kb_store.add_document('hr', '/path/政策.pdf', 'kb.db')"
# 直接检索
python3 -c "import kb_store; print(kb_store.format_citations(kb_store.search('住宿标准', base='hr', db_path='kb.db')))"
# 作为 Agent 连接器（server 的 Connector Hub 会注入这条配置）
KB_DB=kb.db python3 kb_mcp.py   # stdio MCP
```

runtime 侧连接（`RunTaskParams.mcpServers`）：
```json
{ "name": "kb", "transport": "stdio", "command": "python3",
  "args": ["apps/knowledge/kb_mcp.py"], "env": { "KB_DB": "<库路径>", "KB_BASE": "hr" } }
```

## 生产演进（保持 search() 接口不变）

- 嵌入：bge-m3 生成向量 → Qdrant 存储；混合检索（向量 + FTS）+ bge-reranker 重排。
- 解析：接入 Docling 处理复杂 PDF/表格。
- 二者替换 `kb_store` 的索引/检索实现即可，MCP 工具契约与引用格式不变。

## 自测

```bash
python3 kb_store.py     # 建库→入档→检索 断言
```
