import 'dotenv/config';

/** 运行时配置（PRD §12：一切可离线、可切驱动） */
export interface AppConfig {
  port: number;
  storageDriver: 'fs' | 's3';
  storageDir: string;
  executor: 'local' | 'docker';
  sandboxImage: string;
  queueDriver: 'inproc' | 'bullmq';
  redisUrl: string;
  authMode: 'dev' | 'oidc';
  model: { name: string; baseUrl?: string; apiKey?: string };
  webfetchAllowlist: string[];
  searxngUrl?: string;
  skillRoots: string[];
  webDist?: string;
}

import path from 'node:path';

export function loadConfig(): AppConfig {
  const root = path.resolve(process.cwd());
  return {
    port: Number(process.env.SERVER_PORT ?? 3001),
    storageDriver: (process.env.STORAGE_DRIVER as 'fs' | 's3') ?? 'fs',
    storageDir: path.resolve(process.env.STORAGE_DIR ?? './data/storage'),
    executor: (process.env.EXECUTOR as 'local' | 'docker') ?? 'local',
    sandboxImage: process.env.SANDBOX_IMAGE ?? 'apolla-sandbox:dev',
    queueDriver: (process.env.QUEUE_DRIVER as 'inproc' | 'bullmq') ?? 'inproc',
    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6390',
    authMode: (process.env.AUTH_MODE as 'dev' | 'oidc') ?? 'dev',
    model: {
      name: process.env.MODEL_DEFAULT ?? 'mock',
      baseUrl: process.env.MODEL_BASE_URL,
      apiKey: process.env.MODEL_API_KEY,
    },
    webfetchAllowlist: (process.env.WEBFETCH_ALLOWLIST ?? '').split(',').filter(Boolean),
    searxngUrl: process.env.SEARXNG_URL || undefined,
    skillRoots: [path.resolve(root, 'skills'), path.resolve(root, '../../skills')],
    webDist: process.env.WEB_DIST ?? path.resolve(root, '../web/dist'),
  };
}

export const CONFIG = Symbol('APP_CONFIG');
