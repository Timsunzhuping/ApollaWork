import { createHash, randomBytes } from 'node:crypto';

/** 审计行（与 Prisma AuditEvent 字段一致；ts 允许字符串以便从 JSONL 回读） */
export interface AuditRow {
  id: string;
  actor: string;
  action: string;
  target?: string | null;
  detail?: string | null;
  ip?: string | null;
  ts: Date | string;
}

export const GENESIS = 'GENESIS';

const canonical = (r: AuditRow) =>
  JSON.stringify([r.id, r.actor, r.action, r.target ?? null, r.detail ?? null, r.ip ?? null, toIso(r.ts)]);
const toIso = (ts: Date | string) => (ts instanceof Date ? ts.toISOString() : new Date(ts).toISOString());
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * 把一批审计行归档为 JSONL（T-405）。每行带 prev / h 两个字段构成哈希链：
 * h = sha256(prev + 行的规范化 JSON)。任何一行被改、删、插，后续全部哈希都对不上。
 * prevHash 传上一批归档的 lastHash，批与批之间也连成一条链。
 */
export function buildAuditArchive(rows: AuditRow[], prevHash = GENESIS): { body: string; lastHash: string; count: number } {
  let prev = prevHash;
  const lines: string[] = [];
  for (const r of rows) {
    const h = sha256(prev + canonical(r));
    lines.push(
      JSON.stringify({
        id: r.id,
        actor: r.actor,
        action: r.action,
        target: r.target ?? null,
        detail: r.detail ?? null,
        ip: r.ip ?? null,
        ts: toIso(r.ts),
        prev,
        h,
      }),
    );
    prev = h;
  }
  return { body: lines.length ? lines.join('\n') + '\n' : '', lastHash: prev, count: rows.length };
}

/** 校验一份归档：逐行重算哈希链。brokenAt 为首个不一致的行号（0 起）。 */
export function verifyAuditArchive(
  body: string,
  prevHash = GENESIS,
): { ok: boolean; count: number; lastHash: string; brokenAt?: number } {
  let prev = prevHash;
  const lines = body.split('\n').filter((l) => l.trim());
  for (let i = 0; i < lines.length; i++) {
    let row: AuditRow & { prev: string; h: string };
    try {
      row = JSON.parse(lines[i]!);
    } catch {
      return { ok: false, count: i, lastHash: prev, brokenAt: i };
    }
    if (row.prev !== prev || sha256(prev + canonical(row)) !== row.h) {
      return { ok: false, count: i, lastHash: prev, brokenAt: i };
    }
    prev = row.h;
  }
  return { ok: true, count: lines.length, lastHash: prev };
}

/**
 * 归档文件名：按清理批次落一个文件，月份前缀便于按期归置到冷存储/WORM 桶。
 * 带随机后缀：同一毫秒内的两批不会同名覆盖（归档一旦被覆盖，链就断了）。
 */
export function archiveFileName(now: Date, cutoff: Date, nonce = randomBytes(3).toString('hex')): string {
  const ym = `${cutoff.getUTCFullYear()}-${String(cutoff.getUTCMonth() + 1).padStart(2, '0')}`;
  return `audit-archive/${ym}/audit-${now.toISOString().replace(/[:.]/g, '-')}-${nonce}.jsonl`;
}
