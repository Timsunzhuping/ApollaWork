import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service.js';

/** 审计（PRD §3）：所有工具/审批/admin/登录操作留痕，只增不删。 */
@Injectable()
export class AuditService {
  constructor(private prisma: PrismaService) {}

  async record(actor: string, action: string, target?: string, detail?: string, ip?: string) {
    await this.prisma.auditEvent.create({ data: { actor, action, target, detail, ip } });
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
