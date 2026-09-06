import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

/**
 * OIDC 令牌校验（PRD T-117）。对接 Keycloak / 企业 IdP。
 * 从 issuer 的 JWKS 端点验签（RS256），提取 sub/email/name 做 JIT 建户。
 * JWKS 由 jose 缓存并按需刷新。
 */
export interface OidcClaims {
  sub: string;
  email: string;
  name: string;
  roles: string[];
  /** 组织声明（多租户）：IdP 自定义 claim `org` / `organization`；没有则由邮箱域名推导 */
  org?: string;
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let issuerCache = '';

function jwksFor(issuer: string) {
  if (!jwks || issuerCache !== issuer) {
    const url = new URL(
      issuer.replace(/\/$/, '') + '/protocol/openid-connect/certs',
    );
    // 兼容非 Keycloak issuer：优先用标准 .well-known 推断的 jwks_uri（此处用 Keycloak 约定，
    // 其他 IdP 可用 OIDC_JWKS_URI 覆盖）
    const override = process.env.OIDC_JWKS_URI;
    jwks = createRemoteJWKSet(override ? new URL(override) : url);
    issuerCache = issuer;
  }
  return jwks;
}

export async function verifyOidcToken(token: string, issuer: string): Promise<OidcClaims> {
  const { payload } = await jwtVerify(token, jwksFor(issuer), {
    issuer: process.env.OIDC_VERIFY_ISSUER === '0' ? undefined : issuer,
    audience: process.env.OIDC_AUDIENCE || undefined,
  });
  return claimsOf(payload);
}

/** 用给定的 key/JWKS 校验（测试用，可注入本地 key）。 */
export async function verifyWithKey(
  token: string,
  keyOrJwks: Parameters<typeof jwtVerify>[1],
  opts?: { issuer?: string; audience?: string },
): Promise<OidcClaims> {
  const { payload } = await jwtVerify(token, keyOrJwks, opts);
  return claimsOf(payload);
}

export function claimsOf(payload: JWTPayload): OidcClaims {
  const p = payload as JWTPayload & {
    email?: string;
    preferred_username?: string;
    name?: string;
    realm_access?: { roles?: string[] };
    org?: string;
    organization?: string;
  };
  return {
    sub: String(p.sub ?? ''),
    email: p.email ?? p.preferred_username ?? `${p.sub}@sso.local`,
    name: p.name ?? p.preferred_username ?? '用户',
    roles: p.realm_access?.roles ?? [],
    org: p.org ?? p.organization,
  };
}

/** 把 IdP 角色映射为平台角色（realm 角色含 apolla-admin → admin）。 */
export function mapRole(roles: string[]): 'admin' | 'member' {
  return roles.includes('apolla-admin') || roles.includes('admin') ? 'admin' : 'member';
}
