import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AuthGuard, currentUser } from '../auth/auth.js';
import { ConnectorService, type ConnectorConfig } from '../connectors/connector.service.js';

@UseGuards(AuthGuard)
@Controller('api/v1')
export class ConnectorsController {
  constructor(private connectors: ConnectorService) {}

  @Get('connectors')
  list(@Req() req: FastifyRequest) {
    return this.connectors.list(currentUser(req).orgId);
  }

  @Post('connectors')
  create(
    @Req() req: FastifyRequest,
    @Body() body: { id?: string; name: string; config: ConnectorConfig; enabled?: boolean },
  ) {
    return this.connectors.upsert({ ...body, orgId: currentUser(req).orgId });
  }

  @Post('connectors/:id/test')
  test(@Param('id') id: string) {
    return this.connectors.test(id);
  }

  @Delete('connectors/:id')
  async remove(@Param('id') id: string) {
    await this.connectors.remove(id);
    return { ok: true };
  }
}
