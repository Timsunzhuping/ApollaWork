import { describe, expect, it } from 'vitest';
import { buildEgressPolicy } from './egress-policy.js';

/**
 * 出网策略（T-402）：沙箱容器无网，一切出网由 server 按这里判定。
 * 这是红线「默认禁出网」的真正边界 —— 命令正则只是提示。
 */
const base = {
  model: { name: 'qwen', baseUrl: 'http://litellm.apolla.svc:4000/v1', apiKey: 'sk-secret' },
  webfetchAllowlist: ['corp.com', '10.20.30.40'],
  searxngUrl: 'http://searx.apolla.svc:8080',
};
const u = (s: string) => new URL(s);

describe('出网策略：fetch', () => {
  const p = buildEgressPolicy(base);

  it('★ 模型网关源放行，并在 server 侧注入 Authorization', () => {
    const d = p.fetch(u('http://litellm.apolla.svc:4000/v1/chat/completions'));
    expect(d.ok).toBe(true);
    expect(d.headers).toEqual({ authorization: 'Bearer sk-secret' });
  });

  it('模型未配置密钥时不注入', () => {
    const d = buildEgressPolicy({ ...base, model: { name: 'm', baseUrl: 'http://gw:4000' } }).fetch(u('http://gw:4000/v1/x'));
    expect(d.ok).toBe(true);
    expect(d.headers).toEqual({});
  });

  it('搜索服务源放行', () => {
    expect(p.fetch(u('http://searx.apolla.svc:8080/search?q=x')).ok).toBe(true);
  });

  it('白名单域精确与子域放行；同名前缀不算', () => {
    expect(p.fetch(u('https://corp.com/a')).ok).toBe(true);
    expect(p.fetch(u('https://wiki.corp.com/a')).ok).toBe(true);
    expect(p.fetch(u('http://10.20.30.40:8080/api')).ok).toBe(true);
    expect(p.fetch(u('https://evilcorp.com/a')).ok).toBe(false);
  });

  it('★ 白名单外一律拒绝，并说明原因', () => {
    const d = p.fetch(u('http://10.0.0.5/'));
    expect(d.ok).toBe(false);
    expect(d.reason).toContain('不在出网白名单');
  });

  it('★ 本机 / 链路本地 / 云元数据 / 宿主别名：即使写进白名单也拒绝', () => {
    const q = buildEgressPolicy({
      ...base,
      webfetchAllowlist: ['localhost', '127.0.0.1', '169.254.169.254', 'metadata.google.internal', 'host.docker.internal'],
    });
    for (const s of [
      'http://localhost:3001/api/v1/admin',
      'http://127.0.0.1:6379/',
      'http://127.1.2.3/',
      'http://169.254.169.254/latest/meta-data/',
      'http://metadata.google.internal/',
      'http://host.docker.internal:5432/',
      'http://[::1]:3001/',
    ]) {
      expect(q.fetch(u(s)).ok, s).toBe(false);
    }
  });

  it('非 http/https 协议拒绝', () => {
    expect(p.fetch(u('ftp://corp.com/x')).ok).toBe(false);
    expect(p.fetch(u('file:///etc/passwd')).ok).toBe(false);
  });

  it('模型 baseUrl 非法时不放行任何伪造源', () => {
    const q = buildEgressPolicy({ ...base, model: { name: 'm', baseUrl: 'not a url' } });
    expect(q.fetch(u('http://not/')).ok).toBe(false);
  });
});

describe('出网策略：TCP 隧道（Bash/python/MCP 的出网）', () => {
  const p = buildEgressPolicy(base);

  it('白名单主机任意端口放行（内网 REST 常用非标端口）', () => {
    expect(p.tcp('api.corp.com', 8080).ok).toBe(true);
    expect(p.tcp('corp.com', 443).ok).toBe(true);
    expect(p.tcp('10.20.30.40', 5432).ok).toBe(true);
  });

  it('★ 非白名单主机拒绝', () => {
    expect(p.tcp('10.0.0.5', 5432).ok).toBe(false);
    expect(p.tcp('example.com', 443).ok).toBe(false);
  });

  it('★ 模型网关主机不走隧道：密钥只能由 server 中继注入，不给容器直连', () => {
    expect(p.tcp('litellm.apolla.svc', 4000).ok).toBe(false);
  });

  it('本机与链路本地地址无条件拒绝；端口非法拒绝', () => {
    const q = buildEgressPolicy({ ...base, webfetchAllowlist: ['localhost', '127.0.0.1'] });
    expect(q.tcp('localhost', 3001).ok).toBe(false);
    expect(q.tcp('127.0.0.1', 6379).ok).toBe(false);
    expect(q.tcp('::1', 3001).ok).toBe(false);
    expect(p.tcp('corp.com', 0).ok).toBe(false);
    expect(p.tcp('corp.com', 70000).ok).toBe(false);
  });
});
