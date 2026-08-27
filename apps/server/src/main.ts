import 'reflect-metadata';
import fs from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { loadConfig } from './config.js';

async function bootstrap() {
  const config = loadConfig();
  const adapter = new FastifyAdapter({ bodyLimit: 1024 * 1024 * 1024 });

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    logger: ['log', 'warn', 'error'],
  });

  const fastify = app.getHttpAdapter().getInstance();
  // 文件上传
  await fastify.register(import('@fastify/multipart'), {
    limits: { fileSize: 1024 * 1024 * 1024, files: 50 },
  });

  // 开发跨域（Vite dev server）
  app.enableCors({ origin: true, credentials: true });

  // 托管前端静态资源（opt-in：SERVE_WEB=1）。开发用 Vite（/api 反代到本服务），无需开启。
  // 生产可用本进程托管，或前置 nginx；SPA 深链回退用 Nest 层的 SpaController 兜底。
  if (process.env.SERVE_WEB === '1' && config.webDist && fs.existsSync(config.webDist)) {
    await fastify.register(import('@fastify/static'), {
      root: config.webDist,
      prefix: '/',
      wildcard: false,
    });
    // SPA 深链回退：非 /api、非静态资源的 GET 一律返回 index.html（客户端路由接管）。
    // 用裸 Fastify 通配路由而非 setNotFoundHandler（后者被 Nest 适配器占用）。
    const indexHtml = fs.readFileSync(`${config.webDist}/index.html`, 'utf8');
    fastify.get('/*', (req, reply) => {
      if (req.url.startsWith('/api')) return reply.code(404).send({ error: 'not found' });
      return reply.type('text/html').send(indexHtml);
    });
    console.log(`  📦 托管前端：${config.webDist}`);
  }

  await app.listen(config.port, '0.0.0.0');
  console.log(`\n  ✅ Apolla Work server → http://localhost:${config.port}`);
  console.log(`     执行器 ${config.executor} · 模型 ${config.model.name} · 认证 ${config.authMode}\n`);
}

bootstrap().catch((e) => {
  console.error('启动失败：', e);
  process.exit(1);
});
