import { beforeEach, describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { ApiKeyService, hashSecret, parseApiKey, parseScopes, requiredScope } from './apikey.service.js';
import type { AuthUser } from '../auth/auth.js';

/** 集成 API Key（T-419）：签发只显一次、只存哈希、吊销/过期即失效、scope 按路径判定 */
class FakePrisma {
  rows: any[] = [];
  private n = 0;
  apiKey = {
    create: async ({ data }: any) => {
      const row = { id: `k${++this.n}`, expiresAt: null, lastUsedAt: null, revokedAt: null, createdAt: new Date(), ...data };
      this.rows.push(row);
      return row;
    },
    findMany: async ({ where }: any) => this.rows.filter((r) => r.orgId === where.orgId),
    findUnique: async ({ where }: any) => this.rows.find((r) => r.prefix === where.prefix) ?? null,
    update: async ({ where, data }: any) => Object.assign(this.rows.find((r) => r.id === where.id), data),
    updateMany: async ({ where, data }: any) => {
      const hit = this.rows.filter((r) => r.id === where.id && r.orgId === where.orgId && (where.revokedAt === undefined || r.revokedAt === where.revokedAt));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    },
  };
}
const admin: AuthUser = { id: 'u-admin', email: 'a@corp.com', name: 'A', role: 'admin', orgId: 'org1' };
let db: FakePrisma;
let svc: ApiKeyService;
beforeEach(() => {
  db = new FakePrisma();
  svc = new ApiKeyService(db as never);
});

describe('parse / scope', () => {
  it('parseApiKey 只接受 ak_<8位前缀>_<≥32位密文>', () => {
    expect(parseApiKey('ak_abcd1234_' + 'x'.repeat(43))).toEqual({ prefix: 'abcd1234', secret: 'x'.repeat(43) });
    expect(parseApiKey('sk-live-xxx')).toBeNull();
    expect(parseApiKey('ak_short_abc')).toBeNull();
  });
  it('requiredScope：/admin→admin，文件路由→files，其余→tasks', () => {
    expect(requiredScope('/api/v1/admin/models')).toBe('admin');
    expect(requiredScope('/api/v1/workspaces/w1/files')).toBe('files');
    expect(requiredScope('/api/v1/workspaces/w1/file?path=a.csv')).toBe('files');
    expect(requiredScope('/api/v1/sessions/s1/tasks')).toBe('tasks');
    expect(requiredScope('/api/v1/tasks/t1/events?access_token=x')).toBe('tasks');
  });
  it('parseScopes 丢弃未知 scope', () => {
    expect([...parseScopes('tasks, files,bogus')]).toEqual(['tasks', 'files']);
  });
});

describe('ApiKeyService', () => {
  it('★ 签发返回一次明文；库里只存哈希；列表不含明文/哈希', async () => {
    const { row, plaintext } = await svc.issue(admin, { name: '企微机器人' });
    expect(plaintext.startsWith(`ak_${row.prefix}_`)).toBe(true);
    const stored = db.rows[0];
    const secret = plaintext.slice(`ak_${row.prefix}_`.length);
    expect(stored.hash).toBe(hashSecret(secret));
    expect(stored.hash).not.toContain(plaintext);
    const list = await svc.list('org1');
    expect(JSON.stringify(list)).not.toContain(stored.hash);
    expect(JSON.stringify(list)).not.toContain(plaintext);
    expect(row.scopes).toEqual(['tasks', 'files']);
  });

  it('★ 正确密文通过，错密文/错前缀/跨组织列表均为 null', async () => {
    const { plaintext } = await svc.issue(admin, { name: 'k' });
    expect((await svc.authenticate(plaintext))?.key.orgId).toBe('org1');
    const prefix = plaintext.slice(3, 11);
    const secret = plaintext.slice(12);
    expect(await svc.authenticate(`ak_${prefix}_${'0'.repeat(secret.length)}`)).toBeNull();
    expect(await svc.authenticate(`ak_zzzzzzzz_${secret}`)).toBeNull();
    expect(await svc.list('org2')).toEqual([]);
  });

  it('★ 吊销后立即失效；重复吊销报错', async () => {
    const { row, plaintext } = await svc.issue(admin, { name: 'k' });
    await svc.revoke('org1', row.id);
    expect(await svc.authenticate(plaintext)).toBeNull();
    await expect(svc.revoke('org1', row.id)).rejects.toThrow(BadRequestException);
    await expect(svc.revoke('org2', 'k9')).rejects.toThrow(BadRequestException);
  });

  it('过期即失效；expiresInDays 越界拒绝', async () => {
    const { plaintext } = await svc.issue(admin, { name: 'k', expiresInDays: 1 });
    db.rows[0].expiresAt = new Date(Date.now() - 1000);
    expect(await svc.authenticate(plaintext)).toBeNull();
    await expect(svc.issue(admin, { name: 'k', expiresInDays: 0 })).rejects.toThrow(BadRequestException);
    await expect(svc.issue(admin, { name: 'k', expiresInDays: 99999 })).rejects.toThrow(BadRequestException);
  });

  it('scopes 校验：未知 scope 过滤，全无效则拒绝；名字必填', async () => {
    const { row } = await svc.issue(admin, { name: 'k', scopes: ['admin', 'bogus' as never] });
    expect(row.scopes).toEqual(['admin']);
    await expect(svc.issue(admin, { name: 'k', scopes: ['bogus' as never] })).rejects.toThrow(BadRequestException);
    await expect(svc.issue(admin, { name: ' ' })).rejects.toThrow(BadRequestException);
  });

  it('认证成功会（节流地）记录最近使用时间', async () => {
    const { plaintext } = await svc.issue(admin, { name: 'k' });
    await svc.authenticate(plaintext);
    await new Promise((r) => setTimeout(r, 5));
    expect(db.rows[0].lastUsedAt).toBeInstanceOf(Date);
  });
});
