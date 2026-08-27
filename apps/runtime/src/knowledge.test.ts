import { describe, expect, it, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { TaskEvent } from '@apolla/protocol';
import { runTask } from './runner.js';
import type { EventSink, ControlSource } from './emitter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KB_DIR = path.resolve(__dirname, '../../knowledge');
const KB_MCP = path.join(KB_DIR, 'kb_mcp.py');

let pythonOk = false;
let kbDb = '';
let docDir = '';

beforeAll(() => {
  try {
    docDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apolla-kb-'));
    kbDb = path.join(docDir, 'kb.db');
    const doc = path.join(docDir, 'policy.md');
    fs.writeFileSync(
      doc,
      '# 报销政策\n\n差旅住宿每晚上限 500 元。\n\n餐补每天 100 元，凭票报销。',
    );
    execFileSync(
      'python3',
      ['-c', `import sys; sys.path.insert(0,'${KB_DIR}'); import kb_store; kb_store.add_document('hr','${doc}','${kbDb}')`],
      { stdio: 'pipe' },
    );
    pythonOk = true;
  } catch {
    pythonOk = false;
  }
});

class Sink implements EventSink {
  events: TaskEvent[] = [];
  emit(e: TaskEvent) {
    this.events.push(e);
  }
}
class Ctl implements ControlSource {
  async waitApproval() {
    return true;
  }
  async waitAnswer() {
    return 'x';
  }
  drainUserInputs() {
    return [];
  }
  isCancelled() {
    return false;
  }
}

describe('资料库 RAG（T-201/202，经 MCP 连接器）', () => {
  it('Agent 通过 kb_search 检索到带引用的内容', async () => {
    if (!pythonOk) {
      console.warn('跳过：python3/kb_store 不可用');
      return;
    }
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'apolla-kbws-'));
    const sink = new Sink();
    const res = await runTask(
      {
        prompt:
          '查住宿标准。[[ACTIONS]]' +
          JSON.stringify([
            { tool: 'mcp__kb__kb_search', args: { query: '住宿标准是多少' } },
            { say: '已依据资料库回答' },
          ]) +
          '[[/ACTIONS]]',
        workspaceDir: ws,
        modelConfig: { model: 'mock' },
        skillRoots: [],
        mcpServers: [
          { name: 'kb', transport: 'stdio', command: 'python3', args: [KB_MCP], env: { KB_DB: kbDb } },
        ],
      },
      sink,
      new Ctl(),
    );
    expect(res.status).toBe('completed');
    const r = sink.events.find((e) => e.type === 'tool.result' && e.name === 'mcp__kb__kb_search');
    expect(r && 'ok' in r && r.ok).toBe(true);
    expect(r && 'resultPreview' in r && r.resultPreview).toMatch(/500|来源/);
  });
});
