import { beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { currentKeyId, decryptSecret, encryptSecret, keyIdOf, loadKeyRing, needsRotation, rotateSecret } from './crypto.js';

/** 主密钥轮换（T-406）：新旧双读、按 kid 选钥、旧格式兼容、轮换后可删旧钥 */
const legacyV1 = (raw: string, plain: string) => {
  // 复刻旧版 v1 格式（无 kid）
  const key = crypto.createHash('sha256').update(raw).digest();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
};

describe('信封加密与密钥轮换', () => {
  beforeEach(() => loadKeyRing('key-A', ''));

  it('v2 密文带当前主钥 kid，可往返', () => {
    const blob = encryptSecret('sk-live-123');
    expect(blob.startsWith(`v2:${currentKeyId()}:`)).toBe(true);
    expect(keyIdOf(blob)).toBe(currentKeyId());
    expect(decryptSecret(blob)).toBe('sk-live-123');
    expect(needsRotation(blob)).toBe(false);
  });

  it('篡改密文即解密失败（GCM 认证）', () => {
    const blob = encryptSecret('secret');
    const parts = blob.split(':');
    parts[4] = Buffer.from('xx' + Buffer.from(parts[4]!, 'base64').toString('binary').slice(2), 'binary').toString('base64');
    expect(() => decryptSecret(parts.join(':'))).toThrow();
  });

  it('★ 轮换期间新旧双读：旧钥密文仍可解，且标记为待轮换', () => {
    const old = encryptSecret('conn-token');
    loadKeyRing('key-B', 'key-A'); // 换新钥，旧钥进 PREVIOUS
    expect(currentKeyId()).not.toBe(keyIdOf(old));
    expect(decryptSecret(old)).toBe('conn-token');
    expect(needsRotation(old)).toBe(true);
  });

  it('★ rotateSecret 重加密为当前钥；之后删掉旧钥仍可解', () => {
    const old = encryptSecret('conn-token');
    loadKeyRing('key-B', 'key-A');
    const fresh = rotateSecret(old);
    expect(keyIdOf(fresh)).toBe(currentKeyId());
    expect(needsRotation(fresh)).toBe(false);
    loadKeyRing('key-B', ''); // 旧钥已删
    expect(decryptSecret(fresh)).toBe('conn-token');
    expect(() => decryptSecret(old)).toThrow(/APOLLA_MASTER_KEY_PREVIOUS/);
  });

  it('★ 旧格式 v1（无 kid）：依次用当前钥与旧钥尝试，用错钥不会解出垃圾', () => {
    const v1 = legacyV1('key-A', 'legacy-secret');
    loadKeyRing('key-B', 'key-A');
    expect(decryptSecret(v1)).toBe('legacy-secret');
    expect(needsRotation(v1)).toBe(true);
    expect(keyIdOf(rotateSecret(v1))).toBe(currentKeyId());
    loadKeyRing('key-B', '');
    expect(() => decryptSecret(v1)).toThrow(/旧格式密文无法/);
  });

  it('多把旧钥按顺序都能用', () => {
    loadKeyRing('key-A', '');
    const a = encryptSecret('from-A');
    loadKeyRing('key-B', '');
    const b = encryptSecret('from-B');
    loadKeyRing('key-C', 'key-B, key-A');
    expect(decryptSecret(a)).toBe('from-A');
    expect(decryptSecret(b)).toBe('from-B');
  });

  it('未知版本前缀拒绝', () => {
    expect(() => decryptSecret('v9:a:b:c:d')).toThrow('未知密钥版本');
  });
});
