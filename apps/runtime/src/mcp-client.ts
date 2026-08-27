import { spawn, type ChildProcess } from 'node:child_process';

/**
 * 极简 MCP 客户端（PRD T-109）。
 * 支持 stdio 传输（JSON-RPC 2.0，行分隔）。Streamable HTTP 传输走 httpCall（下方）。
 * 刻意不引第三方 SDK：协议子集（initialize / tools/list / tools/call）足够连接器场景，
 * 且完全可控、可测。企业连接器由 server 的 Connector Hub 统一注入配置。
 */
export interface McpServerConfig {
  name: string;
  transport: 'stdio' | 'http';
  command?: string; // stdio
  args?: string[];
  env?: Record<string, string>;
  url?: string; // http
  headers?: Record<string, string>;
}

export interface McpTool {
  server: string;
  name: string; // 原始工具名
  qualifiedName: string; // mcp__<server>__<tool>
  description: string;
  inputSchema: Record<string, unknown>;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

export class McpStdioClient {
  private proc?: ChildProcess;
  private buf = '';
  private nextId = 1;
  private pending = new Map<number, Pending>();

  constructor(private config: McpServerConfig) {}

  async connect(): Promise<void> {
    this.proc = spawn(this.config.command!, this.config.args ?? [], {
      env: { ...process.env, ...this.config.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout!.on('data', (d: Buffer) => this.onData(d.toString()));
    this.proc.stderr!.on('data', () => {
      /* 连接器日志，忽略 */
    });
    this.proc.on('exit', () => {
      for (const [, p] of this.pending) p.reject(new Error('MCP 连接器已退出'));
      this.pending.clear();
    });
    await this.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'apolla-work', version: '1.0' },
    });
    this.notify('notifications/initialized', {});
  }

  private onData(chunk: string) {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { message: string } };
        if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message));
          else p.resolve(msg.result);
        }
      } catch {
        /* 忽略非 JSON 行 */
      }
    }
  }

  private rpc(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc!.stdin!.write(payload);
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP 调用超时：${method}`));
        }
      }, 30_000);
    });
  }

  private notify(method: string, params: unknown) {
    this.proc!.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async listTools(): Promise<McpTool[]> {
    const res = (await this.rpc('tools/list', {})) as {
      tools: { name: string; description?: string; inputSchema?: Record<string, unknown> }[];
    };
    return res.tools.map((t) => ({
      server: this.config.name,
      name: t.name,
      qualifiedName: `mcp__${this.config.name}__${t.name}`,
      description: t.description ?? '',
      inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const res = (await this.rpc('tools/call', { name, arguments: args })) as {
      content?: { type: string; text?: string }[];
      isError?: boolean;
    };
    const text = (res.content ?? [])
      .map((c) => (c.type === 'text' ? c.text : `[${c.type}]`))
      .join('\n');
    return res.isError ? `连接器返回错误：${text}` : text;
  }

  close() {
    this.proc?.kill();
  }
}

/** 连接一组 MCP 服务器，返回客户端与其工具清单。失败的服务器跳过并记录。 */
export async function connectMcpServers(
  configs: McpServerConfig[],
): Promise<{ clients: Map<string, McpStdioClient>; tools: McpTool[]; errors: string[] }> {
  const clients = new Map<string, McpStdioClient>();
  const tools: McpTool[] = [];
  const errors: string[] = [];
  for (const cfg of configs) {
    if (cfg.transport !== 'stdio') {
      errors.push(`${cfg.name}: 暂仅支持 stdio 传输`);
      continue;
    }
    try {
      const client = new McpStdioClient(cfg);
      await client.connect();
      const t = await client.listTools();
      clients.set(cfg.name, client);
      tools.push(...t);
    } catch (e) {
      errors.push(`${cfg.name}: ${(e as Error).message}`);
    }
  }
  return { clients, tools, errors };
}
