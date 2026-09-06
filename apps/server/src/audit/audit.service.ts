import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service.js';
import { MetricsService } from '../metrics/metrics.service.js';

/** 审计（PRD §3）：所有工具/审批/admin/登录操作留痕，只增不删。 */
@Injectable()
export class AuditService {
  private readonly log = new Logger('Audit');
  constructor(
    private prisma: PrismaService,
    private metrics: MetricsService,
  ) {}

  async record(actor: string, action: string, target?: string, detail?: string, ip?: string) {
    try {
      await this.prisma.auditEvent.create({ data: { actor, action, target, detail, ip } });
    } catch (e) {
      // 审计写失败不能静默：计数 + 错误日志（任何非零都应告警，见 infra/observability/alerts.yml）
      this.metrics.auditWriteFailures.inc();
      this.log.error(`审计写入失败 action=${action} actor=${actor}：${(e as Error).message}`);
      throw e;
    }
  }

  async query(opts: { actor?: string; action?: string; limit?: number }) {
    return this.prisma.auditEvent.findMany({
      where: {
        ...(opts.actor ? { actor: opts.actor } : {}),
        ...(opts.action ? { action: opts.action } : {}),
      },
      orderBy: { ts: 'desc' },
      take: Math.min(opts.limit ?? 200, 1000),
    });
  }
}
