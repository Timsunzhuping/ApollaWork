import path from 'node:path';
import type { ModelSettings } from './types.js';

export interface BuildServerEnvOptions {
  /** server 监听端口（注入为 SERVER_PORT） */
  port: number;
  /** Electron userData 目录（放 SQLite / storage / settings） */
  userDataDir: string;
  /** 前端静态资源目录（注入为 WEB_DIST） */
  webDist: string;
  /** 用户模型设置 */
  settings: ModelSettings;
  /** 基础环境，默认 process.env */
  base?: NodeJS.ProcessEnv;
}

/** SQLite 数据库文件的绝对路径。 */
export function databaseFile(userDataDir: string): string {
  return path.join(userDataDir, 'apolla.db');
}

/** 组装拉起 server 子进程所需的环境变量（本地执行模式）。 */
export function buildServerEnv(opts: BuildServerEnvOptions): NodeJS.ProcessEnv {
  const base = opts.base ?? process.env;
  const storageDir = path.join(opts.userDataDir, 'storage');
  const dbFile = databaseFile(opts.userDataDir);

  const env: NodeJS.ProcessEnv = {
    ...base,
    // —— 本地执行模式（PRD §12）：一切离线、零外部依赖 ——
    SERVE_WEB: '1', // 让 server 用 @fastify/static 托管 apps/web/dist
    EXECUTOR: 'local', // 子进程执行器，不需要 Docker
    STORAGE_DRIVER: 'fs', // 本地文件存储
    QUEUE_DRIVER: 'inproc', // 进程内队列，不需要 Redis
    AUTH_MODE: 'dev', // 免登录本地管理员（seed 建的 dev 用户）
    SERVER_PORT: String(opts.port),
    STORAGE_DIR: storageDir,
    WEB_DIST: opts.webDist,
    // Prisma 数据源用绝对路径，避免相对 file: 被解析到 schema 目录
    DATABASE_URL_PRISMA: `file:${dbFile}`,
    // 让 Electron 主进程二进制以纯 Node 方式运行 server（打包态 execPath 是 Electron）
    ELECTRON_RUN_AS_NODE: '1',
  };

  // 模型：优先用户设置，其次已有环境，最后回落 mock（无需 LLM 也能跑通链路）
  env.MODEL_DEFAULT = opts.settings.MODEL_DEFAULT || base.MODEL_DEFAULT || 'mock';
  const baseUrl = opts.settings.MODEL_BASE_URL || base.MODEL_BASE_URL;
  const apiKey = opts.settings.MODEL_API_KEY || base.MODEL_API_KEY;
  if (baseUrl) env.MODEL_BASE_URL = baseUrl;
  if (apiKey) env.MODEL_API_KEY = apiKey;

  return env;
}
