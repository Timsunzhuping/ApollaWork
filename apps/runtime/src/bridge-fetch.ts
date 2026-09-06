import net from 'node:net';
import { randomUUID } from 'node:crypto';
import type { RuntimeEnvelope, ControlEnvelope } from '@apolla/protocol';

/**
 * 沙箱 ↔ server 的桥接通道：上行发送 + 下行订阅。
 * 容器模式由 stdio 实现（sandbox-main），测试用内存管道实现。
 */
export interface BridgeChannel {
  send(env: RuntimeEnvelope): void;
  onControl(cb: (msg: ControlEnvelope) => void): () => void;
}

/** 这些状态码按规范不能带响应体，Response 构造时必须传 null */
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

/**
 * 经桥接中继的 fetch（T-402）。
 * 沙箱容器 NetworkMode=none 彻底无网：请求整体上送 server，由 server 校验出网白名单、
 * 注入模型密钥并代为访问，响应按块流回。给 openai SDK 与 WebFetch/WebSearch 使用。
 * 容器里因此不再需要、也拿不到模型 API Key。
 */
export function createBridgeFetch(ch: BridgeChannel): typeof fetch {
  interface Pending {
    resolve: (r: Response) => void;
    reject: (e: Error) => void;
    controller?: ReadableStreamDefaultController<Uint8Array>;
    headDone: boolean;
  }
  const pending = new Map<string, Pending>();

  ch.onControl((msg) => {
    if (!msg.kind.startsWith('fetch.')) return;
    const id = (msg as { id: string }).id;
    const p = pending.get(id);
    if (!p) return;
    switch (msg.kind) {
      case 'fetch.head': {
        p.headDone = true;
        const headers = new Headers(msg.headers);
        if (NULL_BODY_STATUS.has(msg.status)) {
          pending.delete(id);
          p.resolve(new Response(null, { status: msg.status, statusText: msg.statusText, headers }));
          return;
        }
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            p.controller = c;
          },
          cancel() {
            pending.delete(id);
            ch.send({ kind: 'fetch.abort', id });
          },
        });
        p.resolve(new Response(body, { status: msg.status, statusText: msg.statusText, headers }));
        break;
      }
      case 'fetch.chunk':
        p.controller?.enqueue(new Uint8Array(Buffer.from(msg.dataB64, 'base64')));
        break;
      case 'fetch.end':
        pending.delete(id);
        try {
          p.controller?.close();
        } catch {
          /* 流已关闭 */
        }
        break;
      case 'fetch.error': {
        pending.delete(id);
        const err = new Error(msg.message);
        if (p.headDone) {
          try {
            p.controller?.error(err);
          } catch {
            /* 流已关闭 */
          }
        } else p.reject(err);
        break;
      }
      default:
        break;
    }
  });

  const bridgeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const id = randomUUID();
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      headers[k] = v;
    });
    let bodyB64: string | undefined;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const buf = Buffer.from(await req.arrayBuffer());
      if (buf.length) bodyB64 = buf.toString('base64');
    }
    return new Promise<Response>((resolve, reject) => {
      const p: Pending = { resolve, reject, headDone: false };
      pending.set(id, p);
      const onAbort = () => {
        if (!pending.has(id)) return;
        pending.delete(id);
        ch.send({ kind: 'fetch.abort', id });
        const err = new DOMException('The operation was aborted.', 'AbortError');
        if (p.headDone) {
          try {
            p.controller?.error(err);
          } catch {
            /* 流已关闭 */
          }
        } else reject(err);
      };
      if (req.signal.aborted) {
        onAbort();
        return;
      }
      req.signal.addEventListener('abort', onAbort, { once: true });
      ch.send({ kind: 'fetch.request', id, url: req.url, method: req.method, headers, bodyB64 });
    });
  };
  return bridgeFetch as typeof fetch;
}

/** 解析代理收到的首行：CONNECT host:port 或 METHOD 绝对URI */
export function parseProxyTarget(
  requestLine: string,
): { host: string; port: number; connect: boolean } | undefined {
  const [method, target] = requestLine.split(' ');
  if (!target) return undefined;
  if (method === 'CONNECT') {
    const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(target);
    if (!m) return undefined;
    return { host: m[1]!.replace(/^\[|\]$/g, ''), port: Number(m[2]), connect: true };
  }
  try {
    const u = new URL(target);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
    return { host: u.hostname.replace(/^\[|\]$/g, ''), port, connect: false };
  } catch {
    return undefined;
  }
}

/**
 * 容器内回环 HTTP 代理（T-402）。容器无网，但 Bash 里的 curl / python-requests、
 * MCP 连接器等仍需访问白名单内网服务：设 HTTP_PROXY=http://127.0.0.1:port 后，
 * 它们的 CONNECT 隧道（https）与绝对 URI 明文请求（http）都经 tcp.* 帧上送 server，
 * 由 server 按 host:port 白名单决定是否放行 —— 与 WebFetch 走同一条策略。
 */
export function startLoopbackProxy(ch: BridgeChannel, port = 3128): Promise<net.Server> {
  interface Tunnel {
    sock: net.Socket;
    established: boolean;
    connect: boolean;
    pending: Buffer[];
  }
  const tunnels = new Map<string, Tunnel>();

  ch.onControl((msg) => {
    if (!msg.kind.startsWith('tcp.')) return;
    const id = (msg as { id: string }).id;
    const t = tunnels.get(id);
    if (!t) return;
    switch (msg.kind) {
      case 'tcp.opened':
        t.established = true;
        if (t.connect) t.sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        for (const b of t.pending) ch.send({ kind: 'tcp.data', id, dataB64: b.toString('base64') });
        t.pending = [];
        break;
      case 'tcp.data':
        t.sock.write(Buffer.from(msg.dataB64, 'base64'));
        break;
      case 'tcp.close':
        tunnels.delete(id);
        t.sock.end();
        break;
      case 'tcp.error':
        tunnels.delete(id);
        if (!t.established) {
          t.sock.end(
            `HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\n${msg.message}\n`,
          );
        } else t.sock.destroy();
        break;
      default:
        break;
    }
  });

  const server = net.createServer((sock) => {
    const id = randomUUID();
    let head = Buffer.alloc(0);
    let tunnel: Tunnel | undefined;

    sock.on('data', (chunk: Buffer) => {
      if (tunnel) {
        if (tunnel.established) ch.send({ kind: 'tcp.data', id, dataB64: chunk.toString('base64') });
        else tunnel.pending.push(chunk);
        return;
      }
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) {
        if (head.length > 64 * 1024) sock.destroy();
        return;
      }
      const target = parseProxyTarget(head.subarray(0, head.indexOf('\r\n')).toString());
      if (!target) {
        sock.end(
          'HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\n代理只接受 CONNECT 或绝对 URI 请求\n',
        );
        return;
      }
      tunnel = { sock, established: false, connect: target.connect, pending: [] };
      // 明文 http：整段请求原样转给目标（绝对 URI 形式对源服务器合法，RFC 7230 §5.3.2）；
      // CONNECT：头部之后若已带 TLS 字节（管道化），先暂存待隧道建立后再送。
      if (!target.connect) tunnel.pending.push(head);
      else if (head.length > end + 4) tunnel.pending.push(head.subarray(end + 4));
      tunnels.set(id, tunnel);
      ch.send({ kind: 'tcp.open', id, host: target.host, port: target.port });
    });
    sock.on('close', () => {
      if (tunnels.delete(id)) ch.send({ kind: 'tcp.close', id });
    });
    sock.on('error', () => {
      /* 交给 close 处理 */
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
