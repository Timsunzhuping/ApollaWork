import { Body, Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { UpsertModelProviderDto } from '@apolla/protocol';
import { PrismaService } from '../prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AuthGuard, currentUser } from '../auth/auth.js';
import { ZodBody } from '../common/zod-pipe.js';
import { encryptSecret } from '../common/crypto.js';

@UseGuards(AuthGuard)
@Controller('api/v1/admin')
export class AdminController {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  @Get('models')
  async models(@Req() req: FastifyRequest) {
    const u = currentUser(req);
    const rows = await this.prisma.modelProvider.findMany({ where: { orgId: u.orgId } });
    return rows.map((r) => ({ ...r, keyEnc: r.keyEnc ? '***' : null }));
  }

  @Get('usage')
  async usage(@Query('days') days = '7') {
    const since = new Date(Date.now() - Number(days) * 86400_000);
    const records = await this.prisma.usageRecord.findMany({ where: { ts: { gte: since } } });
    const byModel: Record<string, { in: number; out: number; count: number }> = {};
    let totalIn = 0;
    let totalOut = 0;
    for (const r of records) {
      byModel[r.model] ??= { in: 0, out: 0, count: 0 };
      byModel[r.model].in += r.inTokens;
      byModel[r.model].out += r.outTokens;
      byModel[r.model].count++;
      totalIn += r.inTokens;
      totalOut += r.outTokens;
    }
    const taskCount = await this.prisma.task.count();
    const byStatus = await this.prisma.task.groupBy({ by: ['status'], _count: true });
    return { totalIn, totalOut, taskCount, byModel, byStatus };
  }

  @Get('audit')
  async audit_(@Query('actor') actor?: string, @Query('action') action?: string) {
    return this.audit.query({ actor, action, limit: 200 });
  }
}
