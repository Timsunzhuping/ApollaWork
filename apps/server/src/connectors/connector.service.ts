import { Inject, Injectable } from '@nestjs/common';
import path from 'node:path';
import type { McpServerConfig } from '@apolla/runtime';
import { PrismaService } from '../prisma.service.js';
import { CONFIG, type AppConfig } from '../config.js';
import { encryptSecret, decryptSecret } from '../common/crypto.js';

/**
 * Connector Hub（PRD T-207）：企业 MCP 连接器的注册、授权与注入。
 * 配置（含凭据 env）信封加密存库；执行任务时组装成 runtime 的 mcpServers。
 * 内置「资料库」连接器（kb_mcp.py）在工作区有知识库时自动挂载。
 */
export interface ConnectorConfig {
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

@Injectable()
export class ConnectorService {
  constructor(
    private prisma: PrismaService,
    @Inject(CONFIG) private config: AppConfig,
  ) {}

  async list(orgId: string) {
    const rows = await this.prisma.connector.findMany({ where: { orgId } });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      enabled: r.enabled,
      scopes: JSON.parse(r.scopes) as string[],
      config: this.redact(JSON.parse(decryptSecret(r.configEnc)) as ConnectorConfig),
    }));
  }

  async upsert(input: {
    id?: string;
    orgId: string;
    name: string;
    config: ConnectorConfig;
    enabled?: boolean;
  }) {
    const configEnc = encryptSecret(JSON.stringify(input.config));
    const kind = input.config.transport;
    if (input.id) {
      return this.prisma.connector.update({
        where: { id: input.id },
        data: { name: input.name, kind, configEnc, enabled: input.enabled ?? true },
      });
    }
    return this.prisma.connector.create({
      data: {
        orgId: input.orgId,
        name: input.name,
        kind,
        configEnc,
        scopes: '[]',
        enabled: input.enabled ?? true,
      },
    });
  }

  async remove(id: string) {
    await this.prisma.connector.delete({ where: { id } });
  }

  /** 连通性测试：stdio 起进程列 tools；http 探测。返回工具名或错误。 */
  async test(id: string): Promise<{ ok: boolean; tools?: string[]; error?: string }> {
    const row = await this.prisma.connector.findUnique({ where: { id } });
    if (!row) return { ok: false, error: 'not found' };
    const cfg = JSON.parse(decryptSecret(row.configEnc)) as ConnectorConfig;
    try {
      const { connectMcpServers } = await import('@apolla/runtime');
      const { clients, tools, errors } = await connectMcpServers([
        { name: row.name, transport: cfg.transport, command: cfg.command, args: cfg.args, env: cfg.env, url: cfg.url },
      ]);
      for (const c of clients.values()) c.close();
      if (errors.length) return { ok: false, error: errors.join('; ') };
      return { ok: true, tools: tools.map((t) => t.name) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /** 组装某工作区可用的 MCP 连接器（内置 KB + 已启用的企业连接器）。 */
  async mcpServersFor(orgId: string, workspaceId: string): Promise<McpServerConfig[]> {
    const servers: McpServerConfig[] = [];

    // 内置资料库连接器：该工作区有知识库时挂载
    const kbDb = path.join(this.config.storageDir, 'kb', `${workspaceId}.db`);
    const fs = await import('node:fs');
    if (fs.existsSync(kbDb)) {
      const kbScript = path.resolve(this.config.skillRoots[0], '../apps/knowledge/kb_mcp.py');
      const kbScriptAlt = path.resolve(process.cwd(), '../knowledge/kb_mcp.py');
      const script = fs.existsSync(kbScript) ? kbScript : kbScriptAlt;
      servers.push({
        name: 'kb',
        transport: 'stdio',
        command: 'python3',
        args: [script],
        env: { KB_DB: kbDb, KB_BASE: workspaceId },
      });
    }

    // 企业注册的连接器
    const rows = await this.prisma.connector.findMany({ where: { orgId, enabled: true } });
    for (const r of rows) {
      const cfg = JSON.parse(decryptSecret(r.configEnc)) as ConnectorConfig;
      servers.push({
        name: r.name,
        transport: cfg.transport,
        command: cfg.command,
        args: cfg.args,
        env: cfg.env,
        url: cfg.url,
      });
    }
    return servers;
  }

  private redact(cfg: ConnectorConfig): ConnectorConfig {
    if (!cfg.env) return cfg;
    const env: Record<string, string> = {};
    for (const k of Object.keys(cfg.env)) env[k] = '***';
    return { ...cfg, env };
  }
}
