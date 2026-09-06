/**
 * 前端 OIDC 授权码 + PKCE 登录（生产 P0），T-408 加入静默续期。
 *
 * 此前只存 access_token、无 refresh：Keycloak 默认 access 5 分钟过期，401 一到就踹回登录页，
 * 一个 20 分钟的任务用户要被踹出 4 次。现在：
 * - access_token / refresh_token / 过期时间存 sessionStorage（标签页级，关闭即失效）；
 * - 过期前 60s 用 refresh_token 静默换新，接口 401 先续期再重试一次；
 * - 新标签页没有令牌时先带 prompt=none 静默跳一次 IdP：SSO 会话有效就直接回来，
 *   无效才展示登录页；
 * - 登录前记住当前地址，回调后回到原页面而不是首页。
 * 不引第三方库：标准流程用 fetch + WebCrypto 即可。
 */
import { t } from '../i18n';

export interface AuthConfig {
  mode: 'dev' | 'oidc';
  issuer?: string;
  clientId?: string;
  scope?: string;
}

const TOKEN_KEY = 'apolla.access_token';
const REFRESH_KEY = 'apolla.refresh_token';
const EXPIRES_KEY = 'apolla.expires_at';
const VERIFIER_KEY = 'apolla.pkce_verifier';
const STATE_KEY = 'apolla.oidc_state';
const RETURN_KEY = 'apolla.return_to';
const SILENT_KEY = 'apolla.silent_attempt';

/** 距过期不足这么久就提前续期 */
export const REFRESH_LEEWAY_MS = 60_000;

let currentConfig: AuthConfig | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let inflight: Promise<string | null> | null = null;

const store = {
  get(k: string): string | null {
    try {
      return sessionStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      sessionStorage.setItem(k, v);
    } catch {
      /* 隐私模式等：退化为本次内存态 */
    }
  },
  del(k: string) {
    try {
      sessionStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  },
};

export function setAuthConfig(cfg: AuthConfig) {
  currentConfig = cfg;
}

export function getToken(): string | null {
  return store.get(TOKEN_KEY);
}

export function getExpiresAt(): number | null {
  const v = store.get(EXPIRES_KEY);
  return v ? Number(v) : null;
}

export function clearToken() {
  store.del(TOKEN_KEY);
  store.del(REFRESH_KEY);
  store.del(EXPIRES_KEY);
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = undefined;
}

/** JWT 的 exp（秒）；解析失败返回 null */
export function decodeExp(token: string): number | null {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')));
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

function saveTokens(json: TokenResponse, now = Date.now()) {
  store.set(TOKEN_KEY, json.access_token);
  if (json.refresh_token) store.set(REFRESH_KEY, json.refresh_token);
  const exp = decodeExp(json.access_token);
  const expiresAt = json.expires_in ? now + json.expires_in * 1000 : exp ? exp * 1000 : now + 5 * 60_000;
  store.set(EXPIRES_KEY, String(expiresAt));
  scheduleRefresh();
}

export async function fetchAuthConfig(): Promise<AuthConfig> {
  const res = await fetch('/api/v1/auth/config');
  const cfg: AuthConfig = res.ok ? await res.json() : { mode: 'dev' };
  currentConfig = cfg;
  return cfg;
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

function tokenEndpoint(cfg: AuthConfig) {
  return cfg.issuer!.replace(/\/$/, '') + '/protocol/openid-connect/token';
}

/**
 * 发起登录：跳转到 IdP 授权端点。
 * silent=true 带 prompt=none：IdP 有 SSO 会话就直接发码回来，没有则带 error=login_required 回来。
 * 跳转前记住当前地址，回调后回到原页面。
 */
export async function startLogin(cfg: AuthConfig, opts: { silent?: boolean } = {}) {
  if (!cfg.issuer || !cfg.clientId) throw new Error(t('error.oidcConfigMissing'));
  const verifier = randomString();
  const state = randomString(32);
  store.set(VERIFIER_KEY, verifier);
  store.set(STATE_KEY, state);
  const here = window.location.pathname + window.location.search;
  if (here !== '/' && !window.location.search.includes('code=')) store.set(RETURN_KEY, here);
  if (opts.silent) store.set(SILENT_KEY, '1');
  const challenge = await sha256(verifier);
  const url = new URL(cfg.issuer.replace(/\/$/, '') + '/protocol/openid-connect/auth');
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('redirect_uri', window.location.origin + '/');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', cfg.scope ?? 'openid profile email');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (opts.silent) url.searchParams.set('prompt', 'none');
  window.location.href = url.toString();
}

/** 是否已经静默尝试过一次（防止 IdP 无会话时来回跳个不停） */
export function hasSilentAttempted(): boolean {
  return store.get(SILENT_KEY) === '1';
}

export type CallbackResult = 'ok' | 'login_required' | 'none';

/**
 * 回调处理。URL 上带 code → 换令牌并回到登录前的页面；
 * 带 error（静默登录时 IdP 没有会话）→ 'login_required'，调用方展示登录页；
 * 都没有 → 'none'。
 */
export async function handleRedirectCallback(cfg: AuthConfig): Promise<CallbackResult> {
  const params = new URLSearchParams(window.location.search);
  const error = params.get('error');
  const wasSilent = hasSilentAttempted();
  store.del(SILENT_KEY);

  if (error) {
    window.history.replaceState({}, '', window.location.pathname);
    if (wasSilent || error === 'login_required' || error === 'interaction_required') return 'login_required';
    throw new Error(`${error}: ${params.get('error_description') ?? ''}`);
  }
  const code = params.get('code');
  if (!code || !cfg.issuer || !cfg.clientId) return 'none';

  const expectedState = store.get(STATE_KEY);
  if (expectedState && params.get('state') !== expectedState) throw new Error(t('error.oidcState'));
  const verifier = store.get(VERIFIER_KEY);
  if (!verifier) throw new Error(t('error.pkceMissing'));

  const res = await fetch(tokenEndpoint(cfg), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: cfg.clientId,
      redirect_uri: window.location.origin + '/',
      code_verifier: verifier,
    }),
  });
  if (!res.ok) throw new Error(t('error.tokenExchange', { status: res.status, detail: await res.text() }));
  currentConfig = cfg;
  saveTokens((await res.json()) as TokenResponse);
  store.del(VERIFIER_KEY);
  store.del(STATE_KEY);

  // 回到登录前的页面（没有就留在当前路径），并清掉地址栏上的 code/state
  const returnTo = store.get(RETURN_KEY);
  store.del(RETURN_KEY);
  window.history.replaceState({}, '', returnTo && returnTo.startsWith('/') ? returnTo : window.location.pathname);
  return 'ok';
}

/**
 * 用 refresh_token 换新令牌。并发调用只发一次请求；失败（refresh 也过期/被吊销）则清空令牌并返回 null。
 */
export function refreshToken(): Promise<string | null> {
  if (inflight) return inflight;
  const cfg = currentConfig;
  const refresh = store.get(REFRESH_KEY);
  if (!cfg?.issuer || !cfg.clientId || !refresh) return Promise.resolve(null);
  inflight = (async () => {
    try {
      const res = await fetch(tokenEndpoint(cfg), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: cfg.clientId! }),
      });
      if (!res.ok) {
        clearToken();
        return null;
      }
      const json = (await res.json()) as TokenResponse;
      saveTokens(json);
      return json.access_token;
    } catch {
      // 网络抖动：保留现有令牌，下次再试
      return store.get(TOKEN_KEY);
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** 返回可用的令牌：快过期就先静默续期。没有令牌返回 null。 */
export async function ensureFreshToken(now = Date.now()): Promise<string | null> {
  const token = store.get(TOKEN_KEY);
  if (!token) return null;
  const expiresAt = getExpiresAt();
  if (expiresAt === null || expiresAt - now > REFRESH_LEEWAY_MS) return token;
  return (await refreshToken()) ?? (expiresAt > now ? token : null);
}

/** 到期前 60s 自动续期；续期失败（refresh 也失效）则广播未登录 */
export function scheduleRefresh(now = Date.now()) {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = undefined;
  const expiresAt = getExpiresAt();
  if (!expiresAt || !store.get(REFRESH_KEY)) return;
  const delay = Math.max(1000, expiresAt - now - REFRESH_LEEWAY_MS);
  refreshTimer = setTimeout(() => {
    void refreshToken().then((tok) => {
      if (!tok) window.dispatchEvent(new CustomEvent('apolla:unauthorized'));
    });
  }, delay);
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
