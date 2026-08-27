import { Injectable, type CanActivate, type ExecutionContext, Inject } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { CONFIG, type AppConfig } from '../config.js';
import { PrismaService } from '../prisma.service.js';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'member';
  orgId: string;
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
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<FastifyRequest & { user?: AuthUser }>();
    if (this.config.authMode === 'dev') {
      req.user = await this.devUser();
      return true;
    }
    // oidc：占位 —— 校验 bearer JWT 并映射用户。M1 T-117 接 Keycloak。
    const auth = req.headers['authorization'];
    if (!auth?.startsWith('Bearer ')) return false;
    req.user = await this.devUser(); // TODO(T-117): 解析 JWT
    return true;
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
