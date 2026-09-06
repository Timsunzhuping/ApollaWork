import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import { ControlEnvelope, type RuntimeEnvelope, type TaskEvent } from '@apolla/protocol';
import type { ControlSource } from '@apolla/runtime';
import { SandboxBridge, type BridgeLimits, type BridgeTransport } from './sandbox-bridge.js';
import type { EgressPolicy } from './egress-policy.js';

/**
 * 沙箱桥接测试（T-402）。不依赖 Docker：用内存管道复刻容器 stdio ——
 * toServer 是容器的 stdout（上行帧），toContainer 是容器的 stdin（下行帧）。
 * 验证两件事：
 *   1) 审批/提问/取消/追加指令在 server 与容器之间正确往返（此前只发 cancel，ask 模式永久挂起）；
 *   2) 容器无网时的出网中继：策略放行才由 server 代为访问，密钥只在 server 侧注入。
 */

const allowAll: EgressPolicy = { fetch: () => ({ ok: true }), tcp: () => ({ ok: true }) };
const denyAll: EgressPolicy = {
  fetch: () => ({ ok: false, reason: '不在白名单' }),
  tcp: () => ({ ok: false, reason: '不在白名单' }),
};

function fakeControl() {
  const approvals = new Map<string, (ok: boolean) => void>();
  const answers = new Map<string, (a: string) => void>();
  let cancelled = false;
  const inputs: string[] = [];
  const src: ControlSource = {
    waitApproval: (id) => new Promise((r) => approvals.set(id, r)),
    waitAnswer: (id) => new Promise((r) => answers.set(id, r)),
    drainUserInputs: () => inputs.splice(0, inputs.length),
    isCancelled: () => cancelled,
  };
  return {
    src,
    approve: (id: string, ok: boolean) => approvals.get(id)?.(ok),
    answer: (id: string, a: string) => answers.get(id)?.(a),
    cancel: () => {
      cancelled = true;
    },
    input: (t: string) => inputs.push(t),
  };
}

function harness(opts: { policy?: EgressPolicy; limits?: Partial<BridgeLimits> } = {}) {
  const toServer = new PassThrough();
  const toContainer = new PassThrough();
  const events: TaskEvent[] = [];
  const received: ControlEnvelope[] = [];
  const logs: { level: string; msg: string }[] = [];
  readline.createInterface({ input: toContainer }).on('line', (l) => {
    received.push(ControlEnvelope.parse(JSON.parse(l)));
  });
  const control = fakeControl();
  const bridge = new SandboxBridge({
    token: 'tok',
    control: control.src,
    onEvent: (e) => events.push(e),
    policy: opts.policy ?? allowAll,
    modelName: 'mock',
    limits: opts.limits,
    log: (level, msg) => logs.push({ level, msg }),
  });
  const transport: BridgeTransport = {
    write: (l) => {
      toContainer.write(l + '\n');
    },
    onLine: (cb) => readline.createInterface({ input: toServer }).on('line', cb),
    onClose: (cb) => toServer.on('close', cb),
  };
  bridge.attach(transport);
  const send = (env: RuntimeEnvelope) => toServer.write(JSON.stringify(env) + '\n');
  const hello = (token = 'tok') => send({ kind: 'hello', taskId: 't1', token });
  const waitFor = async <T extends ControlEnvelope>(
    pred: (m: ControlEnvelope) => m is T,
    ms = 3000,
  ): Promise<T> => {
    const t0 = Date.now();
    for (;;) {
      const hit = received.find(pred);
      if (hit) return hit;
      if (Date.now() - t0 > ms) throw new Error(`等待帧超时；已收到 ${JSON.stringify(received.map((r) => r.kind))}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  const of = <K extends ControlEnvelope['kind']>(kind: K) =>
    (m: ControlEnvelope): m is Extract<ControlEnvelope, { kind: K }> => m.kind === kind;
  return { bridge, control, events, received, logs, send, hello, waitFor, of, destroy: () => bridge.dispose() };
}

const approvalEvent = (id: string): TaskEvent =>
  ({ v: 1, type: 'approval.requested', approvalId: id, kind: 'bash_command', title: 'rm', detail: 'rm -rf x' }) as TaskEvent;

describe('沙箱桥接：控制回路', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => cleanups.splice(0).forEach((f) => f()));

  it('★ 容器请求审批 → 用户批准 → 结果下发回容器', async () => {
    const h = harness();
    cleanups.push(h.destroy);
    h.hello();
    await h.waitFor(h.of('hello.ok'));
    h.send({ kind: 'event', event: approvalEvent('a1') });
    await new Promise((r) => setTimeout(r, 30));
    h.control.approve('a1', true);
    const m = await h.waitFor(h.of('approval.resolved'));
    expect(m.approvalId).toBe('a1');
    expect(m.decision).toBe('approved');
    expect(h.events.some((e) => e.type === 'approval.requested')).toBe(true);
  });

  it('★ 容器提问 → 用户回答 → 答案下发回容器', async () => {
    const h = harness();
    cleanups.push(h.destroy);
    h.hello();
    await h.waitFor(h.of('hello.ok'));
    h.send({
      kind: 'event',
      event: { v: 1, type: 'question.asked', questionId: 'q1', question: '哪个季度？', options: ['Q1', 'Q2'] } as TaskEvent,
    });
    await new Promise((r) => setTimeout(r, 30));
    h.control.answer('q1', 'Q2');
    const m = await h.waitFor(h.of('question.answered'));
    expect(m.answer).toBe('Q2');
  });

  it('追加指令与取消经下行泵送达容器', async () => {
    const h = harness();
    cleanups.push(h.destroy);
    h.hello();
    await h.waitFor(h.of('hello.ok'));
    h.control.input('顺便加个图');
    const inp = await h.waitFor(h.of('user.input'));
    expect(inp.text).toBe('顺便加个图');
    h.control.cancel();
    await h.waitFor(h.of('cancel'));
  });

  it('★ 令牌不匹配：不握手，后续帧一律忽略', async () => {
    const h = harness();
    cleanups.push(h.destroy);
    h.hello('wrong');
    h.send({ kind: 'event', event: approvalEvent('a9') });
    h.send({ kind: 'fetch.request', id: 'f9', url: 'http://127.0.0.1:1/', method: 'GET', headers: {} });
    await new Promise((r) => setTimeout(r, 80));
    expect(h.received).toEqual([]);
    expect(h.events).toEqual([]);
  });

  it('完成事件决定最终状态与摘要；usage 随事件更新', async () => {
    const h = harness();
    cleanups.push(h.destroy);
    h.hello();
    await h.waitFor(h.of('hello.ok'));
    h.send({ kind: 'event', event: { v: 1, type: 'usage.updated', usage: { inTokens: 10, outTokens: 5, model: 'm' } } as TaskEvent });
    h.send({ kind: 'event', event: { v: 1, type: 'task.completed', summary: '做完了' } as TaskEvent });
    await new Promise((r) => setTimeout(r, 30));
    expect(h.bridge.result()).toEqual({ status: 'completed', summary: '做完了', usage: { inTokens: 10, outTokens: 5, model: 'm' } });
  });
});

describe('沙箱桥接：出网中继（容器无网，server 代为访问）', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => cleanups.splice(0).forEach((f) => f()));

  async function origin(handler: http.RequestListener) {
    const srv = http.createServer(handler);
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    cleanups.push(() => srv.close());
    return `http://127.0.0.1:${(srv.address() as net.AddressInfo).port}`;
  }

  it('★ 放行的请求由 server 访问，密钥在 server 侧注入，容器侧 Authorization 被丢弃', async () => {
    let seen: http.IncomingHttpHeaders = {};
    let body = '';
    const base = await origin((req, res) => {
      seen = req.headers;
      req.on('data', (c) => (body += c));
      req.on('end', () => res.end('{"ok":true}'));
    });
    const h = harness({
      policy: { fetch: () => ({ ok: true, headers: { authorization: 'Bearer server-key' } }), tcp: () => ({ ok: true }) },
    });
    cleanups.push(h.destroy);
    h.hello();
    await h.waitFor(h.of('hello.ok'));
    h.send({
      kind: 'fetch.request',
      id: 'f1',
      url: `${base}/v1/chat/completions`,
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer forged-by-container', host: 'evil' },
      bodyB64: Buffer.from('{"model":"x"}').toString('base64'),
    });
    const head = await h.waitFor(h.of('fetch.head'));
    expect(head.status).toBe(200);
    await h.waitFor(h.of('fetch.end'));
    expect(seen.authorization).toBe('Bearer server-key');
    expect(seen.host).not.toBe('evil');
    expect(body).toBe('{"model":"x"}');
    const chunks = h.received.filter((m) => m.kind === 'fetch.chunk') as Extract<ControlEnvelope, { kind: 'fetch.chunk' }>[];
    expect(Buffer.concat(chunks.map((c) => Buffer.from(c.dataB64, 'base64'))).toString()).toBe('{"ok":true}');
  });

  it('★ 策略拒绝的请求：回 fetch.error，且 server 不发起任何连接', async () => {
    let hits = 0;
    const base = await origin((_req, res) => {
      hits++;
      res.end('x');
    });
    const h = harness({ policy: denyAll });
    cleanups.push(h.destroy);
    h.hello();
    await h.waitFor(h.of('hello.ok'));
    h.send({ kind: 'fetch.request', id: 'f2', url: `${base}/secret`, method: 'GET', headers: {} });
    const err = await h.waitFor(h.of('fetch.error'));
    expect(err.message).toContain('出网被拒');
    expect(hits).toBe(0);
    expect(h.logs.some((l) => l.level === 'warn' && l.msg.includes('出网被拒'))).toBe(true);
  });

  it('响应体超过上限即中止并报错，不会无限转发', async () => {
    const base = await origin((_req, res) => res.end(Buffer.alloc(5000, 'a')));
    const h = harness({ limits: { maxBodyBytes: 1000 } });
    cleanups.push(h.destroy);
    h.hello();
    await h.waitFor(h.of('hello.ok'));
    h.send({ kind: 'fetch.request', id: 'f3', url: `${base}/big`, method: 'GET', headers: {} });
    const err = await h.waitFor(h.of('fetch.error'));
    expect(err.message).toContain('上限');
    expect(h.received.some((m) => m.kind === 'fetch.end')).toBe(false);
  });

  it('★ 不跟随重定向（跟随后落到白名单外就是 SSRF）', async () => {
    const base = await origin((_req, res) => {
      res.writeHead(302, { location: 'http://10.0.0.5/internal' });
      res.end();
    });
    const h = harness();
    cleanups.push(h.destroy);
    h.hello();
    await h.waitFor(h.of('hello.ok'));
    h.send({ kind: 'fetch.request', id: 'f4', url: `${base}/r`, method: 'GET', headers: {} });
    const head = await h.waitFor(h.of('fetch.head'));
    expect(head.status).toBe(302);
    expect(head.headers.location).toBe('http://10.0.0.5/internal');
  });

  it('TCP 隧道：放行后字节双向往返，对端关闭则下发 tcp.close', async () => {
    const echo = net.createServer((s) => s.on('data', (d) => s.end(Buffer.from(`echo:${d}`))));
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()));
    cleanups.push(() => echo.close());
    const port = (echo.address() as net.AddressInfo).port;
    const h = harness();
    cleanups.push(h.destroy);
    h.hello();
    await h.waitFor(h.of('hello.ok'));
    h.send({ kind: 'tcp.open', id: 't1', host: '127.0.0.1', port });
    await h.waitFor(h.of('tcp.opened'));
    h.send({ kind: 'tcp.data', id: 't1', dataB64: Buffer.from('hi').toString('base64') });
    const data = await h.waitFor(h.of('tcp.data'));
    expect(Buffer.from(data.dataB64, 'base64').toString()).toBe('echo:hi');
    await h.waitFor(h.of('tcp.close'));
  });

  it('★ TCP 隧道被策略拒绝：回 tcp.error，不建立连接', async () => {
    let hits = 0;
    const srv = net.createServer(() => hits++);
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    cleanups.push(() => srv.close());
    const h = harness({ policy: denyAll });
    cleanups.push(h.destroy);
    h.hello();
    await h.waitFor(h.of('hello.ok'));
    h.send({ kind: 'tcp.open', id: 't2', host: '127.0.0.1', port: (srv.address() as net.AddressInfo).port });
    const err = await h.waitFor(h.of('tcp.error'));
    expect(err.message).toContain('出网被拒');
    await new Promise((r) => setTimeout(r, 50));
    expect(hits).toBe(0);
  });
});
