import 'dotenv/config';

/** 运行时配置（PRD §12：一切可离线、可切驱动） */
export interface AppConfig {
  port: number;
  storageDriver: 'fs' | 's3';
  storageDir: string;
  s3: { endpoint: string; accessKey: string; secretKey: string; bucket: string };
  executor: 'local' | 'docker';
  sandboxImage: string;
  queueDriver: 'inproc' | 'bullmq';
  redisUrl: string;
  /** 多副本部署：事件经 Redis 跨副本分发、队列用 BullMQ 分布式派发 */
  clusterMode: boolean;
  /** 单副本最大并发任务数 */
  maxConcurrent: number;
  /** 单任务上限：墙钟时长与 token 预算（0=不限），防失控任务占容量/烧预算 */
  taskLimits: { maxDurationMs: number; maxTokens: number };
  authMode: 'dev' | 'oidc';
  /** 多租户（T-418）：JIT 建户按 IdP 的 org 声明 / 邮箱域名归入各自组织；关闭则全部进单一组织 */
  multiTenant: boolean;
  model: { name: string; baseUrl?: string; apiKey?: string };
  /** 分档模型路由（auto/fast/deep → 模型名）；缺省回落到 model.name */
  modelTiers: { fast?: string; deep?: string };
  /** 月度 token 配额（0 = 不限制） */
  quota: { orgMonthlyTokens: number; userMonthlyTokens: number };
  /** 数据留存（天；0 = 永久保留）。空 cron = 不启用自动清理 */
  retention: { taskDays: number; usageDays: number; auditDays: number; cron: string; tz: string };
  webfetchAllowlist: string[];
  searxngUrl?: string;
  skillRoots: string[];
  /** 技能市场安装目录。多副本必须指向共享卷，否则 A 副本装的技能 B 副本看不到 */
  installedSkillsDir: string;
  /** 运维显式声明 installedSkillsDir 已在共享存储上（NFS / RWX PVC） */
  skillsShared: boolean;
  webDist?: string;
}

import path from 'node:path';

export function loadConfig(): AppConfig {
  const root = path.resolve(process.cwd());
  const storageDir = path.resolve(process.env.STORAGE_DIR ?? './data/storage');
  // 允许把技能目录单独指到共享卷：对象存储只解决工作区文件，不覆盖技能包
  const installedSkillsDir = path.resolve(
    process.env.SKILLS_DIR ?? path.join(storageDir, 'installed-skills'),
  );
  return {
    port: Number(process.env.SERVER_PORT ?? 3001),
    storageDriver: (process.env.STORAGE_DRIVER as 'fs' | 's3') ?? 'fs',
    storageDir,
    s3: {
      endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9010',
      accessKey: process.env.S3_ACCESS_KEY ?? 'apolla',
      secretKey: process.env.S3_SECRET_KEY ?? 'apolla-secret',
      bucket: process.env.S3_BUCKET ?? 'apolla',
    },
    executor: (process.env.EXECUTOR as 'local' | 'docker') ?? 'local',
    sandboxImage: process.env.SANDBOX_IMAGE ?? 'apolla-sandbox:dev',
    queueDriver: (process.env.QUEUE_DRIVER as 'inproc' | 'bullmq') ?? 'inproc',
    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6390',
    clusterMode:
      process.env.CLUSTER_MODE === '1' || (process.env.QUEUE_DRIVER ?? 'inproc') === 'bullmq',
    maxConcurrent: Number(process.env.MAX_CONCURRENT_TASKS ?? 20),
    taskLimits: {
      maxDurationMs: Number(process.env.TASK_MAX_DURATION_MS ?? 30 * 60_000),
      maxTokens: Number(process.env.TASK_MAX_TOKENS ?? 300_000),
    },
    authMode: (process.env.AUTH_MODE as 'dev' | 'oidc') ?? 'dev',
    multiTenant: process.env.MULTI_TENANT === '1',
    model: {
      name: process.env.MODEL_DEFAULT ?? 'mock',
      baseUrl: process.env.MODEL_BASE_URL,
      apiKey: process.env.MODEL_API_KEY,
    },
    modelTiers: { fast: process.env.MODEL_FAST, deep: process.env.MODEL_DEEP },
    quota: {
      orgMonthlyTokens: Number(process.env.QUOTA_ORG_MONTHLY_TOKENS ?? 0),
      userMonthlyTokens: Number(process.env.QUOTA_USER_MONTHLY_TOKENS ?? 0),
    },
    retention: {
      taskDays: Number(process.env.RETENTION_TASK_DAYS ?? 180),
      usageDays: Number(process.env.RETENTION_USAGE_DAYS ?? 400),
      auditDays: Number(process.env.RETENTION_AUDIT_DAYS ?? 730),
      cron: process.env.RETENTION_CRON ?? '',
      tz: process.env.RETENTION_TZ ?? 'Asia/Shanghai',
    },
    webfetchAllowlist: (process.env.WEBFETCH_ALLOWLIST ?? '').split(',').filter(Boolean),
    searxngUrl: process.env.SEARXNG_URL || undefined,
    installedSkillsDir,
    skillsShared: process.env.SKILLS_SHARED === '1',
    skillRoots: [
      path.resolve(root, 'skills'),
      path.resolve(root, '../../skills'),
      installedSkillsDir,
    ],
    webDist: process.env.WEB_DIST ?? path.resolve(root, '../web/dist'),
  };
}

export const CONFIG = Symbol('APP_CONFIG');
