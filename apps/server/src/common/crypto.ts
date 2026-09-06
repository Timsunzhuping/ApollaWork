import crypto from 'node:crypto';

/**
 * 信封加密（PRD §4.9）：连接器/模型密钥落库前加密。
 * 主密钥来自 APOLLA_MASTER_KEY（生产从 KMS/文件注入）；开发有默认值并由 preflight 告警。
 *
 * T-406 密钥轮换：
 * - 密文格式 v2:<kid>:<iv>:<tag>:<data>，kid = 派生密钥指纹前 12 位，解密按 kid 选钥；
 * - APOLLA_MASTER_KEY_PREVIOUS（逗号分隔）给出旧主钥：轮换期间新旧双读，服务不中断；
 * - 旧格式 v1:<iv>:<tag>:<data> 无 kid，依次用当前钥与旧钥尝试解密；
 * - rotateSecret() 把任意可解密文重加密为当前钥的 v2 —— `pnpm rotate-key` 批量跑完即可删除旧钥。
 */

const DEV_DEFAULT = 'apolla-dev-insecure-master-key-change-me';

function derive(raw: string): Buffer {
  return crypto.createHash('sha256').update(raw).digest();
}
function kidOf(key: Buffer): string {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
}

interface KeyRing {
  current: { kid: string; key: Buffer };
  all: Map<string, Buffer>; // kid → key（含当前与全部旧钥）
  ordered: Buffer[]; // 解 v1 用：当前钥优先，再旧钥
}

let ring: KeyRing | undefined;

/** 从环境组装密钥环；测试可用 loadKeyRing(current, previous) 显式重载 */
export function loadKeyRing(rawCurrent = process.env.APOLLA_MASTER_KEY ?? DEV_DEFAULT, rawPrevious = process.env.APOLLA_MASTER_KEY_PREVIOUS ?? ''): KeyRing {
  const current = derive(rawCurrent);
  const all = new Map<string, Buffer>([[kidOf(current), current]]);
  const ordered = [current];
  for (const p of rawPrevious.split(',').map((s) => s.trim()).filter(Boolean)) {
    const k = derive(p);
    if (!all.has(kidOf(k))) {
      all.set(kidOf(k), k);
      ordered.push(k);
    }
  }
  ring = { current: { kid: kidOf(current), key: current }, all, ordered };
  return ring;
}

function keys(): KeyRing {
  return ring ?? loadKeyRing();
}

/** 当前主钥的指纹（写进密文、也用于判断是否需要轮换） */
export function currentKeyId(): string {
  return keys().current.kid;
}

export function encryptSecret(plain: string): string {
  const { kid, key } = keys().current;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v2:${kid}:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

function gcmDecrypt(key: Buffer, ivB: string, tagB: string, dataB: string): string {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB, 'base64')), decipher.final()]).toString('utf8');
}

export function decryptSecret(blob: string): string {
  const parts = blob.split(':');
  const ring = keys();
  if (parts[0] === 'v2' && parts.length === 5) {
    const [, kid, ivB, tagB, dataB] = parts as [string, string, string, string, string];
    const key = ring.all.get(kid);
    if (!key) throw new Error(`密文由未知主钥加密（kid=${kid}）：请把对应旧钥加入 APOLLA_MASTER_KEY_PREVIOUS`);
    return gcmDecrypt(key, ivB, tagB, dataB);
  }
  if (parts[0] === 'v1' && parts.length === 4) {
    // 旧格式无 kid：当前钥优先，再依次尝试旧钥（GCM 认证标签保证用错钥必失败，不会解出垃圾）
    const [, ivB, tagB, dataB] = parts as [string, string, string, string];
    let lastErr: unknown;
    for (const key of ring.ordered) {
      try {
        return gcmDecrypt(key, ivB, tagB, dataB);
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error(`旧格式密文无法用任何已知主钥解密：${(lastErr as Error)?.message ?? ''}`);
  }
  throw new Error('未知密钥版本');
}

/** 密文用的是哪把钥（v1 返回 null） */
export function keyIdOf(blob: string): string | null {
  const parts = blob.split(':');
  return parts[0] === 'v2' ? (parts[1] ?? null) : null;
}

/** 是否还没用当前主钥加密（v1 或旧 kid） */
export function needsRotation(blob: string): boolean {
  return keyIdOf(blob) !== currentKeyId();
}

/** 用当前主钥重加密（解不开会抛错，调用方决定是跳过还是中止） */
export function rotateSecret(blob: string): string {
  return encryptSecret(decryptSecret(blob));
}
