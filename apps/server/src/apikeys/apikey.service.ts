import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service.js';
import type { AuthUser } from '../auth/auth.js';

/**
 * 集成用 API Key（T-419）。
 * 此前外部系统（IM bridge、自动化脚本）只能借用某个用户的 OIDC 令牌 —— 5 分钟过期、绑定个人、没法吊销。
 * 现在：组织管理员签发 Key，格式 `ak_<prefix>_<secret>`（secret 为 64 位 hex）；库里只存 sha256(secret)；
 * Key 以创建者身份行事，但角色封顶 member（scopes 含 admin 才放开）；可设过期、可吊销、记录最近使用。
 */

export const SCOPES = ['tasks', 'files', 'admin'] as const;
export type Scope = (typeof SCOPES)[number];

export interface ApiKeyRow {
  id: string;
  orgId: string;
  createdBy: string;
  name: string;
  prefix: string;
  hash: string;
  scopes: string;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface ApiKeyPrincipal {
  key: ApiKeyRow;
  scopes: Set<Scope>;
}

export const hashSecret = (secret: string) => createHash('sha256').update(secret).digest('hex');

/** 解析 `ak_<prefix>_<secret>`；格式不对返回 null（不抛：守卫里当作未认证） */
export function parseApiKey(raw: string): { prefix: string; secret: string } | null {
  const m = /^ak_([A-Za-z0-9]{8})_([A-Za-z0-9_-]{32,})$/.exec(raw.trim());
  return m ? { prefix: m[1]!, secret: m[2]! } : null;
}

export function parseScopes(s: string): Set<Scope> {
  return new Set(s.split(',').map((x) => x.trim()).filter((x): x is Scope => (SCOPES as readonly string[]).includes(x)));
}

/** 路径需要的 scope：/admin 需 admin；/files 与 /workspaces/:id/file(s) 需 files；其余任务/会话类需 tasks */
export function requiredScope(path: string): Scope {
  const p = path.split('?')[0]!;
  if (p.startsWith('/api/v1/admin')) return 'admin';
  if (/\/files?(\/|$|\?)/.test(p) || p.includes('/file?')) return 'files';
  return 'tasks';
}

@Injectable()
export class ApiKeyService {
  constructor(private prisma: PrismaService) {}

  /** 签发：明文只在此刻返回一次，之后无法再看 */
  async issue(admin: AuthUser, input: { name: string; scopes?: Scope[]; expiresInDays?: number }) {
    if (!input.name?.trim()) throw new BadRequestException('请给 Key 一个名字（如「企微机器人」）');
    const scopes = (input.scopes?.length ? input.scopes : ['tasks', 'files']).filter((s) => (SCOPES as readonly string[]).includes(s));
    if (!scopes.length) throw new BadRequestException(`scopes 只能是 ${SCOPES.join(' / ')}`);
    if (input.expiresInDays !== undefined && (!Number.isInteger(input.expiresInDays) || input.expiresInDays <= 0 || input.expiresInDays > 3650)) {
      throw new BadRequestException('expiresInDays 必须是 1–3650 的整数');
    }
    const prefix = randomBytes(6).toString('base64url').replace(/[^A-Za-z0-9]/g, 'x').slice(0, 8).padEnd(8, '0');
    const secret = randomBytes(32).toString('hex'); // 用 hex：不含 _ 和 -，人工复制/按 _ 切分都不会出错
    const row = (await this.prisma.apiKey.create({
      data: {
        orgId: admin.orgId,
        createdBy: admin.id,
        name: input.name.trim(),
        prefix,
        hash: hashSecret(secret),
        scopes: scopes.join(','),
        expiresAt: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null,
      },
    })) as ApiKeyRow;
    return { row: this.view(row), plaintext: `ak_${prefix}_${secret}` };
  }

  async list(orgId: string) {
    const rows = (await this.prisma.apiKey.findMany({ where: { orgId }, orderBy: { createdAt: 'desc' } })) as ApiKeyRow[];
    return rows.map((r) => this.view(r));
  }

  async revoke(orgId: string, id: string) {
    const r = await this.prisma.apiKey.updateMany({ where: { id, orgId, revokedAt: null }, data: { revokedAt: new Date() } });
    if (r.count === 0) throw new BadRequestException('Key 不存在或已吊销');
  }

  /**
   * 校验一个明文 Key：格式 → 前缀查行 → 常量时间比对哈希 → 未吊销未过期。
   * 任何一步失败返回 null，守卫统一按未认证处理（不区分「不存在」与「错密」，防枚举）。
   */
  async authenticate(raw: string): Promise<ApiKeyPrincipal | null> {
    const parsed = parseApiKey(raw);
    if (!parsed) return null;
    const row = (await this.prisma.apiKey.findUnique({ where: { prefix: parsed.prefix } })) as ApiKeyRow | null;
    if (!row) return null;
    const a = Buffer.from(row.hash, 'hex');
    const b = Buffer.from(hashSecret(parsed.secret), 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    if (row.revokedAt) return null;
    if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null;
    // 最近使用：节流到每分钟最多写一次，避免每个请求都写库
    if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60_000) {
      void this.prisma.apiKey.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
    }
    return { key: row, scopes: parseScopes(row.scopes) };
  }

  private view(r: ApiKeyRow) {
    return {
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      scopes: r.scopes.split(','),
      createdBy: r.createdBy,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      lastUsedAt: r.lastUsedAt,
      revokedAt: r.revokedAt,
    };
  }
}
