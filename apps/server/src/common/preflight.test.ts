import { describe, expect, it } from 'vitest';
import { preflightCheck, preflightWarnings } from './preflight.js';
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
  taskLimits: { maxDurationMs: 1_800_000, maxTokens: 300_000 },
  authMode: 'oidc',
  model: { name: 'qwen', baseUrl: 'http://litellm/v1' },
  modelTiers: {},
  quota: { orgMonthlyTokens: 0, userMonthlyTokens: 0 },
  retention: { taskDays: 180, usageDays: 400, auditDays: 730, cron: '', tz: 'Asia/Shanghai' },
  webfetchAllowlist: [],
  skillRoots: [],
  installedSkillsDir: '/shared/installed-skills',
  skillsShared: true,
  multiTenant: false,
};

describe('生产就绪检查（防止带开发默认值上线）', () => {
  it('合规的单副本配置：无问题', () => {
    process.env.APOLLA_MASTER_KEY = 'a-real-random-key';
    process.env.ALLOWED_ORIGINS = 'https://apolla.corp.com';
    const single = { ...prodSafe, clusterMode: false, queueDriver: 'inproc' as const };
    expect(preflightCheck(single)).toEqual([]);
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

  it('★ 拦截多副本下未声明共享的技能安装目录（否则技能时有时无）', () => {
    const issues = preflightCheck({ ...prodSafe, skillsShared: false });
    expect(issues.map((i) => i.key)).toContain('SKILLS_VOLUME');
  });

  it('★ 声明 SKILLS_SHARED 后该项即通过 —— 检查必须能被「配置正确」满足', () => {
    const issues = preflightCheck(prodSafe);
    expect(issues.map((i) => i.key)).not.toContain('SKILLS_VOLUME');
  });

  it('★ 全生产配置零告警：闸门可满足，不必开 ALLOW_INSECURE_PRODUCTION', () => {
    // 回归：曾经该项恒定触发，运维只能靠豁免开关启动，
    // 而豁免会把其余所有检查一并放行 —— 闸门反而变成安全缺口。
    expect(preflightCheck(prodSafe)).toEqual([]);
  });

  it('单副本不提示技能共享卷', () => {
    const issues = preflightCheck({
      ...prodSafe, clusterMode: false, queueDriver: 'inproc', skillsShared: false });
    expect(issues.map((i) => i.key)).not.toContain('SKILLS_VOLUME');
  });

  it('多副本 + fs 驱动同样需要共享技能目录（与存储驱动无关）', () => {
    const issues = preflightCheck({ ...prodSafe, storageDriver: 'fs', skillsShared: false });
    expect(issues.map((i) => i.key)).toContain('SKILLS_VOLUME');
  });

  it('★ 拦截未限制的 CORS', () => {
    delete process.env.ALLOWED_ORIGINS;
    expect(preflightCheck(prodSafe).map((i) => i.key)).toContain('ALLOWED_ORIGINS');
    process.env.ALLOWED_ORIGINS = 'https://apolla.corp.com';
  });

  it('生产未开病毒扫描 → 非阻断告警；开了则无告警（T-404）', () => {
    expect(preflightWarnings({}).map((w) => w.key)).toContain('UPLOAD_SCAN');
    expect(preflightWarnings({ UPLOAD_SCAN: 'clamav' })).toEqual([]);
  });

  it('每条问题都给出可执行的修复建议', () => {
    const issues = preflightCheck({ ...prodSafe, authMode: 'dev', executor: 'local' });
    for (const i of issues) {
      expect(i.fix.length).toBeGreaterThan(10);
      expect(i.problem.length).toBeGreaterThan(10);
    }
  });
});
