import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { CreateSessionDto, CreateWorkspaceDto } from '@apolla/protocol';
import { PrismaService } from '../prisma.service.js';
import { AuthGuard, currentUser } from '../auth/auth.js';
import { ZodBody } from '../common/zod-pipe.js';

@UseGuards(AuthGuard)
@Controller('api/v1')
export class WorkspacesController {
  constructor(private prisma: PrismaService) {}

  @Get('me')
  me(@Req() req: FastifyRequest) {
    return currentUser(req);
  }

  @Get('workspaces')
  async list(@Req() req: FastifyRequest) {
    const u = currentUser(req);
    return this.prisma.workspace.findMany({
      where: { orgId: u.orgId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  @Post('workspaces')
  async create(@Req() req: FastifyRequest, @Body(new ZodBody(CreateWorkspaceDto)) dto: CreateWorkspaceDto) {
    const u = currentUser(req);
    return this.prisma.workspace.create({
      data: { orgId: u.orgId, name: dto.name, description: dto.description, defaultMode: dto.defaultMode },
    });
  }

  @Delete('workspaces/:id')
  async remove(@Param('id') id: string) {
    await this.prisma.workspace.update({ where: { id }, data: { deletedAt: new Date() } });
    return { ok: true };
  }

  @Get('workspaces/:id/sessions')
  async sessions(@Param('id') id: string) {
    return this.prisma.session.findMany({
      where: { workspaceId: id },
      orderBy: { createdAt: 'desc' },
      include: { tasks: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });
  }

  @Post('workspaces/:id/sessions')
  async createSession(@Param('id') id: string, @Body(new ZodBody(CreateSessionDto)) dto: CreateSessionDto) {
    return this.prisma.session.create({ data: { workspaceId: id, title: dto.title } });
  }
}
