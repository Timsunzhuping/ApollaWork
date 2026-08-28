import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AuthGuard, currentUser } from '../auth/auth.js';
import { AccessService } from '../access/access.service.js';
import { AutomationService } from '../automation/automation.service.js';

@UseGuards(AuthGuard)
@Controller('api/v1')
export class AutomationController {
  constructor(
    private automation: AutomationService,
    private access: AccessService,
  ) {}

  @Get('workspaces/:id/automations')
  async list(@Req() req: FastifyRequest, @Param('id') id: string) {
    await this.access.workspace(currentUser(req), id, 'view');
    return this.automation.list(id);
  }

  @Post('workspaces/:id/automations')
  async create(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Body() body: { name: string; cron: string; tz?: string; prompt: string; mode?: string },
  ) {
    await this.access.workspace(currentUser(req), id, 'edit');
    return this.automation.upsert({ ...body, workspaceId: id });
  }

  @Post('automations/:aid/run')
  async run(@Req() req: FastifyRequest, @Param('aid') aid: string) {
    await this.access.automation(currentUser(req), aid, 'edit');
    const taskId = await this.automation.fire(aid);
    return { ok: !!taskId, taskId };
  }

  @Delete('automations/:aid')
  async remove(@Req() req: FastifyRequest, @Param('aid') aid: string) {
    await this.access.automation(currentUser(req), aid, 'edit');
    await this.automation.remove(aid);
    return { ok: true };
  }
}
