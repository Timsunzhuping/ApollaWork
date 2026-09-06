import { describe, expect, it } from 'vitest';
import { redact, redactObject, redactUrl } from './redact.js';

/** 日志脱敏（T-407）：8 类凭据样本，落日志前必须抹掉，键名与上下文保留 */
describe('redact', () => {
  it('★ JSON 与键值对里的密钥 / 令牌 / 密码', () => {
    expect(redact('{"apiKey":"sk-abc123456789","model":"qwen"}')).toBe('{"apiKey":"***","model":"qwen"}');
    expect(redact('client_secret=s3cr3t-value&grant_type=password')).toBe('client_secret=***&grant_type=password');
    expect(redact('password: hunter2, user: tim')).toBe('password: ***, user: tim');
    expect(redact("MODEL_API_KEY='sk-live-xyz'")).toBe("MODEL_API_KEY='***'");
  });

  it('★ Bearer 令牌', () => {
    expect(redact('authorization: Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.sig-part')).toBe('authorization: ***');
    expect(redact('Authorization: Bearer abc.def-ghi_jkl')).toBe('Authorization: ***');
  });

  it('★ 裸 JWT', () => {
    const jwt = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE3ODc5NDAxNDN9.lKlWsTuH_xdjQSyNxwRiSLec';
    expect(redact(`token in log ${jwt} end`)).toBe('token in log ***jwt*** end');
  });

  it('★ URL 查询参数里的令牌（SSE 的 access_token 走的就是这条）', () => {
    expect(redactUrl('/api/v1/tasks/t1/events?access_token=eyJabc.def.ghi&x=1')).toBe(
      '/api/v1/tasks/t1/events?access_token=***&x=1',
    );
    expect(redactUrl('https://s3/x?X-Amz-Signature=deadbeef&key=abc')).toBe('https://s3/x?X-Amz-Signature=***&key=***');
  });

  it('★ URL 里的 Basic 认证', () => {
    expect(redact('postgresql://apolla:prod-secret@localhost:5455/apolla')).toBe('postgresql://***:***@localhost:5455/apolla');
    expect(redact('redis://:pw@redis:6379')).toBe('redis://***:***@redis:6379');
  });

  it('★ Basic 认证头', () => {
    expect(redact('Authorization: Basic dXNlcjpwYXNz')).toBe('Authorization: ***');
  });

  it('★ 常见 API Key 前缀', () => {
    expect(redact('using sk-proj-1234567890abcdef now')).toBe('using sk-*** now');
    expect(redact('ghp_abcdefghijklmnop123')).toBe('ghp-***');
  });

  it('★ 结构化对象：敏感键整值替换，其余递归处理', () => {
    expect(
      redactObject({
        apiKey: 'sk-x',
        nested: { Authorization: 'Bearer abc.def', note: 'password=zzz ok' },
        list: ['token=abc', 'plain'],
        n: 1,
      }),
    ).toEqual({
      apiKey: '***',
      nested: { Authorization: '***', note: 'password=*** ok' },
      list: ['token=***', 'plain'],
      n: 1,
    });
  });

  it('普通文本原样保留（不过度脱敏）', () => {
    for (const s of ['任务完成，产物 budget.csv', 'user tim.sun@hermess.ai logged in', 'status=200 bytes=1024', 'keyboard shortcut']) {
      expect(redact(s)).toBe(s);
    }
  });
});
