import { describe, expect, it } from 'vitest';
import { GENESIS, archiveFileName, buildAuditArchive, verifyAuditArchive, type AuditRow } from './audit-archive.js';

/** 审计归档哈希链（T-405）：删除前先归档，归档本身可校验、可跨批次接链 */
const rows: AuditRow[] = [
  { id: 'a1', actor: 'u1', action: 'task.create', target: 't1', detail: null, ip: '10.0.0.1', ts: new Date('2026-01-01T00:00:00Z') },
  { id: 'a2', actor: 'u1', action: 'approval.approve', target: 'ap1', detail: '{"scope":"once"}', ip: null, ts: '2026-01-01T00:01:00.000Z' },
  { id: 'a3', actor: 'admin', action: 'model.update', target: 'm1', detail: 'apiKey rotated', ip: '10.0.0.2', ts: new Date('2026-01-02T00:00:00Z') },
];

describe('审计归档哈希链', () => {
  it('★ 归档可被完整校验，lastHash 与行数一致', () => {
    const a = buildAuditArchive(rows);
    expect(a.count).toBe(3);
    const v = verifyAuditArchive(a.body);
    expect(v).toEqual({ ok: true, count: 3, lastHash: a.lastHash });
  });

  it('★ 改动任意一行（哪怕一个字符）校验即失败并定位到该行', () => {
    const a = buildAuditArchive(rows);
    const lines = a.body.trim().split('\n');
    lines[1] = lines[1]!.replace('approval.approve', 'approval.deny');
    const v = verifyAuditArchive(lines.join('\n') + '\n');
    expect(v.ok).toBe(false);
    expect(v.brokenAt).toBe(1);
  });

  it('★ 删掉中间一行 / 插入伪造行 均被发现', () => {
    const a = buildAuditArchive(rows);
    const lines = a.body.trim().split('\n');
    expect(verifyAuditArchive([lines[0], lines[2]].join('\n')).ok).toBe(false);
    const forged = JSON.stringify({ ...JSON.parse(lines[0]!), id: 'zz' });
    expect(verifyAuditArchive([lines[0], forged, lines[1], lines[2]].join('\n')).ok).toBe(false);
  });

  it('批与批之间接链：第二批以第一批 lastHash 为起点，用错起点校验失败', () => {
    const b1 = buildAuditArchive(rows.slice(0, 2));
    const b2 = buildAuditArchive(rows.slice(2), b1.lastHash);
    expect(verifyAuditArchive(b2.body, b1.lastHash).ok).toBe(true);
    expect(verifyAuditArchive(b2.body, GENESIS).ok).toBe(false);
  });

  it('空批次：空文件，lastHash 不变', () => {
    const a = buildAuditArchive([], 'abc');
    expect(a).toEqual({ body: '', lastHash: 'abc', count: 0 });
    expect(verifyAuditArchive('', 'abc')).toEqual({ ok: true, count: 0, lastHash: 'abc' });
  });

  it('ts 无论 Date 还是 ISO 字符串，规范化后哈希一致（回读再校验不会因类型漂移失败）', () => {
    const asDate = buildAuditArchive([rows[0]!]);
    const asString = buildAuditArchive([{ ...rows[0]!, ts: '2026-01-01T00:00:00.000Z' }]);
    expect(asDate.lastHash).toBe(asString.lastHash);
  });

  it('归档文件按截止月份归置', () => {
    expect(archiveFileName(new Date('2026-09-06T03:00:00Z'), new Date('2024-09-05T00:00:00Z'), 'abc123')).toBe(
      'audit-archive/2024-09/audit-2026-09-06T03-00-00-000Z-abc123.jsonl',
    );
    // 同一毫秒两批不同名
    const now = new Date();
    expect(archiveFileName(now, now)).not.toBe(archiveFileName(now, now));
  });
});
