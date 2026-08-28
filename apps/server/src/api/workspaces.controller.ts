import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { CreateSessionDto, CreateWorkspaceDto } from '@apolla/protocol';
import { PrismaService } from '../prisma.service.js';
import { AuthGuard, currentUser } from '../auth/auth.js';
import { AccessService } from '../access/access.service.js';
import { AuditService } from '../audit/audit.service.js';
import { ZodBody } from '../common/zod-pipe.js';

@UseGuards(AuthGuard)
@Controller('api/v1')
export class WorkspacesController {
  constructor(
    private prisma: PrismaService,
    private access: AccessService,
    private audit: AuditService,
  ) {}

  @Get('me')
  me(@Req() req: FastifyRequest) {
    return currentUser(req);
  }

  /** 只返回当前用户有成员资格的空间（管理员看本组织全部）。 */
  @Get('workspaces')
  async list(@Req() req: FastifyRequest) {
    return this.access.listWorkspaces(currentUser(req));
  }

  /** 创建者自动成为该空间 owner。 */
  @Post('workspaces')
  async create(
    @Req() req: FastifyRequest,
    @Body(new ZodBody(CreateWorkspaceDto)) dto: CreateWorkspaceDto,
  ) {
    const u = currentUser(req);
    const ws = await this.prisma.workspace.create({
      data: {
        orgId: u.orgId,
        name: dto.name,
        description: dto.description,
        defaultMode: dto.defaultMode,
        members: { create: { userId: u.id, role: 'owner' } },
      },
    });
    await this.audit.record(u.id, 'workspace.create', ws.id, dto.name);
    return ws;
  }

  @Delete('workspaces/:id')
  async remove(@Req() req: FastifyRequest, @Param('id') id: string) {
    const u = currentUser(req);
    await this.access.workspace(u, id, 'own');
    await this.prisma.workspace.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.audit.record(u.id, 'workspace.delete', id);
    return { ok: true };
  }

  // ---- 空间成员管理（owner / 组织管理员）----
  @Get('workspaces/:id/members')
  async members(@Req() req: FastifyRequest, @Param('id') id: string) {
    await this.access.workspace(currentUser(req), id, 'view');
    const rows = await this.prisma.workspaceMember.findMany({
      where: { workspaceId: id },
      include: { user: { select: { email: true, name: true } } },
    });
    return rows.map((r) => ({ userId: r.userId, role: r.role, ...r.user }));
  }

  @Post('workspaces/:id/members')
  async addMember(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Body() body: { email: string; role?: 'viewer' | 'editor' | 'owner' },
  ) {
    const u = currentUser(req);
    await this.access.workspace(u, id, 'own');
    const target = await this.prisma.user.findUnique({ where: { email: body.email } });
    if (!target) return { error: '用户不存在（需先登录过一次以建户）' };
    const role = body.role ?? 'editor';
    await this.prisma.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId: id, userId: target.id } },
      create: { workspaceId: id, userId: target.id, role },
      update: { role },
    });
    await this.audit.record(u.id, 'workspace.member.add', id, `${body.email}:${role}`);
    return { ok: true };
  }

  @Delete('workspaces/:id/members/:userId')
  async removeMember(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Param('userId') userId: string,
  ) {
    const u = currentUser(req);
    await this.access.workspace(u, id, 'own');
    await this.prisma.workspaceMember
      .delete({ where: { workspaceId_userId: { workspaceId: id, userId } } })
      .catch(() => undefined);
    await this.audit.record(u.id, 'workspace.member.remove', id, userId);
    return { ok: true };
  }

  @Get('workspaces/:id/sessions')
  async sessions(@Req() req: FastifyRequest, @Param('id') id: string) {
    await this.access.workspace(currentUser(req), id, 'view');
    return this.prisma.session.findMany({
      where: { workspaceId: id },
      orderBy: { createdAt: 'desc' },
      include: { tasks: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });
  }

  @Post('workspaces/:id/sessions')
  async createSession(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Body(new ZodBody(CreateSessionDto)) dto: CreateSessionDto,
  ) {
    await this.access.workspace(currentUser(req), id, 'edit');
    return this.prisma.session.create({ data: { workspaceId: id, title: dto.title } });
  }
}
