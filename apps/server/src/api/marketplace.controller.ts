import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AuthGuard, currentUser } from '../auth/auth.js';
import { AccessService } from '../access/access.service.js';
import { MarketplaceService } from '../marketplace/marketplace.service.js';

@UseGuards(AuthGuard)
@Controller('api/v1')
export class MarketplaceController {
  constructor(
    private market: MarketplaceService,
    private access: AccessService,
  ) {}

  @Get('marketplace')
  list() {
    return this.market.list();
  }

  @Post('marketplace/install')
  install(@Req() req: FastifyRequest, @Body() body: { name: string }) {
    this.access.requireAdmin(currentUser(req));
    return this.market.install(body.name);
  }

  @Post('marketplace/uninstall')
  uninstall(@Req() req: FastifyRequest, @Body() body: { name: string }) {
    this.access.requireAdmin(currentUser(req));
    return this.market.uninstall(body.name);
  }
}
