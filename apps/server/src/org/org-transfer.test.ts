import { describe, expect, it } from 'vitest';
import { ORG_TABLES, exportOrg, fromJsonl, importOrg, toJsonl, type TransferPrisma } from './org-transfer.js';

/**
 * 组织迁移（T-418）：只导本组织的行、依赖顺序正确、JSONL 往返、幂等导入、双租户零串扰。
 * 用内存假 Prisma：每个表一个数组，findMany 支持 eq / in 过滤，upsert 按 id。
 */
function fakePrisma(seed: Record<string, Record<string, unknown>[]> = {}) {
  const tables: Record<string, Record<string, unknown>[]> = {};
  const prisma: TransferPrisma = {};
  for (const t of ORG_TABLES) {
    const name = t[0]!.toLowerCase() + t.slice(1);
    tables[t] = [...(seed[t] ?? [])];
    prisma[name] = {
      findMany: async ({ where = {} }) =>
        tables[t]!.filter((row) =>
          Object.entries(where).every(([k, v]) => {
            const val = row[k];
            if (v && typeof v === 'object' && 'in' in (v as object)) return ((v as { in: unknown[] }).in as unknown[]).includes(val);
            return val === v;
          }),
        ),
      upsert: async ({ where, create, update }) => {
        const idx = tables[t]!.findIndex((r) => r.id === where.id);
        if (idx >= 0) tables[t]![idx] = { ...tables[t]![idx], ...update };
        else tables[t]!.push(create);
        return tables[t]![idx >= 0 ? idx : tables[t]!.length - 1];
      },
    };
  }
  return { prisma, tables };
}

const seed = {
  Org: [{ id: 'o1', name: 'A 公司', createdAt: '2026-01-01T00:00:00.000Z' }, { id: 'o2', name: 'B 公司', createdAt: '2026-01-01T00:00:00.000Z' }],
  User: [{ id: 'u1', email: 'a@a.com', name: 'A' }, { id: 'u2', email: 'b@b.com', name: 'B' }, { id: 'u3', email: 'both@x.com', name: 'X' }],
  Membership: [{ id: 'm1', orgId: 'o1', userId: 'u1', role: 'admin' }, { id: 'm2', orgId: 'o2', userId: 'u2', role: 'admin' }, { id: 'm3', orgId: 'o1', userId: 'u3', role: 'member' }],
  Workspace: [{ id: 'w1', orgId: 'o1', name: 'A-ws' }, { id: 'w2', orgId: 'o2', name: 'B-ws' }],
  WorkspaceMember: [{ id: 'wm1', workspaceId: 'w1', userId: 'u1', role: 'owner' }, { id: 'wm2', workspaceId: 'w2', userId: 'u2', role: 'owner' }],
  Session: [{ id: 's1', workspaceId: 'w1', title: 'a' }, { id: 's2', workspaceId: 'w2', title: 'b' }],
  Task: [{ id: 't1', sessionId: 's1', prompt: 'p1', createdAt: '2026-02-01T00:00:00.000Z' }, { id: 't2', sessionId: 's2', prompt: 'p2', createdAt: '2026-02-01T00:00:00.000Z' }],
  TaskEventRow: [{ id: 'e1', taskId: 't1', seq: 1, type: 'x', payload: '{}', ts: '2026-02-01T00:00:01.000Z' }, { id: 'e2', taskId: 't2', seq: 1, type: 'x', payload: '{}', ts: '2026-02-01T00:00:01.000Z' }],
  Artifact: [{ id: 'ar1', taskId: 't1', path: 'a.csv' }],
  FileEntry: [{ id: 'f1', workspaceId: 'w1', path: 'a.csv' }, { id: 'f2', workspaceId: 'w2', path: 'b.csv' }],
  Policy: [{ id: 'p1', orgId: 'o1', kind: 'bash_command', pattern: 'x', reason: 'r' }],
  ApiKey: [{ id: 'k1', orgId: 'o2', name: 'b-key', prefix: 'bbbbbbbb', hash: 'h' }],
};

describe('exportOrg', () => {
  it('★ 只导出本组织的行：另一租户的用户/空间/任务/密钥一律不出现（零串扰）', async () => {
    const { prisma } = fakePrisma(seed);
    const lines = await exportOrg(prisma, 'o1');
    const ids = lines.map((l) => `${l.table}:${l.row.id}`);
    expect(ids).toEqual(expect.arrayContaining(['Org:o1', 'User:u1', 'User:u3', 'Membership:m1', 'Workspace:w1', 'Session:s1', 'Task:t1', 'TaskEventRow:e1', 'Artifact:ar1', 'FileEntry:f1', 'Policy:p1']));
    for (const forbidden of ['Org:o2', 'User:u2', 'Workspace:w2', 'Task:t2', 'TaskEventRow:e2', 'FileEntry:f2', 'ApiKey:k1', 'Membership:m2']) {
      expect(ids).not.toContain(forbidden);
    }
  });

  it('依赖顺序：父表先于子表（导入时外键不悬空）', async () => {
    const { prisma } = fakePrisma(seed);
    const order = (await exportOrg(prisma, 'o1')).map((l) => l.table);
    const pos = (t: string) => order.indexOf(t as never);
    expect(pos('Org')).toBeLessThan(pos('Membership'));
    expect(pos('User')).toBeLessThan(pos('Membership'));
    expect(pos('Workspace')).toBeLessThan(pos('Session'));
    expect(pos('Session')).toBeLessThan(pos('Task'));
    expect(pos('Task')).toBeLessThan(pos('TaskEventRow'));
  });

  it('组织不存在 → 报错', async () => {
    await expect(exportOrg(fakePrisma(seed).prisma, 'nope')).rejects.toThrow('组织不存在');
  });
});

describe('JSONL 往返 + importOrg', () => {
  it('★ 导出 → JSONL → 导入空库：行数一致，日期字段还原为 Date；重复导入幂等', async () => {
    const src = fakePrisma(seed);
    const lines = await exportOrg(src.prisma, 'o1');
    const text = toJsonl(lines);
    const parsed = fromJsonl(text);
    expect(parsed).toHaveLength(lines.length);

    const dst = fakePrisma();
    const counts = await importOrg(dst.prisma, parsed);
    expect(counts.Org).toBe(1);
    expect(counts.Task).toBe(1);
    expect(dst.tables.Task![0]!.createdAt).toBeInstanceOf(Date);
    expect(dst.tables.TaskEventRow![0]!.ts).toBeInstanceOf(Date);
    expect(dst.tables.Task![0]!.prompt).toBe('p1'); // 非日期字段不动

    await importOrg(dst.prisma, parsed); // 再导一次
    expect(dst.tables.Task).toHaveLength(1);
    expect(dst.tables.User).toHaveLength(2);
  });

  it('未知表 / 缺 id 拒绝导入', () => {
    expect(() => fromJsonl('{"table":"AuditEvent","row":{"id":"x"}}\n')).toThrow('未知表');
    const dst = fakePrisma();
    return expect(importOrg(dst.prisma, [{ table: 'Org', row: { name: 'no-id' } }])).rejects.toThrow('缺少 id');
  });

  it('审计事件不在导出范围内（不可变，属源实例合规记录）', () => {
    expect(ORG_TABLES).not.toContain('AuditEvent' as never);
  });
});
