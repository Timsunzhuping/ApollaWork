import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  REFRESH_LEEWAY_MS,
  clearToken,
  decodeExp,
  ensureFreshToken,
  getExpiresAt,
  getToken,
  handleRedirectCallback,
  hasSilentAttempted,
  refreshToken,
  scheduleRefresh,
  setAuthConfig,
  type AuthConfig,
} from './oidc';

/**
 * 令牌静默续期（T-408，测试属 T-411）。
 * 用 jsdom 的 sessionStorage 与 mock fetch 复刻 Keycloak 的 token 端点。
 */
const cfg: AuthConfig = { mode: 'oidc', issuer: 'http://idp/realms/apolla', clientId: 'apolla-web' };
const jwt = (expSec: number) =>
  `eyJhbGciOiJSUzI1NiJ9.${btoa(JSON.stringify({ exp: expSec, sub: 'u1' })).replace(/=+$/, '')}.sig`;

const tokenResponse = (access: string, refresh = 'r2', expiresIn = 300) =>
  new Response(JSON.stringify({ access_token: access, refresh_token: refresh, expires_in: expiresIn }), { status: 200 });

beforeEach(() => {
  sessionStorage.clear();
  clearToken();
  setAuthConfig(cfg);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('decodeExp', () => {
  it('解析 JWT exp；非法返回 null', () => {
    expect(decodeExp(jwt(1_800_000_000))).toBe(1_800_000_000);
    expect(decodeExp('not-a-jwt')).toBeNull();
  });
});

describe('ensureFreshToken / refreshToken', () => {
  it('未到期直接返回现有令牌，不发请求', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    sessionStorage.setItem('apolla.access_token', 'A');
    sessionStorage.setItem('apolla.refresh_token', 'R');
    sessionStorage.setItem('apolla.expires_at', String(Date.now() + 10 * 60_000));
    expect(await ensureFreshToken()).toBe('A');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('★ 距过期不足 60s：用 refresh_token 换新并存储新的 refresh（Keycloak 会轮换）', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(tokenResponse('A2', 'R2', 900));
    sessionStorage.setItem('apolla.access_token', 'A1');
    sessionStorage.setItem('apolla.refresh_token', 'R1');
    sessionStorage.setItem('apolla.expires_at', String(Date.now() + REFRESH_LEEWAY_MS - 1000));
    expect(await ensureFreshToken()).toBe('A2');
    expect(getToken()).toBe('A2');
    expect(sessionStorage.getItem('apolla.refresh_token')).toBe('R2');
    expect(getExpiresAt()! - Date.now()).toBeGreaterThan(800_000);
    const body = String(fetchSpy.mock.calls[0]![1]!.body);
    expect(body).toContain('grant_type=refresh_token');
    expect(body).toContain('refresh_token=R1');
    expect(String(fetchSpy.mock.calls[0]![0])).toBe('http://idp/realms/apolla/protocol/openid-connect/token');
  });

  it('★ 并发续期只发一次请求（单飞）', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(tokenResponse('A2'));
    sessionStorage.setItem('apolla.access_token', 'A1');
    sessionStorage.setItem('apolla.refresh_token', 'R1');
    sessionStorage.setItem('apolla.expires_at', String(Date.now() + 1000));
    const [a, b, c] = await Promise.all([refreshToken(), refreshToken(), refreshToken()]);
    expect([a, b, c]).toEqual(['A2', 'A2', 'A2']);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('★ refresh 也失效（400）：清空令牌，返回 null → 上层展示登录页', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"error":"invalid_grant"}', { status: 400 }));
    sessionStorage.setItem('apolla.access_token', 'A1');
    sessionStorage.setItem('apolla.refresh_token', 'R1');
    sessionStorage.setItem('apolla.expires_at', String(Date.now() - 1000));
    expect(await ensureFreshToken()).toBeNull();
    expect(getToken()).toBeNull();
  });

  it('网络抖动：保留现有令牌，下次再试', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    sessionStorage.setItem('apolla.access_token', 'A1');
    sessionStorage.setItem('apolla.refresh_token', 'R1');
    sessionStorage.setItem('apolla.expires_at', String(Date.now() + 30_000));
    expect(await ensureFreshToken()).toBe('A1');
  });

  it('★ scheduleRefresh 在到期前 60s 自动续期；续期失败广播未登录', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(tokenResponse('A2', 'R2', 300));
    sessionStorage.setItem('apolla.access_token', 'A1');
    sessionStorage.setItem('apolla.refresh_token', 'R1');
    sessionStorage.setItem('apolla.expires_at', String(Date.now() + 5 * 60_000));
    scheduleRefresh();
    await vi.advanceTimersByTimeAsync(4 * 60_000 - 1);
    expect(fetchSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(getToken()).toBe('A2');

    const unauthorized = vi.fn();
    window.addEventListener('apolla:unauthorized', unauthorized);
    fetchSpy.mockResolvedValue(new Response('{}', { status: 400 }));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(unauthorized).toHaveBeenCalled();
  });
});

describe('handleRedirectCallback', () => {
  it('★ 静默登录发现无会话（error=login_required）→ login_required，并清掉静默标记与 URL 参数', async () => {
    sessionStorage.setItem('apolla.silent_attempt', '1');
    window.history.replaceState({}, '', '/?error=login_required&state=x');
    expect(await handleRedirectCallback(cfg)).toBe('login_required');
    expect(hasSilentAttempted()).toBe(false);
    expect(window.location.search).toBe('');
  });

  it('★ 带 code：换令牌、存 refresh、回到登录前的页面', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(tokenResponse(jwt(Math.floor(Date.now() / 1000) + 900), 'R9', 900));
    sessionStorage.setItem('apolla.pkce_verifier', 'v');
    sessionStorage.setItem('apolla.oidc_state', 's1');
    sessionStorage.setItem('apolla.return_to', '/task/t-42');
    window.history.replaceState({}, '', '/?code=c1&state=s1');
    expect(await handleRedirectCallback(cfg)).toBe('ok');
    expect(sessionStorage.getItem('apolla.refresh_token')).toBe('R9');
    expect(window.location.pathname).toBe('/task/t-42');
    expect(sessionStorage.getItem('apolla.return_to')).toBeNull();
  });

  it('state 不匹配拒绝', async () => {
    sessionStorage.setItem('apolla.pkce_verifier', 'v');
    sessionStorage.setItem('apolla.oidc_state', 'good');
    window.history.replaceState({}, '', '/?code=c1&state=evil');
    await expect(handleRedirectCallback(cfg)).rejects.toThrow();
  });

  it('无参数 → none', async () => {
    window.history.replaceState({}, '', '/');
    expect(await handleRedirectCallback(cfg)).toBe('none');
  });
});
