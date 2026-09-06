import { Injectable, type CanActivate, type ExecutionContext, Inject } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { CONFIG, type AppConfig } from '../config.js';
import { PrismaService } from '../prisma.service.js';
import { verifyOidcToken, mapRole, type OidcClaims } from './oidc.js';
import { ApiKeyService, requiredScope } from '../apikeys/apikey.service.js';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'member';
  orgId: string;
  /** 经 API Key 调用时为 `apikey:<id>`（以创建者身份行事，见 T-419） */
  via?: string;
}

/** 多租户下组织名的推导：优先 IdP 的 org 声明，否则邮箱域名 */
export function orgNameFromClaims(claims: Pick<OidcClaims, 'email' | 'org'>): string {
  const explicit = claims.org?.trim();
  if (explicit) return explicit;
  const domain = claims.email.split('@')[1]?.toLowerCase().trim();
  return domain || 'default';
}

/**
 * 认证守卫。
 * - dev 模式：注入内置管理员（seed 建的 dev 用户），零登录，方便本地开发。
 * - oidc 模式：校验 Authorization Bearer（对接 Keycloak 的 JWT，M1 T-117 补全校验逻辑）。
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(CONFIG) private config: AppConfig,
    private prisma: PrismaService,
    private apiKeys: ApiKeyService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<FastifyRequest & { user?: AuthUser }>();

    // 集成用 API Key（T-419）：任何认证模式下都可用，供 IM bridge / 自动化脚本调用
    const rawKey = (req.headers['x-api-key'] as string | undefined) ?? this.bearerApiKey(req.headers['authorization']);
    if (rawKey) {
      const user = await this.apiKeyUser(rawKey, req.url);
      if (!user) return false;
      req.user = user;
      return true;
    }

    if (this.config.authMode === 'dev') {
      req.user = await this.devUser();
      return true;
    }
    // oidc：校验 bearer JWT（JWKS 验签）→ JIT 建户 → 映射角色
    // 令牌来源：Authorization 头优先；EventSource(SSE)/<img>/<a download> 无法设置请求头，
    // 故同时接受 access_token 查询参数（与主流实现一致；反代日志应屏蔽该参数）。
    const header = req.headers['authorization'];
    const fromHeader = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const fromQuery = (req.query as { access_token?: string } | undefined)?.access_token;
    const token = fromHeader ?? fromQuery;
    if (!token) return false;
    const issuer = process.env.OIDC_ISSUER;
    if (!issuer) return false;
    try {
      const claims = await verifyOidcToken(token, issuer);
      req.user = await this.jitUser(claims);
      return true;
    } catch {
      return false;
    }
  }

  private bearerApiKey(header?: string): string | undefined {
    if (!header) return undefined;
    const m = /^(?:ApiKey|Bearer)\s+(ak_[A-Za-z0-9_-]+)$/.exec(header);
    return m?.[1];
  }

  /**
   * API Key → 以创建者身份行事。角色封顶 member，除非 Key 明确带 admin scope；
   * 路径所需 scope 不在 Key 的 scopes 里 → 拒绝。
   */
  private async apiKeyUser(raw: string, url: string): Promise<AuthUser | null> {
    const principal = await this.apiKeys.authenticate(raw);
    if (!principal) return null;
    const need = requiredScope(url);
    if (!principal.scopes.has(need)) return null;
    const creator = await this.prisma.user.findUnique({ where: { id: principal.key.createdBy } });
    if (!creator) return null;
    const membership = await this.prisma.membership.findFirst({ where: { orgId: principal.key.orgId, userId: creator.id } });
    if (!membership) return null;
    const role: 'admin' | 'member' = principal.scopes.has('admin') && membership.role === 'admin' ? 'admin' : 'member';
    return {
      id: creator.id,
      email: creator.email,
      name: `${creator.name}（API Key：${principal.key.name}）`,
      role,
      orgId: principal.key.orgId,
      via: `apikey:${principal.key.id}`,
    };
  }

  /**
   * JIT：按 OIDC claims 建/取用户与组织成员关系。
   * 多租户（MULTI_TENANT=1，T-418）：按 org 声明 / 邮箱域名归入各自组织，不存在则建；
   * 关闭时全部进单一组织（首个 seed 组织）。
   */
  private async jitUser(claims: OidcClaims): Promise<AuthUser> {
    const org = await this.resolveOrg(claims);
    let user = await this.prisma.user.findFirst({
      where: { OR: [{ ssoSubject: claims.sub }, { email: claims.email }] },
    });
    if (!user) {
      user = await this.prisma.user.create({
        data: { email: claims.email, name: claims.name, ssoSubject: claims.sub },
      });
    }
    const role = mapRole(claims.roles);
    await this.prisma.membership.upsert({
      where: { orgId_userId: { orgId: org.id, userId: user.id } },
      create: { orgId: org.id, userId: user.id, role },
      update: { role },
    });
    return { id: user.id, email: user.email, name: user.name, role, orgId: org.id };
  }

  private async resolveOrg(claims: OidcClaims) {
    if (!this.config.multiTenant) {
      const org = await this.prisma.org.findFirst();
      if (!org) throw new Error('未初始化组织：请先 seed');
      return org;
    }
    const name = orgNameFromClaims(claims);
    const existing = await this.prisma.org.findFirst({ where: { name } });
    if (existing) return existing;
    return this.prisma.org.create({ data: { name } });
  }

  private async devUser(): Promise<AuthUser> {
    const membership = await this.prisma.membership.findFirst({
      where: { role: 'admin' },
      include: { user: true, org: true },
    });
    if (!membership) throw new Error('未初始化：请先运行 pnpm db:seed');
    return {
      id: membership.userId,
      email: membership.user.email,
      name: membership.user.name,
      role: membership.role as 'admin' | 'member',
      orgId: membership.orgId,
    };
  }
}

/** 便捷取当前用户 */
export function currentUser(req: FastifyRequest & { user?: AuthUser }): AuthUser {
  if (!req.user) throw new Error('未认证');
  return req.user;
}
