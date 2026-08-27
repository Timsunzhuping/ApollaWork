import { describe, expect, it } from 'vitest';
import { generateKeyPair, SignJWT, exportJWK, createLocalJWKSet } from 'jose';
import { verifyWithKey, claimsOf, mapRole } from './oidc.js';

/**
 * 离线验证 OIDC 令牌流程（不依赖真实 Keycloak）：
 * 本地生成 RS256 密钥 → 签发 JWT → 用对应 JWKS 验签 → 提取 claims/角色。
 */
describe('OIDC 令牌校验（T-117）', () => {
  it('验签通过并正确提取 claims 与角色', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);
    jwk.kid = 'test-key';
    jwk.alg = 'RS256';
    const jwks = createLocalJWKSet({ keys: [jwk] });

    const token = await new SignJWT({
      email: 'zhang@corp.com',
      name: '张三',
      preferred_username: 'zhang',
      realm_access: { roles: ['apolla-admin', 'default-roles'] },
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer('https://kc.corp.com/realms/apolla')
      .setAudience('apolla')
      .setSubject('user-123')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);

    const claims = await verifyWithKey(token, jwks, {
      issuer: 'https://kc.corp.com/realms/apolla',
      audience: 'apolla',
    });
    expect(claims.sub).toBe('user-123');
    expect(claims.email).toBe('zhang@corp.com');
    expect(claims.name).toBe('张三');
    expect(mapRole(claims.roles)).toBe('admin');
  });

  it('篡改/过期令牌验签失败', async () => {
    const { publicKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);
    jwk.alg = 'RS256';
    const jwks = createLocalJWKSet({ keys: [jwk] });
    // 用另一把私钥签发（伪造）
    const { privateKey: evil } = await generateKeyPair('RS256');
    const forged = await new SignJWT({ email: 'a@b.c' })
      .setProtectedHeader({ alg: 'RS256' })
      .setSubject('x')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(evil);
    await expect(verifyWithKey(forged, jwks)).rejects.toBeTruthy();
  });

  it('普通用户映射为 member', () => {
    expect(mapRole(['default-roles', 'viewer'])).toBe('member');
    expect(claimsOf({ sub: 's' }).email).toBe('s@sso.local');
  });
});
