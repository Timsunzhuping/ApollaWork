import { describe, expect, it } from 'vitest';
import { preflightCheck } from './preflight.js';
import type { AppConfig } from '../config.js';

const prodSafe: AppConfig = {
  port: 3001,
  storageDriver: 's3',
  storageDir: '/data',
  s3: { endpoint: 'http://minio:9000', accessKey: 'k', secretKey: 's', bucket: 'apolla' },
  executor: 'docker',
  sandboxImage: 'apolla-sandbox:1.0',
  queueDriver: 'bullmq',
  redisUrl: 'redis://valkey:6379',
  clusterMode: true,
  maxConcurrent: 20,
  authMode: 'oidc',
  model: { name: 'qwen', baseUrl: 'http://litellm/v1' },
  modelTiers: {},
  quota: { orgMonthlyTokens: 0, userMonthlyTokens: 0 },
  webfetchAllowlist: [],
  skillRoots: [],
};

describe('生产就绪检查（防止带开发默认值上线）', () => {
  it('合规配置：无问题', () => {
    process.env.APOLLA_MASTER_KEY = 'a-real-random-key';
    process.env.ALLOWED_ORIGINS = 'https://apolla.corp.com';
    expect(preflightCheck(prodSafe)).toEqual([]);
  });

  it('★ 拦截免登录（AUTH_MODE=dev）', () => {
    const issues = preflightCheck({ ...prodSafe, authMode: 'dev' });
    expect(issues.map((i) => i.key)).toContain('AUTH_MODE');
  });

  it('★ 拦截宿主执行（EXECUTOR=local）', () => {
    const issues = preflightCheck({ ...prodSafe, executor: 'local' });
    expect(issues.map((i) => i.key)).toContain('EXECUTOR');
  });

  it('★ 拦截默认主密钥', () => {
    process.env.APOLLA_MASTER_KEY = 'apolla-dev-insecure-master-key-change-me';
    expect(preflightCheck(prodSafe).map((i) => i.key)).toContain('APOLLA_MASTER_KEY');
    process.env.APOLLA_MASTER_KEY = 'a-real-random-key';
  });

  it('★ 拦截「多副本 + 本地文件存储」这种会丢文件的组合', () => {
    const issues = preflightCheck({ ...prodSafe, storageDriver: 'fs' });
    expect(issues.map((i) => i.key)).toContain('STORAGE_DRIVER');
  });

  it('★ 拦截「集群模式 + 进程内队列」', () => {
    const issues = preflightCheck({ ...prodSafe, queueDriver: 'inproc' });
    expect(issues.map((i) => i.key)).toContain('QUEUE_DRIVER');
  });

  it('★ 拦截未限制的 CORS', () => {
    delete process.env.ALLOWED_ORIGINS;
    expect(preflightCheck(prodSafe).map((i) => i.key)).toContain('ALLOWED_ORIGINS');
    process.env.ALLOWED_ORIGINS = 'https://apolla.corp.com';
  });

  it('每条问题都给出可执行的修复建议', () => {
    const issues = preflightCheck({ ...prodSafe, authMode: 'dev', executor: 'local' });
    for (const i of issues) {
      expect(i.fix.length).toBeGreaterThan(10);
      expect(i.problem.length).toBeGreaterThan(10);
    }
  });
});
