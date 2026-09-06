import { afterEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import type { ControlEnvelope, RuntimeEnvelope } from '@apolla/protocol';
import { createBridgeFetch, parseProxyTarget, startLoopbackProxy, type BridgeChannel } from './bridge-fetch.js';

/** 内存通道：记录上行帧，允许测试注入下行帧 */
function channel() {
  const sent: RuntimeEnvelope[] = [];
  const listeners = new Set<(m: ControlEnvelope) => void>();
  const ch: BridgeChannel = {
    send: (e) => sent.push(e),
    onControl: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  const push = (m: ControlEnvelope) => {
    for (const l of listeners) l(m);
  };
  const last = <K extends RuntimeEnvelope['kind']>(kind: K) =>
    [...sent].reverse().find((s) => s.kind === kind) as Extract<RuntimeEnvelope, { kind: K }> | undefined;
  const waitSent = async <K extends RuntimeEnvelope['kind']>(kind: K, ms = 2000) => {
    const t0 = Date.now();
    for (;;) {
      const hit = last(kind);
      if (hit) return hit;
      if (Date.now() - t0 > ms) throw new Error(`未收到上行帧 ${kind}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  return { ch, sent, push, last, waitSent };
}

const b64 = (s: string) => Buffer.from(s).toString('base64');

describe('createBridgeFetch：容器无网时经 server 中继', () => {
  it('★ 请求整体上送：方法、URL、头、body', async () => {
    const c = channel();
    const f = createBridgeFetch(c.ch);
    const p = f('http://gw:4000/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"model":"x"}',
    });
    const req = await c.waitSent('fetch.request');
    expect(req.method).toBe('POST');
    expect(req.url).toBe('http://gw:4000/v1/chat/completions');
    expect(req.headers['content-type']).toBe('application/json');
    expect(Buffer.from(req.bodyB64!, 'base64').toString()).toBe('{"model":"x"}');
    c.push({ kind: 'fetch.head', id: req.id, status: 200, statusText: 'OK', headers: { 'content-type': 'text/plain' } });
    c.push({ kind: 'fetch.end', id: req.id });
    const res = await p;
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain');
  });

  it('★ 响应按块流回并可拼接（模型流式输出走的就是这条路）', async () => {
    const c = channel();
    const f = createBridgeFetch(c.ch);
    const p = f('http://gw/stream');
    const req = await c.waitSent('fetch.request');
    c.push({ kind: 'fetch.head', id: req.id, status: 200, statusText: 'OK', headers: {} });
    const res = await p;
    c.push({ kind: 'fetch.chunk', id: req.id, dataB64: b64('data: a\n\n') });
    c.push({ kind: 'fetch.chunk', id: req.id, dataB64: b64('data: b\n\n') });
    c.push({ kind: 'fetch.end', id: req.id });
    expect(await res.text()).toBe('data: a\n\ndata: b\n\n');
  });

  it('204 等无体状态：body 为 null', async () => {
    const c = channel();
    const f = createBridgeFetch(c.ch);
    const p = f('http://gw/x', { method: 'DELETE' });
    const req = await c.waitSent('fetch.request');
    c.push({ kind: 'fetch.head', id: req.id, status: 204, statusText: 'No Content', headers: {} });
    const res = await p;
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
  });

  it('★ server 拒绝（响应头之前出错）→ fetch 直接 reject，错误信息可见', async () => {
    const c = channel();
    const f = createBridgeFetch(c.ch);
    const p = f('http://10.0.0.5/');
    const req = await c.waitSent('fetch.request');
    c.push({ kind: 'fetch.error', id: req.id, message: '出网被拒：10.0.0.5 不在出网白名单' });
    await expect(p).rejects.toThrow('不在出网白名单');
  });

  it('响应头之后出错 → 读取 body 时报错', async () => {
    const c = channel();
    const f = createBridgeFetch(c.ch);
    const p = f('http://gw/x');
    const req = await c.waitSent('fetch.request');
    c.push({ kind: 'fetch.head', id: req.id, status: 200, statusText: 'OK', headers: {} });
    const res = await p;
    c.push({ kind: 'fetch.error', id: req.id, message: '中继空闲超时' });
    await expect(res.text()).rejects.toThrow('中继空闲超时');
  });

  it('调用方 abort → 上送 fetch.abort 并以 AbortError 结束', async () => {
    const c = channel();
    const f = createBridgeFetch(c.ch);
    const ac = new AbortController();
    const p = f('http://gw/slow', { signal: ac.signal });
    await c.waitSent('fetch.request');
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(c.last('fetch.abort')).toBeTruthy();
  });
});

describe('parseProxyTarget', () => {
  it('CONNECT host:port', () => {
    expect(parseProxyTarget('CONNECT api.corp.com:443 HTTP/1.1')).toEqual({ host: 'api.corp.com', port: 443, connect: true });
    expect(parseProxyTarget('CONNECT [::1]:8443 HTTP/1.1')).toEqual({ host: '::1', port: 8443, connect: true });
  });
  it('绝对 URI：http 默认 80、https 默认 443、显式端口', () => {
    expect(parseProxyTarget('GET http://intra.corp/x HTTP/1.1')).toEqual({ host: 'intra.corp', port: 80, connect: false });
    expect(parseProxyTarget('GET https://intra.corp/x HTTP/1.1')).toEqual({ host: 'intra.corp', port: 443, connect: false });
    expect(parseProxyTarget('POST http://intra.corp:8080/api HTTP/1.1')).toEqual({ host: 'intra.corp', port: 8080, connect: false });
  });
  it('相对路径 / 非法目标 → undefined', () => {
    expect(parseProxyTarget('GET /x HTTP/1.1')).toBeUndefined();
    expect(parseProxyTarget('GET ftp://a/b HTTP/1.1')).toBeUndefined();
    expect(parseProxyTarget('CONNECT nonsense HTTP/1.1')).toBeUndefined();
  });
});

describe('回环代理：Bash/python/MCP 的出网走同一条中继', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => cleanups.splice(0).forEach((f) => f()));

  async function proxy() {
    const c = channel();
    const srv = await startLoopbackProxy(c.ch, 0);
    cleanups.push(() => srv.close());
    const port = (srv.address() as net.AddressInfo).port;
    const connect = () =>
      new Promise<net.Socket>((r) => {
        const s = net.connect(port, '127.0.0.1', () => r(s));
      });
    return { c, connect };
  }
  const readOnce = (s: net.Socket) => new Promise<string>((r) => s.once('data', (d) => r(d.toString())));

  it('★ CONNECT：上送 tcp.open，server 放行后回 200 并转发后续字节', async () => {
    const { c, connect } = await proxy();
    const s = await connect();
    cleanups.push(() => s.destroy());
    s.write('CONNECT api.corp.com:443 HTTP/1.1\r\nHost: api.corp.com:443\r\n\r\n');
    const open = await c.waitSent('tcp.open');
    expect(open).toMatchObject({ host: 'api.corp.com', port: 443 });
    const established = readOnce(s);
    c.push({ kind: 'tcp.opened', id: open.id });
    expect(await established).toContain('200 Connection Established');
    s.write(Buffer.from('tls-bytes'));
    const data = await c.waitSent('tcp.data');
    expect(Buffer.from(data.dataB64, 'base64').toString()).toBe('tls-bytes');
    // 对端回包 → 原样写回客户端
    const back = readOnce(s);
    c.push({ kind: 'tcp.data', id: open.id, dataB64: b64('pong') });
    expect(await back).toBe('pong');
  });

  it('★ 明文 http 绝对 URI：按目标 host:port 开隧道，整段请求在隧道建立后原样转发', async () => {
    const { c, connect } = await proxy();
    const s = await connect();
    cleanups.push(() => s.destroy());
    const raw = 'GET http://intra.corp:8080/api/x HTTP/1.1\r\nHost: intra.corp:8080\r\n\r\n';
    s.write(raw);
    const open = await c.waitSent('tcp.open');
    expect(open).toMatchObject({ host: 'intra.corp', port: 8080 });
    expect(c.last('tcp.data')).toBeUndefined(); // 未建立前不发数据
    c.push({ kind: 'tcp.opened', id: open.id });
    const data = await c.waitSent('tcp.data');
    expect(Buffer.from(data.dataB64, 'base64').toString()).toBe(raw);
  });

  it('★ server 拒绝：客户端收到 502 与原因，连接关闭', async () => {
    const { c, connect } = await proxy();
    const s = await connect();
    s.write('CONNECT 10.0.0.5:5432 HTTP/1.1\r\n\r\n');
    const open = await c.waitSent('tcp.open');
    const resp = readOnce(s);
    c.push({ kind: 'tcp.error', id: open.id, message: '出网被拒：10.0.0.5:5432 不在出网白名单' });
    const text = await resp;
    expect(text).toContain('502');
    expect(text).toContain('不在出网白名单');
  });

  it('非代理格式请求 → 400', async () => {
    const { connect } = await proxy();
    const s = await connect();
    s.write('GET /relative HTTP/1.1\r\nHost: x\r\n\r\n');
    expect(await readOnce(s)).toContain('400');
  });
});
