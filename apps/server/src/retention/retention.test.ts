import { describe, expect, it, beforeEach } from 'vitest';
import { RetentionService } from './retention.service.js';
import type { AppConfig } from '../config.js';
import { verifyAuditArchive } from '../audit/audit-archive.js';

/**
 * 数据留存清理测试（生产合规）。
 * 删除是不可逆操作，必须证明：只删该删的、绝不碰运行中的任务、审计比任务活得久。
 */
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

class FakePrisma {
  tasks: { id: string; createdAt: Date; status: string }[] = [];
  events: { taskId: string }[] = [];
  approvals: { taskId: string }[] = [];
  artifacts: { taskId: string }[] = [];
  usage: { ts: Date }[] = [];
  audits: { ts: Date }[] = [];

  task = {
    findMany: async ({ where, take }: any) =>
      this.tasks
        .filter(
          (t) =>
            t.createdAt < where.createdAt.lt && where.status.in.includes(t.status),
        )
        .slice(0, take)
        .map((t) => ({ id: t.id })),
    deleteMany: async ({ where }: any) => {
      const n = this.tasks.filter((t) => where.id.in.includes(t.id)).length;
      this.tasks = this.tasks.filter((t) => !where.id.in.includes(t.id));
      return { count: n };
    },
  };
  taskEventRow = {
    count: async ({ where }: any) => this.events.filter((e) => where.taskId.in.includes(e.taskId)).length,
    deleteMany: async ({ where }: any) => {
      this.events = this.events.filter((e) => !where.taskId.in.includes(e.taskId));
      return { count: 0 };
    },
  };
  approval = {
    deleteMany: async ({ where }: any) => {
      this.approvals = this.approvals.filter((a) => !where.taskId.in.includes(a.taskId));
      return { count: 0 };
    },
  };
  artifact = {
    deleteMany: async ({ where }: any) => {
      this.artifacts = this.artifacts.filter((a) => !where.taskId.in.includes(a.taskId));
      return { count: 0 };
    },
  };
  usageRecord = {
    count: async ({ where }: any) => this.usage.filter((u) => u.ts < where.ts.lt).length,
    deleteMany: async ({ where }: any) => {
      this.usage = this.usage.filter((u) => !(u.ts < where.ts.lt));
      return { count: 0 };
    },
  };
  auditEvent = {
    count: async ({ where }: any) => this.audits.filter((a) => a.ts < where.ts.lt).length,
    findMany: async ({ where, take, skip }: any) =>
      this.audits
        .filter((a) => a.ts < where.ts.lt)
        .slice(skip ?? 0, (skip ?? 0) + (take ?? 1e9))
        .map((a, i) => ({ id: `a${i}`, actor: 'u', action: 'x', target: null, detail: null, ip: null, ts: a.ts })),
    deleteMany: async ({ where }: any) => {
      if (!this.inRetentionTx) throw new Error('AuditEvent 不可修改或删除（审计不可变，T-405）');
      this.audits = this.audits.filter((a) => !(a.ts < where.ts.lt));
      return { count: 0 };
    },
  };
  /** 复刻 DB 触发器：只有事务内 SET LOCAL apolla.retention_job='on' 后才允许删审计 */
  inRetentionTx = false;
  rawSql: string[] = [];
  $transaction = async (fn: (tx: FakePrisma) => Promise<void>) => {
    try {
      await fn(this);
    } finally {
      this.inRetentionTx = false;
    }
  };
  $executeRawUnsafe = async (sql: string) => {
    this.rawSql.push(sql);
    if (/apolla\.retention_job\s*=\s*'on'/.test(sql)) this.inRetentionTx = true;
    return 0;
  };
}

class FakeStorage {
  files = new Map<string, string>();
  exists = async (ws: string, rel: string) => this.files.has(`${ws}/${rel}`);
  readFile = async (ws: string, rel: string) => Buffer.from(this.files.get(`${ws}/${rel}`) ?? '');
  writeFile = async (ws: string, rel: string, data: Buffer | string) => {
    this.files.set(`${ws}/${rel}`, data.toString());
    return data.length;
  };
}

const cfg = (over: Partial<AppConfig['retention']> = {}) =>
  ({
    retention: { taskDays: 180, usageDays: 400, auditDays: 730, cron: '', tz: 'UTC', ...over },
  }) as AppConfig;

let db: FakePrisma;
let fs: FakeStorage;

beforeEach(() => {
  db = new FakePrisma();
  fs = new FakeStorage();
  // 旧的已完成任务（应删）
  db.tasks.push({ id: 'old-done', createdAt: daysAgo(200), status: 'completed' });
  db.events.push({ taskId: 'old-done' }, { taskId: 'old-done' });
  db.approvals.push({ taskId: 'old-done' });
  db.artifacts.push({ taskId: 'old-done' });
  // 旧但仍在运行的任务（绝不能删）
  db.tasks.push({ id: 'old-running', createdAt: daysAgo(200), status: 'running' });
  db.events.push({ taskId: 'old-running' });
  // 新任务（不该删）
  db.tasks.push({ id: 'new-done', createdAt: daysAgo(3), status: 'completed' });
  db.events.push({ taskId: 'new-done' });
  db.usage.push({ ts: daysAgo(500) }, { ts: daysAgo(10) });
  db.audits.push({ ts: daysAgo(800) }, { ts: daysAgo(100) });
});

const svc = (c = cfg()) => new RetentionService(db as never, fs as never, c);

describe('数据留存清理', () => {
  it('★ 绝不删除仍在运行的任务（即使很旧）', async () => {
    await svc().run(false);
    expect(db.tasks.map((t) => t.id)).toContain('old-running');
    expect(db.events.some((e) => e.taskId === 'old-running')).toBe(true);
  });

  it('★ 删除过期的已终结任务及其全部子表（事件/审批/产物）', async () => {
    const r = await svc().run(false);
    expect(r.tasks).toBe(1);
    expect(r.taskEvents).toBe(2);
    expect(db.tasks.map((t) => t.id)).not.toContain('old-done');
    expect(db.events.some((e) => e.taskId === 'old-done')).toBe(false);
    expect(db.approvals.length).toBe(0);
    expect(db.artifacts.length).toBe(0);
  });

  it('保留期内的任务不动', async () => {
    await svc().run(false);
    expect(db.tasks.map((t) => t.id)).toContain('new-done');
  });

  it('★ dryRun 只统计不删除（供管理员预览影响面）', async () => {
    const before = db.tasks.length;
    const r = await svc().run(true);
    expect(r.dryRun).toBe(true);
    expect(r.tasks).toBe(1); // 报告会删 1 个
    expect(db.tasks.length).toBe(before); // 但实际没删
  });

  it('★ 审计留存期独立且更长 —— 任务删了审计还在', async () => {
    await svc().run(false);
    // 800 天前的审计超过 730 天被删；100 天前的保留
    expect(db.audits.length).toBe(1);
    // 而 200 天前的任务已被删 —— 证明审计的生命周期独立于任务
    expect(db.tasks.map((t) => t.id)).not.toContain('old-done');
  });

  it('用量记录按自己的留存期清理（跨年对账）', async () => {
    await svc().run(false);
    expect(db.usage.length).toBe(1); // 500 天前的删，10 天前的留
  });

  it('★ 设为 0 表示永久保留，什么都不删', async () => {
    const r = await svc(cfg({ taskDays: 0, usageDays: 0, auditDays: 0 })).run(false);
    expect(r).toMatchObject({ tasks: 0, usageRecords: 0, auditEvents: 0 });
    expect(db.tasks.length).toBe(3);
    expect(db.audits.length).toBe(2);
  });

  it('★ 删除审计前先归档为哈希链 JSONL，并更新链头（T-405）', async () => {
    await svc().run(false);
    const archives = [...fs.files.keys()].filter((k) => k.endsWith('.jsonl'));
    expect(archives).toHaveLength(1);
    expect(archives[0]).toMatch(/^_system\/audit-archive\/\d{4}-\d{2}\/audit-.*\.jsonl$/);
    const v = verifyAuditArchive(fs.files.get(archives[0]!)!);
    expect(v.ok).toBe(true);
    expect(v.count).toBe(1); // 只归档了 800 天前那一条
    const head = JSON.parse(fs.files.get('_system/audit-archive/chain.json')!);
    expect(head.lastHash).toBe(v.lastHash);
  });

  it('★ 审计删除只在声明 retention_job 的事务内执行 —— 否则 DB 触发器拒绝', async () => {
    await svc().run(false);
    expect(db.rawSql.some((s) => /SET LOCAL apolla\.retention_job = 'on'/.test(s))).toBe(true);
    expect(db.audits.length).toBe(1);
  });

  it('第二批归档接上第一批的链头', async () => {
    await svc().run(false);
    const first = JSON.parse(fs.files.get('_system/audit-archive/chain.json')!).lastHash as string;
    db.audits.push({ ts: daysAgo(900) });
    await svc().run(false);
    const files = [...fs.files.keys()].filter((k) => k.endsWith('.jsonl')).sort();
    expect(files).toHaveLength(2);
    expect(verifyAuditArchive(fs.files.get(files[1]!)!, first).ok).toBe(true);
  });

  it('dryRun 不归档、不删除', async () => {
    await svc().run(true);
    expect([...fs.files.keys()]).toHaveLength(0);
    expect(db.audits.length).toBe(2);
  });

  it('policy() 暴露当前策略供管理后台展示', () => {
    const p = svc().policy();
    expect(p.taskDays).toBe(180);
    expect(p.auditDays).toBe(730);
  });
});
