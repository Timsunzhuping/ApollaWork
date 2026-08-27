#!/usr/bin/env python3
"""资料库 MCP stdio 服务器（PRD F8）。

把资料库检索暴露为 MCP 工具 `kb_search`，Agent 以连接器形式调用——
架构上「资料库即工具」，无特殊分支。协议子集：initialize / tools/list / tools/call。

环境变量：KB_DB 指向 SQLite 库；KB_BASE 可选，限定默认知识库。
"""
import sys
import json
import os

sys.path.insert(0, os.path.dirname(__file__))
import kb_store  # noqa: E402


def send(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def handle(msg):
    mid = msg.get("id")
    method = msg.get("method")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": mid, "result": {
            "protocolVersion": "2024-11-05", "capabilities": {},
            "serverInfo": {"name": "apolla-kb", "version": "1.0"}}})
    elif method == "notifications/initialized":
        pass
    elif method == "tools/list":
        send({"jsonrpc": "2.0", "id": mid, "result": {"tools": [{
            "name": "kb_search",
            "description": "在企业资料库中检索相关内容，返回带来源与页码的片段。回答涉及企业知识/政策/历史资料时使用。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "检索问题或关键词"},
                    "base": {"type": "string", "description": "可选：限定知识库名"},
                    "k": {"type": "integer", "description": "返回条数，默认 5"},
                },
                "required": ["query"],
            },
        }]}})
    elif method == "tools/call":
        params = msg.get("params", {})
        args = params.get("arguments", {})
        if params.get("name") == "kb_search":
            base = args.get("base") or os.environ.get("KB_BASE")
            hits = kb_store.search(args.get("query", ""), base=base, k=int(args.get("k", 5)))
            text = kb_store.format_citations(hits)
            send({"jsonrpc": "2.0", "id": mid, "result": {"content": [{"type": "text", "text": text}]}})
        else:
            send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "unknown tool"}})
    elif mid is not None:
        send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "method not found"}})


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            handle(json.loads(line))
        except Exception as e:
            sys.stderr.write(f"kb_mcp error: {e}\n")


if __name__ == "__main__":
    main()
