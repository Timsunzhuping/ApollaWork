import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { UpsertModelProviderDto } from '@apolla/protocol';
import { PrismaService } from '../prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { ModelService } from '../models/model.service.js';
import { RetentionService } from '../retention/retention.service.js';
import { PolicyService } from '../policy/policy.service.js';
import { ApiKeyService, type Scope } from '../apikeys/apikey.service.js';
import { toJsonl, toSample, type FailureSample } from '../eval/failure-samples.js';
import type { TaskEvent } from '@apolla/protocol';
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
    private policy: PolicyService,
    private apiKeySvc: ApiKeyService,
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

  /** 审计导出（T-413）：CSV / JSONL，最多 5 万行；导出本身写一条审计 */
  @Get('audit/export')
  async auditExport(@Req() req: FastifyRequest, @Res() reply: FastifyReply, @Query('format') format = 'csv') {
    const u = this.admin(req);
    const rows = await this.prisma.auditEvent.findMany({ orderBy: { ts: 'desc' }, take: 50_000 });
    await this.audit.record(u.id, 'audit.export', undefined, `${format}:${rows.length}`);
    const stamp = new Date().toISOString().slice(0, 10);
    if (format === 'jsonl') {
      reply.header('Content-Type', 'application/x-ndjson; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="audit-${stamp}.jsonl"`);
      return reply.send(rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    }
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = ['id,ts,actor,action,target,detail,ip', ...rows.map((r) => [r.id, r.ts.toISOString(), r.actor, r.action, r.target, r.detail, r.ip].map(esc).join(','))].join('\n');
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="audit-${stamp}.csv"`);
    return reply.send('\ufeff' + csv + '\n');
  }

  /** 集成用 API Key（T-419）：明文只在签发响应里出现一次 */
  @Get('api-keys')
  async apiKeys(@Req() req: FastifyRequest) {
    const u = this.admin(req);
    return this.apiKeySvc.list(u.orgId);
  }

  @Post('api-keys')
  async issueApiKey(@Req() req: FastifyRequest, @Body() body: { name: string; scopes?: Scope[]; expiresInDays?: number }) {
    const u = this.admin(req);
    const { row, plaintext } = await this.apiKeySvc.issue(u, body);
    await this.audit.record(u.id, 'apikey.issue', row.id, `${row.name} scopes=${row.scopes.join(',')}`);
    return { ...row, plaintext };
  }

  @Delete('api-keys/:id')
  async revokeApiKey(@Req() req: FastifyRequest, @Param('id') id: string) {
    const u = this.admin(req);
    await this.apiKeySvc.revoke(u.orgId, id);
    await this.audit.record(u.id, 'apikey.revoke', id);
    return { ok: true };
  }

  /** 失败样本导出（T-420）：失败或用户打分 ≤2 的任务 + 压缩轨迹，JSONL，供标注/微调 */
  @Get('failures/export')
  async exportFailures(@Req() req: FastifyRequest, @Res() reply: FastifyReply, @Query('days') days = '30') {
    const u = this.admin(req);
    const since = new Date(Date.now() - Math.min(Math.max(Number(days) || 30, 1), 365) * 86_400_000);
    const tasks = await this.prisma.task.findMany({
      where: {
        createdAt: { gte: since },
        session: { workspace: { orgId: u.orgId } },
        OR: [{ status: 'failed' }, { rating: { lte: 2 } }],
      },
      orderBy: { createdAt: 'desc' },
      take: 2000,
    });
    const samples: FailureSample[] = [];
    for (const t of tasks) {
      const rows = await this.prisma.taskEventRow.findMany({ where: { taskId: t.id }, orderBy: { seq: 'asc' } });
      const s = toSample(t, rows.map((r) => ({ seq: r.seq, event: JSON.parse(r.payload) as TaskEvent })));
      if (s) samples.push(s);
    }
    await this.audit.record(u.id, 'failures.export', undefined, `${samples.length} samples / ${days}d`);
    reply.header('Content-Type', 'application/x-ndjson; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="failure-samples-${new Date().toISOString().slice(0, 10)}.jsonl"`);
    return reply.send(toJsonl(samples));
  }

  /** 策略中心（T-413）：审批规则表 */
  @Get('policies')
  async policies(@Req() req: FastifyRequest) {
    const u = this.admin(req);
    return this.policy.list(u.orgId);
  }

  @Post('policies/builtin/:key')
  async toggleBuiltin(@Req() req: FastifyRequest, @Param('key') key: string, @Body() body: { enabled: boolean }) {
    const u = this.admin(req);
    const row = await this.policy.setBuiltin(u.orgId, key, !!body.enabled);
    await this.audit.record(u.id, body.enabled ? 'policy.builtin.enable' : 'policy.builtin.disable', key);
    return row;
  }

  @Post('policies')
  async createPolicy(
    @Req() req: FastifyRequest,
    @Body() body: { kind: string; pattern: string; flags?: string; reason: string; workspaceId?: string | null },
  ) {
    const u = this.admin(req);
    const row = await this.policy.createCustom(u.orgId, body);
    await this.audit.record(u.id, 'policy.create', row.id, `${body.kind} /${body.pattern}/${body.flags ?? ''}`);
    return row;
  }

  @Patch('policies/:id')
  async updatePolicy(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Body() body: { enabled?: boolean; pattern?: string; flags?: string; reason?: string },
  ) {
    const u = this.admin(req);
    const row = await this.policy.updateCustom(u.orgId, id, body);
    await this.audit.record(u.id, 'policy.update', id, JSON.stringify(body));
    return row;
  }

  @Delete('policies/:id')
  async deletePolicy(@Req() req: FastifyRequest, @Param('id') id: string) {
    const u = this.admin(req);
    await this.policy.deleteCustom(u.orgId, id);
    await this.audit.record(u.id, 'policy.delete', id);
    return { ok: true };
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
