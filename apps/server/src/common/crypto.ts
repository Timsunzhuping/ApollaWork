import crypto from 'node:crypto';

/**
 * 信封加密（PRD §4.9）：连接器/模型密钥落库前加密。
 * 主密钥来自 APOLLA_MASTER_KEY（生产从 KMS/文件注入）；开发有默认值并告警。
 */
const RAW = process.env.APOLLA_MASTER_KEY ?? 'apolla-dev-insecure-master-key-change-me';
const KEY = crypto.createHash('sha256').update(RAW).digest();

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function decryptSecret(blob: string): string {
  const [ver, ivB, tagB, dataB] = blob.split(':');
  if (ver !== 'v1') throw new Error('未知密钥版本');
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivB, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB, 'base64')), decipher.final()]).toString('utf8');
}
