import 'reflect-metadata';
import fs from 'node:fs';
import path from 'node:path';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { loadConfig } from './config.js';
import { StructuredLogger } from './common/logger.js';
import { runWithContext, newRequestId } from './common/request-context.js';
import { runPreflight } from './common/preflight.js';

async function bootstrap() {
  const config = loadConfig();

  // 生产就绪检查：带着开发默认值上生产会直接拒绝启动。
  // 即便显式豁免（ALLOW_INSECURE_PRODUCTION=1）也照常执行并记录，只是不抛错 ——
  // 静默跳过等于把安全闸门变成隐形开关。
  runPreflight(config);
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
    const indexPath = `${config.webDist}/index.html`;
    let cached = { html: fs.readFileSync(indexPath, 'utf8'), mtime: 0 };
    // 就地更新 dist（共享卷、滚动发布）后仍返回启动时缓存的 HTML，会指向已被
    // 删除的 hash 资源 —— 故按 mtime 失效重读；读失败则沿用上一份，不让首页挂掉。
    const readIndex = () => {
      try {
        const m = fs.statSync(indexPath).mtimeMs;
        if (m !== cached.mtime) cached = { html: fs.readFileSync(indexPath, 'utf8'), mtime: m };
      } catch {
        /* 保留上一份 */
      }
      return cached.html;
    };
    fastify.get('/*', (req, reply) => {
      const p = req.url.split('?')[0];
      // 只有「页面导航」才回落到 SPA。带扩展名的静态资源必须真 404：
      // 否则滚动发布后，浏览器拿着已缓存的旧 index.html 去请求早已删除的 hash 资源，
      // 会收到 200 + text/html，模块脚本 MIME 校验失败 → 整页白屏，
      // 且这条兜底会把所有静态资源的 404 一并掩盖成 200，线上极难排查。
      if (p.startsWith('/api') || path.extname(p)) {
        return reply.code(404).send({ error: 'not found' });
      }
      return reply.type('text/html').send(readIndex());
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
