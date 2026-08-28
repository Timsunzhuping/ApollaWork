import { Controller, Get, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { PrismaService } from '../prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { ModelService } from '../models/model.service.js';

/**
 * 健康与就绪探针（生产 P1）。**不需要鉴权**——K8s/LB 探针不带凭据。
 * 只暴露组件可用性，不泄露配置细节。
 *  - /healthz  存活：进程在跑即 200（供 liveness）
 *  - /readyz   就绪：DB 可查、存储可达才 200（供 readiness，未就绪返回 503）
 */
@Controller()
export class HealthController {
  constructor(
    private prisma: PrismaService,
    private storage: StorageService,
  ) {}

  @Get('healthz')
  live() {
    return { status: 'ok', uptime: Math.round(process.uptime()) };
  }

  @Get('readyz')
  async ready(@Res() reply: FastifyReply) {
    const checks: Record<string, string> = {};
    let ok = true;

    try {
      await this.prisma.$queryRawUnsafe('SELECT 1');
      checks.database = 'ok';
    } catch (e) {
      checks.database = `fail: ${(e as Error).message.slice(0, 80)}`;
      ok = false;
    }

    try {
      await this.storage.list('__healthcheck__');
      checks.storage = `ok (${this.storage.kind})`;
    } catch (e) {
      checks.storage = `fail: ${(e as Error).message.slice(0, 80)}`;
      ok = false;
    }

    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ready' : 'not-ready', checks });
  }
}
