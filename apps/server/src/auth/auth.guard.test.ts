import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';

vi.mock('./oidc.js', () => ({
  verifyOidcToken: vi.fn(),
  mapRole: (roles: string[]) => (roles.includes('apolla-admin') ? 'admin' : 'member'),
}));

import { AuthGuard, orgNameFromClaims, type AuthUser } from './auth.js';
import { verifyOidcToken } from './oidc.js';
import type { ApiKeyPrincipal } from '../apikeys/apikey.service.js';

/**
 * 认证守卫：API Key 路径（T-419）与多租户 JIT（T-418）。
 * 用假 Prisma 与假 ApiKeyService；OIDC 验签整体 mock 掉（验签本身在 oidc.test 里测）。
 */
class FakePrisma {
  orgs: { id: string; name: string }[] = [{ id: 'org1', name: 'corp.com' }];
  users: { id: string; email: string; name: string; ssoSubject?: string }[] = [{ id: 'u1', email: 'tim@corp.com', name: 'Tim' }];
  memberships: { orgId: string; userId: string; role: string }[] = [{ orgId: 'org1', userId: 'u1', role: 'admin' }];
  private n = 0;
  org = {
    findFirst: async ({ where }: any = {}) => (where?.name ? this.orgs.find((o) => o.name === where.name) : this.orgs[0]) ?? null,
    create: async ({ data }: any) => {
      const o = { id: `org${++this.n + 1}`, ...data };
      this.orgs.push(o);
      return o;
    },
  };
  user = {
    findUnique: async ({ where }: any) => this.users.find((u) => u.id === where.id) ?? null,
    findFirst: async ({ where }: any) =>
      this.users.find((u) => where.OR.some((c: any) => (c.ssoSubject && u.ssoSubject === c.ssoSubject) || (c.email && u.email === c.email))) ?? null,
    create: async ({ data }: any) => {
      const u = { id: `u${this.users.length + 1}`, ...data };
      this.users.push(u);
      return u;
    },
  };
  membership = {
    findFirst: async ({ where }: any) =>
      this.memberships.find((m) => (!where.orgId || m.orgId === where.orgId) && (!where.userId || m.userId === where.userId) && (!where.role || m.role === where.role)) ?? null,
    upsert: async ({ where, create, update }: any) => {
      const w = where.orgId_userId;
      const m = this.memberships.find((x) => x.orgId === w.orgId && x.userId === w.userId);
      if (m) Object.assign(m, update);
      else this.memberships.push(create);
      return m ?? create;
    },
  };
}

class FakeApiKeys {
  principal: ApiKeyPrincipal | null = null;
  authenticate = async () => this.principal;
}

const ctx = (headers: Record<string, string>, url = '/api/v1/sessions/s1/tasks', query: Record<string, string> = {}) => {
  const req: { headers: Record<string, string>; url: string; query: Record<string, string>; user?: AuthUser } = { headers, url, query };
  return { ctx: { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext, req };
};

let db: FakePrisma;
let keys: FakeApiKeys;
const guard = (cfg: Partial<{ authMode: 'dev' | 'oidc'; multiTenant: boolean }> = {}) =>
  new AuthGuard({ authMode: 'oidc', multiTenant: false, ...cfg } as never, db as never, keys as never);
const key = (scopes: string[], createdBy = 'u1', orgId = 'org1'): ApiKeyPrincipal => ({
  key: { id: 'k1', orgId, createdBy, name: '企微机器人', prefix: 'p', hash: 'h', scopes: scopes.join(','), expiresAt: null, lastUsedAt: null, revokedAt: null, createdAt: new Date() },
  scopes: new Set(scopes as never[]),
});

beforeEach(() => {
  db = new FakePrisma();
  keys = new FakeApiKeys();
  process.env.OIDC_ISSUER = 'http://idp/realms/apolla';
});

describe('API Key（T-419）', () => {
  it('★ x-api-key 有效：以创建者身份行事，角色封顶 member，带 via 标记', async () => {
    keys.principal = key(['tasks', 'files']);
    const { ctx: c, req } = ctx({ 'x-api-key': 'ak_xxxxxxxx_' + 'y'.repeat(40) });
    expect(await guard().canActivate(c)).toBe(true);
    expect(req.user).toMatchObject({ id: 'u1', orgId: 'org1', role: 'member', via: 'apikey:k1' });
    expect(req.user!.name).toContain('企微机器人');
  });

  it('★ scope 不够：tasks-only 的 Key 访问 /admin 被拒；带 admin scope 且创建者是管理员才得 admin', async () => {
    keys.principal = key(['tasks']);
    expect(await guard().canActivate(ctx({ 'x-api-key': 'ak_a' }, '/api/v1/admin/models').ctx)).toBe(false);
    keys.principal = key(['tasks', 'admin']);
    const { ctx: c, req } = ctx({ 'x-api-key': 'ak_a' }, '/api/v1/admin/models');
    expect(await guard().canActivate(c)).toBe(true);
    expect(req.user!.role).toBe('admin');
  });

  it('无效/吊销/过期的 Key → 未认证（service 返回 null）；Authorization: ApiKey 形式同样支持', async () => {
    keys.principal = null;
    expect(await guard().canActivate(ctx({ 'x-api-key': 'ak_bad' }).ctx)).toBe(false);
    keys.principal = key(['tasks']);
    expect(await guard().canActivate(ctx({ authorization: 'ApiKey ak_pppppppp_' + 'z'.repeat(40) }).ctx)).toBe(true);
  });

  it('dev 模式下 API Key 同样生效（IM bridge 本地联调）', async () => {
    keys.principal = key(['tasks']);
    const { ctx: c, req } = ctx({ 'x-api-key': 'ak_a' });
    expect(await guard({ authMode: 'dev' }).canActivate(c)).toBe(true);
    expect(req.user!.via).toBe('apikey:k1');
  });

  it('创建者已不在该组织 → 拒绝（离职即失效）', async () => {
    keys.principal = key(['tasks'], 'u1', 'org-other');
    expect(await guard().canActivate(ctx({ 'x-api-key': 'ak_a' }).ctx)).toBe(false);
  });
});

describe('多租户 JIT（T-418）', () => {
  const claims = (email: string, org?: string) => ({ sub: `sub-${email}`, email, name: email, roles: [], org });

  it('orgNameFromClaims：优先 org 声明，否则邮箱域名', () => {
    expect(orgNameFromClaims({ email: 'a@acme.com', org: '  Acme  ' })).toBe('Acme');
    expect(orgNameFromClaims({ email: 'a@Acme.COM' })).toBe('acme.com');
    expect(orgNameFromClaims({ email: 'nodomain' })).toBe('default');
  });

  it('关闭多租户：所有 SSO 用户进首个组织', async () => {
    vi.mocked(verifyOidcToken).mockResolvedValue(claims('x@other.com'));
    const { ctx: c, req } = ctx({ authorization: 'Bearer jwt' });
    expect(await guard().canActivate(c)).toBe(true);
    expect(req.user!.orgId).toBe('org1');
    expect(db.orgs).toHaveLength(1);
  });

  it('★ 开启多租户：不同域名的用户落到各自组织，互不可见；同域名复用同一组织', async () => {
    vi.mocked(verifyOidcToken).mockResolvedValue(claims('a@acme.com'));
    const a = ctx({ authorization: 'Bearer a' });
    await guard({ multiTenant: true }).canActivate(a.ctx);
    vi.mocked(verifyOidcToken).mockResolvedValue(claims('b@globex.com'));
    const b = ctx({ authorization: 'Bearer b' });
    await guard({ multiTenant: true }).canActivate(b.ctx);
    vi.mocked(verifyOidcToken).mockResolvedValue(claims('c@acme.com'));
    const c2 = ctx({ authorization: 'Bearer c' });
    await guard({ multiTenant: true }).canActivate(c2.ctx);

    expect(a.req.user!.orgId).not.toBe(b.req.user!.orgId);
    expect(c2.req.user!.orgId).toBe(a.req.user!.orgId);
    expect(db.orgs.map((o) => o.name)).toEqual(expect.arrayContaining(['acme.com', 'globex.com']));
    // 各自组织的成员关系互不串扰
    expect(db.memberships.filter((m) => m.orgId === a.req.user!.orgId).map((m) => m.userId)).not.toContain(b.req.user!.id);
  });

  it('IdP 带 org 声明时按声明归组，而不是邮箱域名', async () => {
    vi.mocked(verifyOidcToken).mockResolvedValue(claims('x@gmail.com', 'Acme Group'));
    const { ctx: c, req } = ctx({ authorization: 'Bearer x' });
    await guard({ multiTenant: true }).canActivate(c);
    expect(db.orgs.find((o) => o.id === req.user!.orgId)?.name).toBe('Acme Group');
  });
});
