import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TaskEvent } from '@apolla/protocol';
import { connectMcpServers } from './mcp-client.js';
import { runTask } from './runner.js';
import type { EventSink, ControlSource } from './emitter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STUB = path.resolve(__dirname, '../test-fixtures/stub-mcp-server.mjs');

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

describe('MCP 连接器', () => {
  it('连接 stub 服务器并列出工具', async () => {
    const { clients, tools, errors } = await connectMcpServers([
      { name: 'stub', transport: 'stdio', command: 'node', args: [STUB] },
    ]);
    expect(errors).toEqual([]);
    expect(tools.map((t) => t.qualifiedName)).toContain('mcp__stub__echo');
    const result = await clients.get('stub')!.callTool('echo', { text: 'hi' });
    expect(result).toBe('echo:hi');
    for (const c of clients.values()) c.close();
  });

  it('Agent 能通过 mcp__stub__echo 工具调用连接器', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'apolla-mcp-'));
    const sink = new Sink();
    const res = await runTask(
      {
        prompt:
          '用连接器。[[ACTIONS]]' +
          JSON.stringify([
            { tool: 'mcp__stub__echo', args: { text: 'apolla' } },
            { say: '完成' },
          ]) +
          '[[/ACTIONS]]',
        workspaceDir: ws,
        modelConfig: { model: 'mock' },
        skillRoots: [],
        mcpServers: [{ name: 'stub', transport: 'stdio', command: 'node', args: [STUB] }],
      },
      sink,
      new Ctl(),
    );
    expect(res.status).toBe('completed');
    const toolResult = sink.events.find(
      (e) => e.type === 'tool.result' && e.name === 'mcp__stub__echo',
    );
    expect(toolResult && 'ok' in toolResult && toolResult.ok).toBe(true);
    expect(toolResult && 'resultPreview' in toolResult && toolResult.resultPreview).toContain('echo:apolla');
  });
});
