import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** 路由处理器拿到的上下文 */
export interface RouteContext {
  /** 已解析的 JSON body；body 不是 JSON（如企微的 XML）时为 undefined */
  body: unknown;
  /** 原始 body 文本。**验签必须用它**，不能用 re-stringify 的结果（字节序会变） */
  raw: string;
  /** URL 查询参数（企微 GET 校验、msg_signature 都在这里） */
  query: URLSearchParams;
  req: IncomingMessage;
  res: ServerResponse;
}

/** 返回值会被序列化为 JSON 响应（返回 undefined 时回 {ok:true}）；handler 自行 end 则不再写。 */
export type RouteHandler = (ctx: RouteContext) => Promise<unknown> | unknown;

/** 回调 body 上限：IM 回调都是小 JSON/XML，防止恶意大包 */
const MAX_BODY_BYTES = 1024 * 1024;

/** body 超限的哨兵错误，用于回 413 而不是 500 */
class BodyTooLargeError extends Error {}

/** 纯文本应答（企微 URL 校验要回明文 echostr，验签失败要回 401） */
export function replyText(res: ServerResponse, status: number, text: string): void {
  res.statusCode = status;
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.end(text);
}

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
      const url = new URL(req.url ?? '/', 'http://localhost');
      const handler = this.routes.get(`${req.method ?? 'GET'} ${url.pathname}`);
      if (!handler) return sendJson(404, { error: 'not found' });
      const raw = await readBody(req);
      // body 允许不是 JSON（企微回调是 XML），解析失败就交给 handler 自己处理 raw
      let body: unknown;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = undefined;
      }
      const result = await handler({ body, raw, query: url.searchParams, req, res });
      if (!res.writableEnded) sendJson(200, result ?? { ok: true });
    } catch (e) {
      if (e instanceof BodyTooLargeError) {
        if (!res.writableEnded) sendJson(413, { error: 'body 超过 1MB' });
        return;
      }
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
        reject(new BodyTooLargeError('body 超过 1MB'));
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
