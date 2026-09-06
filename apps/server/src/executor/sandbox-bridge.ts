import net from 'node:net';
import { RuntimeEnvelope, type ControlEnvelope, type TaskEvent } from '@apolla/protocol';
import type { ControlSource } from '@apolla/runtime';
import type { EgressPolicy } from './egress-policy.js';

/** 与容器的字节通道：每行一个 JSON 帧。Docker 用 attach 的 stdio，测试用内存管道。 */
export interface BridgeTransport {
  write(line: string): void;
  onLine(cb: (line: string) => void): void;
  onClose(cb: () => void): void;
}

export interface BridgeLimits {
  /** 单次中继响应体上限（字节） */
  maxBodyBytes: number;
  /** 同时进行的中继请求数 */
  maxConcurrentFetch: number;
  /** 同时打开的 TCP 隧道数 */
  maxTunnels: number;
  /** 中继/隧道空闲超时（毫秒）；模型流式输出的间隙远小于此值 */
  idleMs: number;
}

export interface BridgeOptions {
  token: string;
  control: ControlSource;
  onEvent: (e: TaskEvent) => void;
  policy: EgressPolicy;
  modelName: string;
  log?: (level: 'info' | 'warn', msg: string, meta?: Record<string, unknown>) => void;
  limits?: Partial<BridgeLimits>;
}

const DEFAULT_LIMITS: BridgeLimits = {
  maxBodyBytes: 25 * 1024 * 1024,
  maxConcurrentFetch: 8,
  maxTunnels: 16,
  idleMs: 300_000,
};

/** 中继时丢弃的逐跳/由 fetch 自行计算的头 */
const STRIP_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'authorization']);

/**
 * 沙箱桥接（传输无关，T-402）。
 * 上行：事件转发、审批/提问在 server 侧等待用户并把结果下发回容器；
 * 出网：容器彻底无网，fetch.* / tcp.* 帧在这里按 EgressPolicy 判定后由 server 代为访问，
 * 模型密钥在这里注入 —— 容器侧带来的 Authorization 一律丢弃，容器伪造不了身份。
 */
export class SandboxBridge {
  private authed = false;
  private transport?: BridgeTransport;
  private summary = '';
  private status = 'failed';
  private usage: { inTokens: number; outTokens: number; model: string };
  private readonly fetches = new Map<string, AbortController>();
  private readonly tunnels = new Map<string, net.Socket>();
  private pump?: NodeJS.Timeout;
  private readonly limits: BridgeLimits;

  constructor(private readonly opts: BridgeOptions) {
    this.usage = { inTokens: 0, outTokens: 0, model: opts.modelName };
    this.limits = { ...DEFAULT_LIMITS, ...(opts.limits ?? {}) };
  }

  attach(transport: BridgeTransport) {
    this.transport = transport;
    transport.onLine((line) => this.handleLine(line));
    transport.onClose(() => this.dispose());
  }

  result() {
    return { status: this.status, summary: this.summary, usage: this.usage };
  }

  /** 释放：停止下行泵、中止未完成的中继与隧道 */
  dispose() {
    if (this.pump) clearInterval(this.pump);
    this.pump = undefined;
    for (const ac of this.fetches.values()) ac.abort();
    this.fetches.clear();
    for (const s of this.tunnels.values()) s.destroy();
    this.tunnels.clear();
  }

  private send(m: ControlEnvelope) {
    this.transport?.write(JSON.stringify(m));
  }

  private log(level: 'info' | 'warn', msg: string, meta?: Record<string, unknown>) {
    this.opts.log?.(level, msg, meta);
  }

  private handleLine(line: string) {
    if (!line.trim()) return;
    let parsed: ReturnType<typeof RuntimeEnvelope.safeParse>;
    try {
      parsed = RuntimeEnvelope.safeParse(JSON.parse(line));
    } catch {
      return; // 非协议行（容器把别的东西写到了 stdout）直接忽略
    }
    if (!parsed.success) return;
    const msg = parsed.data;

    if (msg.kind === 'hello') {
      if (msg.token !== this.opts.token) {
        this.log('warn', '沙箱握手令牌不匹配，拒绝');
        return;
      }
      this.authed = true;
      this.send({ kind: 'hello.ok' });
      this.startPump();
      return;
    }
    if (!this.authed) return; // 未握手不接受任何帧

    switch (msg.kind) {
      case 'event':
        this.handleEvent(msg.event);
        return;
      case 'fetch.request':
        void this.relayFetch(msg);
        return;
      case 'fetch.abort':
        this.fetches.get(msg.id)?.abort();
        this.fetches.delete(msg.id);
        return;
      case 'tcp.open':
        this.openTunnel(msg.id, msg.host, msg.port);
        return;
      case 'tcp.data':
        this.tunnels.get(msg.id)?.write(Buffer.from(msg.dataB64, 'base64'));
        return;
      case 'tcp.close': {
        const s = this.tunnels.get(msg.id);
        this.tunnels.delete(msg.id);
        s?.end();
        return;
      }
      case 'bye':
        this.dispose();
        return;
      default:
        return;
    }
  }

  /** 取消与追加指令下发（容器内 Agent 会在下一轮 loop 前让出） */
  private startPump() {
    const { control } = this.opts;
    this.pump = setInterval(() => {
      if (control.isCancelled()) {
        this.send({ kind: 'cancel' });
        if (this.pump) clearInterval(this.pump);
        this.pump = undefined;
        return;
      }
      for (const text of control.drainUserInputs()) this.send({ kind: 'user.input', text });
    }, 300);
  }

  private handleEvent(e: TaskEvent) {
    this.opts.onEvent(e);
    if (e.type === 'usage.updated') this.usage = e.usage;
    if (e.type === 'task.completed') {
      this.summary = e.summary;
      this.status = 'completed';
    }
    if (e.type === 'task.failed') {
      this.summary = e.error.message;
      this.status = 'failed';
    }
    if (e.type === 'task.cancelled') this.status = 'cancelled';

    // ★ 容器请求审批/提问：在 server 侧等待用户决定并把结果下发回容器，否则容器永久挂起
    if (e.type === 'approval.requested') {
      void this.opts.control
        .waitApproval(e.approvalId)
        .then((approved) =>
          this.send({
            kind: 'approval.resolved',
            approvalId: e.approvalId,
            decision: approved ? 'approved' : 'denied',
            scope: 'once',
          }),
        )
        .catch(() =>
          this.send({ kind: 'approval.resolved', approvalId: e.approvalId, decision: 'denied', scope: 'once' }),
        );
    }
    if (e.type === 'question.asked') {
      void this.opts.control
        .waitAnswer(e.questionId)
        .then((answer) => this.send({ kind: 'question.answered', questionId: e.questionId, answer }))
        .catch(() => this.send({ kind: 'question.answered', questionId: e.questionId, answer: '（无回答）' }));
    }
  }

  private async relayFetch(m: Extract<RuntimeEnvelope, { kind: 'fetch.request' }>) {
    const { id } = m;
    let url: URL;
    try {
      url = new URL(m.url);
    } catch {
      this.send({ kind: 'fetch.error', id, message: 'URL 非法' });
      return;
    }
    const decision = this.opts.policy.fetch(url);
    if (!decision.ok) {
      this.log('warn', '沙箱出网被拒', { host: url.hostname, reason: decision.reason });
      this.send({ kind: 'fetch.error', id, message: `出网被拒：${decision.reason}` });
      return;
    }
    if (this.fetches.size >= this.limits.maxConcurrentFetch) {
      this.send({ kind: 'fetch.error', id, message: `并发中继请求超过 ${this.limits.maxConcurrentFetch} 上限` });
      return;
    }

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(m.headers)) if (!STRIP_HEADERS.has(k.toLowerCase())) headers[k] = v;
    Object.assign(headers, decision.headers ?? {});

    const ac = new AbortController();
    this.fetches.set(id, ac);
    let idle = setTimeout(() => ac.abort(new Error('中继空闲超时')), this.limits.idleMs);
    const touch = () => {
      clearTimeout(idle);
      idle = setTimeout(() => ac.abort(new Error('中继空闲超时')), this.limits.idleMs);
    };
    const started = Date.now();
    let bytes = 0;
    try {
      const res = await fetch(url, {
        method: m.method,
        headers,
        body: m.bodyB64 ? Buffer.from(m.bodyB64, 'base64') : undefined,
        redirect: 'manual', // 不跟随重定向：跟随后落到白名单外就是 SSRF
        signal: ac.signal,
      });
      const h: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        h[k] = v;
      });
      this.send({ kind: 'fetch.head', id, status: res.status, statusText: res.statusText, headers: h });
      if (res.body) {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          touch();
          bytes += value.byteLength;
          if (bytes > this.limits.maxBodyBytes) {
            ac.abort();
            this.send({ kind: 'fetch.error', id, message: `响应超过 ${this.limits.maxBodyBytes} 字节上限` });
            return;
          }
          this.send({ kind: 'fetch.chunk', id, dataB64: Buffer.from(value).toString('base64') });
        }
      }
      this.send({ kind: 'fetch.end', id });
      this.log('info', '沙箱出网中继', { host: url.hostname, status: res.status, bytes, ms: Date.now() - started });
    } catch (e) {
      if (this.fetches.has(id)) this.send({ kind: 'fetch.error', id, message: (e as Error).message });
    } finally {
      clearTimeout(idle);
      this.fetches.delete(id);
    }
  }

  private openTunnel(id: string, host: string, port: number) {
    const decision = this.opts.policy.tcp(host, port);
    if (!decision.ok) {
      this.log('warn', '沙箱隧道被拒', { host, port, reason: decision.reason });
      this.send({ kind: 'tcp.error', id, message: `出网被拒：${decision.reason}` });
      return;
    }
    if (this.tunnels.size >= this.limits.maxTunnels) {
      this.send({ kind: 'tcp.error', id, message: `并发隧道超过 ${this.limits.maxTunnels} 上限` });
      return;
    }
    const sock = net.connect({ host, port });
    this.tunnels.set(id, sock);
    sock.setTimeout(this.limits.idleMs, () => sock.destroy(new Error('隧道空闲超时')));
    sock.on('connect', () => {
      this.log('info', '沙箱隧道建立', { host, port });
      this.send({ kind: 'tcp.opened', id });
    });
    sock.on('data', (buf: Buffer) => this.send({ kind: 'tcp.data', id, dataB64: buf.toString('base64') }));
    sock.on('error', (e) => {
      if (this.tunnels.delete(id)) this.send({ kind: 'tcp.error', id, message: e.message });
    });
    sock.on('close', () => {
      if (this.tunnels.delete(id)) this.send({ kind: 'tcp.close', id });
    });
  }
}
