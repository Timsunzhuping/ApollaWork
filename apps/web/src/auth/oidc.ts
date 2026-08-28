/**
 * 前端 OIDC 授权码 + PKCE 登录（生产 P0）。
 * 之前后端能验签但前端没有登录入口，AUTH_MODE=oidc 时应用完全打不开。
 *
 * 不引第三方库：授权码 + PKCE 是标准流程，用 fetch + WebCrypto 即可。
 * 令牌存 sessionStorage（关闭标签页即失效，比 localStorage 更安全；
 * 刷新令牌不落前端，过期后重新走一次跳转）。
 */
export interface AuthConfig {
  mode: 'dev' | 'oidc';
  issuer?: string;
  clientId?: string;
  scope?: string;
}

const TOKEN_KEY = 'apolla.access_token';
const VERIFIER_KEY = 'apolla.pkce_verifier';
const STATE_KEY = 'apolla.oidc_state';

export function getToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function clearToken() {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

export async function fetchAuthConfig(): Promise<AuthConfig> {
  const res = await fetch('/api/v1/auth/config');
  if (!res.ok) return { mode: 'dev' };
  return res.json();
}

function base64url(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function randomString(len = 64): string {
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  return base64url(a.buffer).slice(0, len);
}

async function sha256(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return base64url(digest);
}

/** 发起登录：跳转到 IdP 授权端点。 */
export async function startLogin(cfg: AuthConfig) {
  if (!cfg.issuer || !cfg.clientId) throw new Error('OIDC 配置缺失');
  const verifier = randomString();
  const state = randomString(32);
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  sessionStorage.setItem(STATE_KEY, state);
  const challenge = await sha256(verifier);
  const url = new URL(cfg.issuer.replace(/\/$/, '') + '/protocol/openid-connect/auth');
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('redirect_uri', window.location.origin + '/');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', cfg.scope ?? 'openid profile email');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  window.location.href = url.toString();
}

/**
 * 回调处理：URL 上带 code 时用它换令牌。
 * 返回 true 表示本次已完成登录（调用方应清理 URL 并重载数据）。
 */
export async function handleRedirectCallback(cfg: AuthConfig): Promise<boolean> {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  if (!code || !cfg.issuer || !cfg.clientId) return false;

  const expectedState = sessionStorage.getItem(STATE_KEY);
  if (expectedState && params.get('state') !== expectedState) {
    throw new Error('OIDC state 校验失败（可能是 CSRF）');
  }
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  if (!verifier) throw new Error('PKCE verifier 丢失，请重新登录');

  const tokenUrl = cfg.issuer.replace(/\/$/, '') + '/protocol/openid-connect/token';
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: cfg.clientId,
    redirect_uri: window.location.origin + '/',
    code_verifier: verifier,
  });
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`换取令牌失败：${res.status} ${await res.text()}`);
  const json = (await res.json()) as { access_token: string };
  sessionStorage.setItem(TOKEN_KEY, json.access_token);
  sessionStorage.removeItem(VERIFIER_KEY);
  sessionStorage.removeItem(STATE_KEY);
  // 清掉地址栏上的 code/state
  window.history.replaceState({}, '', window.location.pathname);
  return true;
}

export function logout(cfg: AuthConfig) {
  clearToken();
  if (cfg.mode === 'oidc' && cfg.issuer) {
    const url = new URL(cfg.issuer.replace(/\/$/, '') + '/protocol/openid-connect/logout');
    url.searchParams.set('post_logout_redirect_uri', window.location.origin + '/');
    url.searchParams.set('client_id', cfg.clientId ?? 'apolla-web');
    window.location.href = url.toString();
  } else {
    window.location.reload();
  }
}
