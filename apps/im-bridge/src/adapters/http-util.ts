import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** 路由处理器：返回值会被序列化为 JSON 响应（返回 undefined 时回 {ok:true}）。 */
export type RouteHandler = (
  body: unknown,
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<unknown> | unknown;

/** 回调 body 上限：IM 回调都是小 JSON，防止恶意大包 */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * 多适配器共享的极简 HTTP 服务器（不引 express，node:http 足够）。
 * 企微/钉钉/飞书三个回调默认挂在同一端口（3210）的不同路径上，按「METHOD /path」分发；
 * 引用计数管理生命周期：最后一个适配器 stop 时才真正关闭监听。
 */
export class SharedHttpServer {
  private server?: http.Server;
  private routes = new Map<string, RouteHandler>();
  private refs = 0;

  constructor(readonly port: number) {}

  route(method: string, pathname: string, handler: RouteHandler): void {
    this.routes.set(`${method.toUpperCase()} ${pathname}`, handler);
  }

  /** 引用计数 +1；首个使用者触发真正监听 */
  async acquire(): Promise<void> {
    this.refs += 1;
    if (this.server) return;
    const server = http.createServer((req, res) => void this.dispatch(req, res));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    console.log(`[im-bridge] 回调 HTTP 服务器已监听 :${this.port}`);
  }

  /** 引用计数 -1；归零时关闭监听并从注册表移除 */
  async release(): Promise<void> {
    this.refs = Math.max(0, this.refs - 1);
    if (this.refs > 0 || !this.server) return;
    const server = this.server;
    this.server = undefined;
    servers.delete(this.port);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sendJson = (status: number, obj: unknown) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(obj));
    };
    try {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      const handler = this.routes.get(`${req.method ?? 'GET'} ${pathname}`);
      if (!handler) return sendJson(404, { error: 'not found' });
      const raw = await readBody(req);
      let body: unknown;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        return sendJson(400, { error: 'body 不是合法 JSON' });
      }
      const result = await handler(body, req, res);
      if (!res.writableEnded) sendJson(200, result ?? { ok: true });
    } catch (e) {
      console.error('[im-bridge] 回调处理异常：', e);
      if (!res.writableEnded) sendJson(500, { error: 'internal error' });
    }
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body 超过 1MB'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 端口 → 服务器实例注册表：同端口的适配器共享同一实例 */
const servers = new Map<number, SharedHttpServer>();

export function sharedServer(port: number): SharedHttpServer {
  let s = servers.get(port);
  if (!s) {
    s = new SharedHttpServer(port);
    servers.set(port, s);
  }
  return s;
}
