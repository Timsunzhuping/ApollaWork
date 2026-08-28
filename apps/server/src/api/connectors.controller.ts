import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AuthGuard, currentUser } from '../auth/auth.js';
import { AccessService } from '../access/access.service.js';
import { ConnectorService, type ConnectorConfig } from '../connectors/connector.service.js';

@UseGuards(AuthGuard)
@Controller('api/v1')
export class ConnectorsController {
  constructor(
    private connectors: ConnectorService,
    private access: AccessService,
  ) {}

  /** 连接器配置含企业内网凭据，限组织管理员。 */
  private admin(req: FastifyRequest) {
    const u = currentUser(req);
    this.access.requireAdmin(u);
    return u;
  }

  @Get('connectors')
  list(@Req() req: FastifyRequest) {
    return this.connectors.list(this.admin(req).orgId);
  }

  @Post('connectors')
  create(
    @Req() req: FastifyRequest,
    @Body() body: { id?: string; name: string; config: ConnectorConfig; enabled?: boolean },
  ) {
    return this.connectors.upsert({ ...body, orgId: this.admin(req).orgId });
  }

  @Post('connectors/:id/test')
  test(@Req() req: FastifyRequest, @Param('id') id: string) {
    this.admin(req);
    return this.connectors.test(id);
  }

  @Delete('connectors/:id')
  async remove(@Req() req: FastifyRequest, @Param('id') id: string) {
    this.admin(req);
    await this.connectors.remove(id);
    return { ok: true };
  }
}
