import 'reflect-metadata';
import fs from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { loadConfig } from './config.js';
import { StructuredLogger } from './common/logger.js';
import { runWithContext, newRequestId } from './common/request-context.js';

async function bootstrap() {
  const config = loadConfig();
  const adapter = new FastifyAdapter({ bodyLimit: 1024 * 1024 * 1024, trustProxy: true });

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    logger: new StructuredLogger(),
  });

  const fastify = app.getHttpAdapter().getInstance();

  // 请求上下文：为每个请求分配 requestId，贯穿全部日志（生产 P2）
  fastify.addHook('onRequest', (req, reply, done) => {
    const incoming = (req.headers['x-request-id'] as string | undefined)?.slice(0, 64);
    const requestId = incoming || newRequestId();
    reply.header('x-request-id', requestId);
    runWithContext({ requestId }, () => done());
  });

  // 安全响应头（生产 P2）。SPA 需要内联样式，故 CSP 放开 style-src 'unsafe-inline'。
  await fastify.register(import('@fastify/helmet'), {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'", ...(process.env.OIDC_ISSUER ? [new URL(process.env.OIDC_ISSUER).origin] : [])],
        frameSrc: ["'self'"], // 产物预览用同源 iframe
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    // 生产建议由反代统一开启 HSTS；此处仅在显式启用时生效
    hsts: process.env.ENABLE_HSTS === '1' ? { maxAge: 31536000, includeSubDomains: true } : false,
    crossOriginEmbedderPolicy: false, // 允许产物 iframe 预览
  });

  // 限流（生产 P2）：默认每 IP 每分钟 300 次；健康探针与 SSE 长连接豁免
  await fastify.register(import('@fastify/rate-limit'), {
    max: Number(process.env.RATE_LIMIT_MAX ?? 300),
    timeWindow: process.env.RATE_LIMIT_WINDOW ?? '1 minute',
    allowList: (req) =>
      req.url.startsWith('/healthz') ||
      req.url.startsWith('/readyz') ||
      req.url.includes('/events'),
    keyGenerator: (req) => (req.headers['x-forwarded-for'] as string) || req.ip,
  });

  // 文件上传
  await fastify.register(import('@fastify/multipart'), {
    limits: { fileSize: Number(process.env.MAX_UPLOAD_BYTES ?? 1024 * 1024 * 1024), files: 50 },
  });

  // CORS：生产应通过 ALLOWED_ORIGINS 显式指定，避免任意站点携带凭据调用
  const origins = (process.env.ALLOWED_ORIGINS ?? '').split(',').filter(Boolean);
  app.enableCors({ origin: origins.length ? origins : true, credentials: true });

  // 托管前端（单进程部署）
  if (process.env.SERVE_WEB === '1' && config.webDist && fs.existsSync(config.webDist)) {
    await fastify.register(import('@fastify/static'), {
      root: config.webDist,
      prefix: '/',
      wildcard: false,
    });
    const indexHtml = fs.readFileSync(`${config.webDist}/index.html`, 'utf8');
    fastify.get('/*', (req, reply) => {
      if (req.url.startsWith('/api')) return reply.code(404).send({ error: 'not found' });
      return reply.type('text/html').send(indexHtml);
    });
  }

  app.enableShutdownHooks(); // 优雅关闭：队列与 Redis 连接可正常释放

  await app.listen(config.port, '0.0.0.0');
  console.log(`\n  ✅ Apolla Work server → http://localhost:${config.port}`);
  console.log(
    `     执行器 ${config.executor} · 存储 ${config.storageDriver} · 队列 ${config.queueDriver} · 认证 ${config.authMode}\n`,
  );
}

bootstrap().catch((e) => {
  console.error('启动失败：', e);
  process.exit(1);
});
