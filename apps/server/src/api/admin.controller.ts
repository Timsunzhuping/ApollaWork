import { Body, Controller, Delete, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { UpsertModelProviderDto } from '@apolla/protocol';
import { PrismaService } from '../prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { ModelService } from '../models/model.service.js';
import { AuthGuard, currentUser } from '../auth/auth.js';

@UseGuards(AuthGuard)
@Controller('api/v1/admin')
export class AdminController {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private modelSvc: ModelService,
  ) {}

  @Get('models')
  async models(@Req() req: FastifyRequest) {
    return this.modelSvc.list(currentUser(req).orgId);
  }

  @Post('models')
  async upsertModel(
    @Req() req: FastifyRequest,
    @Body() body: { id?: string; name: string; baseUrl: string; apiKey?: string; model: string; tier: string; enabled?: boolean },
  ) {
    const u = currentUser(req);
    await this.audit.record(u.id, 'model.upsert', body.name, `${body.tier}/${body.model}`);
    return this.modelSvc.upsert({ ...body, orgId: u.orgId });
  }

  @Post('models/:id/test')
  test(@Param('id') id: string) {
    return this.modelSvc.test(id);
  }

  @Delete('models/:id')
  async removeModel(@Param('id') id: string) {
    await this.modelSvc.remove(id);
    return { ok: true };
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

  /** 任务链路回放（PRD T-121）：从事件溯源重建时间线。 */
  @Get('traces/:taskId')
  async trace(@Param('taskId') taskId: string) {
    const rows = await this.prisma.taskEventRow.findMany({
      where: { taskId },
      orderBy: { seq: 'asc' },
    });
    const t0 = rows[0]?.ts.getTime() ?? 0;
    return {
      taskId,
      spans: rows.map((r) => ({
        seq: r.seq,
        type: r.type,
        offsetMs: r.ts.getTime() - t0,
        payload: JSON.parse(r.payload),
      })),
    };
  }
}
