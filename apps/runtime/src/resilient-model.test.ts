import { beforeEach, describe, expect, it } from 'vitest';
import type { ChatModel, ModelDelta, ModelResult } from './model.js';
import { ResilientModel, isTransientError, resetBreakers, type RetryInfo } from './resilient-model.js';

/**
 * 模型调用韧性（T-409）。openai SDK 只重试请求发起阶段；这里覆盖：
 * 流中途断开整段重试、参数错误不重试、用户取消不重试、降级、熔断、抖动下的整体成功率。
 */
const ok = (text: string): ModelResult => ({ text, toolCalls: [], usage: { inTokens: 1, outTokens: 1 }, finishReason: 'stop' });
const httpErr = (status: number, message = `HTTP ${status}`) => Object.assign(new Error(message), { status });

/** 用脚本驱动的假模型：每次调用按 plan 出牌 */
function scripted(name: string, plan: Array<'ok' | 'err5xx' | 'err4xx' | 'mid-stream' | 'conn'>): ChatModel & { calls: number } {
  let i = 0;
  const m = {
    name,
    calls: 0,
    async chat(_m: unknown, _t: unknown, onDelta: (d: ModelDelta) => void, _s: AbortSignal) {
      m.calls++;
      const step = plan[Math.min(i++, plan.length - 1)];
      if (step === 'ok') {
        onDelta({ textDelta: '完整' });
        return ok('完整');
      }
      if (step === 'err5xx') throw httpErr(503, 'Service Unavailable');
      if (step === 'err4xx') throw httpErr(400, 'invalid request');
      if (step === 'conn') throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } });
      onDelta({ textDelta: '半截' }); // 流出一部分后断
      throw new Error('terminated');
    },
  };
  return m as unknown as ChatModel & { calls: number };
}

const fast = { sleep: async () => undefined };
const collect = () => {
  const deltas: string[] = [];
  const retries: RetryInfo[] = [];
  const onDelta = (d: ModelDelta) => {
    if (d.textDelta) deltas.push(d.textDelta);
    if (d.retry) retries.push(d.retry);
  };
  return { deltas, retries, onDelta };
};
const sig = () => new AbortController().signal;

describe('isTransientError', () => {
  it('5xx / 429 / 408 / 连接重置 / 流中断 视为瞬时', () => {
    for (const e of [httpErr(503), httpErr(429), httpErr(408), httpErr(502), new Error('socket hang up'), new Error('terminated'),
      Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }), new Error('中继空闲超时')]) {
      expect(isTransientError(e), String(e)).toBe(true);
    }
  });
  it('4xx 参数/鉴权错误、用户取消、出网被策略拒绝 不重试', () => {
    for (const e of [httpErr(400), httpErr(401), httpErr(404), Object.assign(new Error('x'), { name: 'APIUserAbortError' }),
      new Error('出网被拒：10.0.0.5 不在出网白名单')]) {
      expect(isTransientError(e), String(e)).toBe(false);
    }
  });
});

describe('ResilientModel', () => {
  beforeEach(() => resetBreakers());

  it('★ 瞬时 5xx：指数退避重试后成功，重试信息可见', async () => {
    const m = scripted('p', ['err5xx', 'err5xx', 'ok']);
    const c = collect();
    const res = await new ResilientModel(m, undefined, fast).chat([], [], c.onDelta, sig());
    expect(res.text).toBe('完整');
    expect(m.calls).toBe(3);
    expect(c.retries.map((r) => r.attempt)).toEqual([1, 2]);
    expect(c.retries[0]).toMatchObject({ maxAttempts: 3, fallback: false, model: 'p', streamedPartial: false });
    expect(c.retries[0]!.reason).toContain('503');
  });

  it('★ 流式中途断开：整段重试，并标记已流出半截文本（UI 据此丢弃）', async () => {
    const m = scripted('p', ['mid-stream', 'ok']);
    const c = collect();
    const res = await new ResilientModel(m, undefined, fast).chat([], [], c.onDelta, sig());
    expect(res.text).toBe('完整');
    expect(c.retries).toHaveLength(1);
    expect(c.retries[0]!.streamedPartial).toBe(true);
    expect(c.deltas).toEqual(['半截', '完整']);
  });

  it('参数错误（4xx）直接抛出，不重试', async () => {
    const m = scripted('p', ['err4xx', 'ok']);
    await expect(new ResilientModel(m, undefined, fast).chat([], [], () => undefined, sig())).rejects.toThrow('invalid request');
    expect(m.calls).toBe(1);
  });

  it('用户取消不重试', async () => {
    const ac = new AbortController();
    const m: ChatModel = {
      name: 'p',
      async chat() {
        ac.abort();
        throw new Error('terminated');
      },
    };
    await expect(new ResilientModel(m, undefined, fast).chat([], [], () => undefined, ac.signal)).rejects.toThrow('terminated');
  });

  it('★ 主模型耗尽后切降级模型，重试信息标记 fallback', async () => {
    const p = scripted('deep', ['err5xx', 'err5xx', 'err5xx']);
    const f = scripted('fast', ['ok']);
    const c = collect();
    const res = await new ResilientModel(p, f, fast).chat([], [], c.onDelta, sig());
    expect(res.text).toBe('完整');
    expect(p.calls).toBe(3);
    expect(f.calls).toBe(1);
    const last = c.retries.at(-1)!;
    expect(last).toMatchObject({ attempt: 3, fallback: true, model: 'fast' });
  });

  it('主模型与降级都失败：抛出最后一个错误', async () => {
    const p = scripted('deep', ['conn']);
    const f = scripted('fast', ['err5xx']);
    // 抛出的是降级模型的原始错误对象（保留 status 等字段），消息即模型返回的文本
    await expect(new ResilientModel(p, f, { ...fast, maxAttempts: 1 }).chat([], [], () => undefined, sig())).rejects.toThrow('Service Unavailable');
  });

  it('★ 连续失败触发熔断：冷却期内快速失败且不再调用模型，冷却后半开恢复', async () => {
    let t = 1_000_000;
    const opts = { ...fast, maxAttempts: 1, breakerThreshold: 3, breakerCooldownMs: 30_000, now: () => t };
    const bad = scripted('p', ['err5xx']);
    for (let i = 0; i < 3; i++) await new ResilientModel(bad, undefined, opts).chat([], [], () => undefined, sig()).catch(() => undefined);
    expect(bad.calls).toBe(3);
    // 熔断中：直接失败，模型未被调用
    await expect(new ResilientModel(bad, undefined, opts).chat([], [], () => undefined, sig())).rejects.toThrow('熔断中');
    expect(bad.calls).toBe(3);
    // 冷却结束：允许探测，成功后计数清零
    t += 31_000;
    const good = scripted('p', ['ok']);
    const res = await new ResilientModel(good, undefined, opts).chat([], [], () => undefined, sig());
    expect(res.text).toBe('完整');
  });

  it('★ 30% 随机瞬时失败（模拟 vLLM 抖动）下 40 次调用全部成功', async () => {
    let seed = 42;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    let calls = 0;
    const flaky: ChatModel = {
      name: 'vllm',
      async chat(_m, _t, onDelta) {
        calls++;
        const r = rand();
        if (r < 0.15) throw httpErr(503);
        if (r < 0.3) {
          onDelta({ textDelta: '半' });
          throw new Error('terminated');
        }
        onDelta({ textDelta: '好' });
        return ok('好');
      },
    };
    // 单次成功率 70%，8 次尝试内全失败的概率 ≈ 0.3^8 ≈ 0.007%，40 次调用应全部成功
    const rm = new ResilientModel(flaky, undefined, { ...fast, maxAttempts: 8, breakerThreshold: 100 });
    let success = 0;
    for (let i = 0; i < 40; i++) {
      const res = await rm.chat([], [], () => undefined, sig());
      if (res.text === '好') success++;
    }
    expect(success).toBe(40);
    expect(calls).toBeGreaterThan(40); // 确实发生过重试
  });
});
