import { Body, Controller, Delete, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { UpsertModelProviderDto } from '@apolla/protocol';
import { PrismaService } from '../prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { ModelService } from '../models/model.service.js';
import { RetentionService } from '../retention/retention.service.js';
import { AuthGuard, currentUser } from '../auth/auth.js';
import { AccessService } from '../access/access.service.js';

@UseGuards(AuthGuard)
@Controller('api/v1/admin')
export class AdminController {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private modelSvc: ModelService,
    private access: AccessService,
    private retention: RetentionService,
  ) {}

  /** 所有管理端点统一要求组织管理员（模型密钥、审计、用量均为治理数据）。 */
  private admin(req: FastifyRequest) {
    const u = currentUser(req);
    this.access.requireAdmin(u);
    return u;
  }

  @Get('models')
  async models(@Req() req: FastifyRequest) {
    return this.modelSvc.list(this.admin(req).orgId);
  }

  @Post('models')
  async upsertModel(
    @Req() req: FastifyRequest,
    @Body() body: { id?: string; name: string; baseUrl: string; apiKey?: string; model: string; tier: string; enabled?: boolean },
  ) {
    const u = this.admin(req);
    await this.audit.record(u.id, 'model.upsert', body.name, `${body.tier}/${body.model}`);
    return this.modelSvc.upsert({ ...body, orgId: u.orgId });
  }

  @Post('models/:id/test')
  test(@Req() req: FastifyRequest, @Param('id') id: string) {
    this.admin(req);
    return this.modelSvc.test(id);
  }

  @Delete('models/:id')
  async removeModel(@Req() req: FastifyRequest, @Param('id') id: string) {
    this.admin(req);
    await this.modelSvc.remove(id);
    return { ok: true };
  }

  @Get('usage')
  async usage(@Req() req: FastifyRequest, @Query('days') days = '7') {
    this.admin(req);
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

  /** 组织成员（T-410）：列表与角色变更。最后一名管理员不能被降级。 */
  @Get('members')
  async members(@Req() req: FastifyRequest) {
    const u = this.admin(req);
    const rows = await this.prisma.membership.findMany({
      where: { orgId: u.orgId },
      include: { user: { select: { email: true, name: true } } },
      orderBy: { role: 'asc' },
    });
    return rows.map((r) => ({ userId: r.userId, role: r.role, email: r.user.email, name: r.user.name }));
  }

  @Post('members/:userId/role')
  async setMemberRole(@Req() req: FastifyRequest, @Param('userId') userId: string, @Body() body: { role: 'admin' | 'member' }) {
    const u = this.admin(req);
    if (body.role !== 'admin' && body.role !== 'member') return { error: '角色只能是 admin 或 member' };
    if (userId === u.id) return { error: '不能修改自己的组织角色' };
    if (body.role === 'member') {
      const admins = await this.prisma.membership.count({ where: { orgId: u.orgId, role: 'admin' } });
      const target = await this.prisma.membership.findFirst({ where: { orgId: u.orgId, userId } });
      if (target?.role === 'admin' && admins <= 1) return { error: '组织至少保留一名管理员' };
    }
    const r = await this.prisma.membership.updateMany({ where: { orgId: u.orgId, userId }, data: { role: body.role } });
    if (r.count === 0) return { error: '该用户不在本组织' };
    await this.audit.record(u.id, 'org.member.role', userId, body.role);
    return { ok: true };
  }

  @Get('audit')
  async audit_(@Req() req: FastifyRequest, @Query('actor') actor?: string, @Query('action') action?: string) {
    this.admin(req);
    return this.audit.query({ actor, action, limit: 200 });
  }

  /** 数据留存策略（生产合规）。 */
  @Get('retention')
  retentionPolicy(@Req() req: FastifyRequest) {
    this.admin(req);
    return this.retention.policy();
  }

  /** 预览清理影响面（dryRun）或真正执行。执行需显式 confirm。 */
  @Post('retention/run')
  async retentionRun(@Req() req: FastifyRequest, @Body() body: { confirm?: boolean }) {
    const u = this.admin(req);
    const dryRun = body?.confirm !== true;
    const res = await this.retention.run(dryRun);
    if (!dryRun) {
      await this.audit.record(u.id, 'retention.run', undefined, JSON.stringify(res));
    }
    return res;
  }

  /** 任务链路回放（PRD T-121）：从事件溯源重建时间线。 */
  @Get('traces/:taskId')
  async trace(@Req() req: FastifyRequest, @Param('taskId') taskId: string) {
    this.admin(req);
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
