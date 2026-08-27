import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.js';
import { AutomationService } from '../automation/automation.service.js';

@UseGuards(AuthGuard)
@Controller('api/v1')
export class AutomationController {
  constructor(private automation: AutomationService) {}

  @Get('workspaces/:id/automations')
  list(@Param('id') id: string) {
    return this.automation.list(id);
  }

  @Post('workspaces/:id/automations')
  create(
    @Param('id') id: string,
    @Body() body: { name: string; cron: string; tz?: string; prompt: string; mode?: string },
  ) {
    return this.automation.upsert({ ...body, workspaceId: id });
  }

  @Post('automations/:aid/run')
  async run(@Param('aid') aid: string) {
    const taskId = await this.automation.fire(aid);
    return { ok: !!taskId, taskId };
  }

  @Delete('automations/:aid')
  async remove(@Param('aid') aid: string) {
    await this.automation.remove(aid);
    return { ok: true };
  }
}
