import { Controller, Get, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { MetricsService } from './metrics.service.js';

/**
 * Prometheus 抓取端点（T-412）。不走 AuthGuard —— 抓取器不带用户令牌。
 * 生产建议只在内网暴露；若必须过公网，设 METRICS_TOKEN 要求 `Authorization: Bearer <token>`。
 */
@Controller()
export class MetricsController {
  constructor(private metrics: MetricsService) {}

  @Get('metrics')
  async scrape(@Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    const required = process.env.METRICS_TOKEN;
    if (required) {
      const got = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      if (got !== required) return reply.code(401).send('unauthorized');
    }
    reply.header('Content-Type', this.metrics.contentType);
    return reply.send(await this.metrics.render());
  }
}
