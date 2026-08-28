import { Logger } from '@nestjs/common';
import type { AppConfig } from '../config.js';

/**
 * 生产上线前置校验（生产 P2）。
 * 目的：杜绝「带着开发默认值上生产」这类事故 —— 免登录、宿主执行、
 * 默认主密钥、本地盘存储在生产环境都是严重问题。
 *
 * NODE_ENV=production 时任一项不达标即拒绝启动（fail fast）；
 * 非生产环境只告警，不阻断开发体验。
 */
export interface PreflightIssue {
  key: string;
  problem: string;
  fix: string;
}

const DEFAULT_MASTER_KEY = 'apolla-dev-insecure-master-key-change-me';

export function preflightCheck(config: AppConfig): PreflightIssue[] {
  const issues: PreflightIssue[] = [];

  if (config.authMode === 'dev') {
    issues.push({
      key: 'AUTH_MODE',
      problem: 'dev 模式免登录，任何能访问端口的人都是管理员',
      fix: '设 AUTH_MODE=oidc 并配置 OIDC_ISSUER / OIDC_CLIENT_ID',
    });
  }

  if (config.executor === 'local') {
    issues.push({
      key: 'EXECUTOR',
      problem: 'local 执行器在 server 进程内直接跑 Bash，等于把宿主 shell 开放给所有用户',
      fix: '设 EXECUTOR=docker 并构建 SANDBOX_IMAGE（infra/sandbox）',
    });
  }

  if ((process.env.APOLLA_MASTER_KEY ?? DEFAULT_MASTER_KEY) === DEFAULT_MASTER_KEY) {
    issues.push({
      key: 'APOLLA_MASTER_KEY',
      problem: '仍在使用默认主密钥，连接器与模型密钥等同于明文存储',
      fix: '生成随机主密钥并通过环境注入（openssl rand -hex 32）',
    });
  }

  if (config.storageDriver === 'fs' && config.clusterMode) {
    issues.push({
      key: 'STORAGE_DRIVER',
      problem: '多副本部署下使用本地文件存储，副本之间看不到彼此的文件',
      fix: '设 STORAGE_DRIVER=s3 并配置 MinIO/S3',
    });
  }

  if (config.clusterMode && config.queueDriver !== 'bullmq') {
    issues.push({
      key: 'QUEUE_DRIVER',
      problem: '集群模式下仍用进程内队列，任务无法在副本间均衡且副本宕机会丢任务',
      fix: '设 QUEUE_DRIVER=bullmq 并配置 REDIS_URL',
    });
  }

  if (!process.env.ALLOWED_ORIGINS) {
    issues.push({
      key: 'ALLOWED_ORIGINS',
      problem: 'CORS 允许任意来源携带凭据',
      fix: '设 ALLOWED_ORIGINS 为明确的站点，如 https://apolla.corp.com',
    });
  }

  return issues;
}

/** 打印结果；生产环境有问题则抛错阻断启动。 */
export function runPreflight(config: AppConfig) {
  const log = new Logger('Preflight');
  const issues = preflightCheck(config);
  const isProd = process.env.NODE_ENV === 'production';

  if (issues.length === 0) {
    log.log('生产就绪检查：全部通过 ✅');
    return;
  }

  for (const i of issues) {
    const msg = `[${i.key}] ${i.problem} —— 处理：${i.fix}`;
    isProd ? log.error(msg) : log.warn(msg);
  }

  if (isProd) {
    throw new Error(
      `生产就绪检查未通过（${issues.length} 项）。请修正上述配置后重启；` +
        `确需以当前配置启动，请显式设置 ALLOW_INSECURE_PRODUCTION=1。`,
    );
  }
  log.warn(`生产就绪检查：${issues.length} 项待处理（开发环境仅告警）`);
}
