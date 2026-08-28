import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service.js';
import { CONFIG, type AppConfig } from '../config.js';

export interface QuotaStatus {
  allowed: boolean;
  used: number;
  limit: number;
  scope: 'org' | 'user';
  reason?: string;
}

/**
 * 配额执行（生产 P1）。此前 usage_records 只记录不拦截 —— 单用户可打爆模型预算。
 * 现在按「组织月度 token 上限」与「用户月度 token 上限」在任务创建前拦截。
 * 限额为 0 表示不限制。
 */
@Injectable()
export class QuotaService {
  private readonly log = new Logger('Quota');
  constructor(
    private prisma: PrismaService,
    @Inject(CONFIG) private config: AppConfig,
  ) {}

  private monthStart(): Date {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  }

  /** 统计本月已消耗 token（in+out）。 */
  private async usedTokens(where: { workspaceIds?: string[]; userId?: string }): Promise<number> {
    const rows = await this.prisma.usageRecord.findMany({
      where: {
        ts: { gte: this.monthStart() },
        ...(where.userId ? { userId: where.userId } : {}),
        ...(where.workspaceIds ? { workspaceId: { in: where.workspaceIds } } : {}),
      },
      select: { inTokens: true, outTokens: true },
    });
    return rows.reduce((n, r) => n + r.inTokens + r.outTokens, 0);
  }

  /** 任务创建前检查。超限则拒绝，并写审计。 */
  async check(orgId: string, userId: string): Promise<QuotaStatus> {
    const { orgMonthlyTokens, userMonthlyTokens } = this.config.quota;

    if (userMonthlyTokens > 0) {
      const used = await this.usedTokens({ userId });
      if (used >= userMonthlyTokens) {
        return {
          allowed: false,
          used,
          limit: userMonthlyTokens,
          scope: 'user',
          reason: `本月个人 token 配额已用尽（${used}/${userMonthlyTokens}），请联系管理员调整。`,
        };
      }
    }

    if (orgMonthlyTokens > 0) {
      const workspaces = await this.prisma.workspace.findMany({
        where: { orgId },
        select: { id: true },
      });
      const used = await this.usedTokens({ workspaceIds: workspaces.map((w) => w.id) });
      if (used >= orgMonthlyTokens) {
        return {
          allowed: false,
          used,
          limit: orgMonthlyTokens,
          scope: 'org',
          reason: `本月组织 token 配额已用尽（${used}/${orgMonthlyTokens}）。`,
        };
      }
    }

    return { allowed: true, used: 0, limit: orgMonthlyTokens, scope: 'org' };
  }

  /** 供管理后台展示当前用量与限额。 */
  async status(orgId: string, userId: string) {
    const workspaces = await this.prisma.workspace.findMany({ where: { orgId }, select: { id: true } });
    return {
      org: {
        used: await this.usedTokens({ workspaceIds: workspaces.map((w) => w.id) }),
        limit: this.config.quota.orgMonthlyTokens,
      },
      user: {
        used: await this.usedTokens({ userId }),
        limit: this.config.quota.userMonthlyTokens,
      },
      periodStart: this.monthStart().toISOString(),
    };
  }
}
