import { describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Bridge } from './bridge.js';
import { MockAdapter } from './adapters/mock.js';

/**
 * 本地假 Apolla API（node:http，不依赖真实 server 与外网）：
 * 固定一个工作区/会话；任务按 prompt 关键字路由到成功/失败/长摘要三种剧本，
 * 且第一次 GET /tasks/:id 返回 running，第二次才给终态——顺便验证「轮询多次」。
 */
async function startStubApolla(): Promise<{ base: string; close: () => Promise<void> }> {
  const pollCount = new Map<string, number>();
  const LONG_SUMMARY = '长'.repeat(310);
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const send = (obj: unknown) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(obj));
      };
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (req.method === 'GET' && pathname === '/api/v1/workspaces') {
        return send([
          { id: 'ws_1', name: '默认工作区' },
          { id: 'ws_2', name: '第二个不该被选中' },
        ]);
      }
      if (req.method === 'POST' && pathname === '/api/v1/workspaces/ws_1/sessions') {
        return send({ id: 'sess_1' });
      }
      if (req.method === 'POST' && pathname === '/api/v1/sessions/sess_1/tasks') {
        const body = JSON.parse(raw) as { prompt: string; mode: string };
        const id = body.prompt.includes('必败')
          ? 'task_fail'
          : body.prompt.includes('长摘要')
            ? 'task_long'
            : 'task_ok';
        return send({ id, status: 'queued' });
      }
      const m = pathname.match(/^\/api\/v1\/tasks\/(\w+)$/);
      if (req.method === 'GET' && m) {
        const id = m[1];
        const n = (pollCount.get(id) ?? 0) + 1;
        pollCount.set(id, n);
        if (n < 2) return send({ id, status: 'running' });
        if (id === 'task_fail') return send({ id, status: 'failed', summary: '模型额度耗尽' });
        if (id === 'task_long') {
          return send({ id, status: 'completed', summary: LONG_SUMMARY, artifacts: [] });
        }
        return send({
          id,
          status: 'completed',
          summary: '已完成竞品调研并生成报告。',
          artifacts: [{ path: '报告/最终版.md', title: '调研报告' }],
        });
      }
      res.statusCode = 404;
      send({ error: 'not found' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** 组一套「mock 通道 + 指向 stub 的 bridge」，轮询间隔调小让测试跑得快 */
async function setup() {
  const stub = await startStubApolla();
  const mock = new MockAdapter();
  const bridge = new Bridge({
    apiBase: `${stub.base}/api/v1`,
    publicUrl: 'https://apolla.example.com',
    pollIntervalMs: 10,
    pollTimeoutMs: 5_000,
  });
  bridge.register(mock);
  await bridge.start();
  const teardown = async () => {
    await bridge.stop();
    await stub.close();
  };
  return { mock, bridge, teardown };
}

describe('IM 桥接（mock 通道 + 假 Apolla API）', () => {
  it('成功路径：注入消息 → 建任务 → 轮询到 completed → 回推 ✅ 摘要与产物链接', async () => {
    const { mock, bridge, teardown } = await setup();
    try {
      await mock.inject({ chatId: 'chat_9', userId: 'u_1', text: '帮我调研竞品' });
      expect(mock.sent).toHaveLength(1);
      const { chatId, text } = mock.sent[0];
      expect(chatId).toBe('chat_9');
      expect(text).toContain('✅ 任务完成：已完成竞品调研并生成报告。');
      // 产物清单：标题 + 通过 APOLLA_PUBLIC_URL 拼出的下载链接（未配 workspace 时取第一个 ws_1）
      expect(text).toContain('调研报告');
      expect(text).toContain(
        `https://apolla.example.com/api/v1/workspaces/ws_1/file?path=${encodeURIComponent('报告/最终版.md')}`,
      );
      // 任务结束后内存关联表应清空
      expect(bridge.pendingCount).toBe(0);
    } finally {
      await teardown();
    }
  });

  it('失败路径：任务 failed → 回推 ❌ 与失败原因', async () => {
    const { mock, teardown } = await setup();
    try {
      await mock.inject({ chatId: 'chat_2', userId: 'u_2', text: '这个任务必败' });
      expect(mock.sent).toHaveLength(1);
      const { text } = mock.sent[0];
      expect(text).toContain('❌');
      expect(text).toContain('模型额度耗尽');
      expect(text).not.toContain('✅');
    } finally {
      await teardown();
    }
  });

  it('摘要超长时只回推前 300 字', async () => {
    const { mock, teardown } = await setup();
    try {
      await mock.inject({ text: '来个长摘要' });
      const { text } = mock.sent[0];
      expect(text).toContain('长'.repeat(300));
      expect(text).not.toContain('长'.repeat(301));
    } finally {
      await teardown();
    }
  });
});
