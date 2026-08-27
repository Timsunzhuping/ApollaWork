import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.js';
import { MarketplaceService } from '../marketplace/marketplace.service.js';

@UseGuards(AuthGuard)
@Controller('api/v1')
export class MarketplaceController {
  constructor(private market: MarketplaceService) {}

  @Get('marketplace')
  list() {
    return this.market.list();
  }

  @Post('marketplace/install')
  install(@Body() body: { name: string }) {
    return this.market.install(body.name);
  }

  @Post('marketplace/uninstall')
  uninstall(@Body() body: { name: string }) {
    return this.market.uninstall(body.name);
  }
}
