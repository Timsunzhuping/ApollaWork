import type { ChatMessage, ChatModel, ModelDelta, ModelResult, ToolSpec } from './model.js';

/** 一次重试/降级的说明，经 onDelta({ retry }) 上报给 loop → 事件 model.retry → 时间线可见 */
export interface RetryInfo {
  /** 第几次尝试失败后触发（1 起） */
  attempt: number;
  maxAttempts: number;
  reason: string;
  /** 本次是否切到了降级模型 */
  fallback: boolean;
  /** 接下来要调用的模型名 */
  model: string;
  /** 失败前是否已经流出过部分文本（UI 需丢弃这段） */
  streamedPartial: boolean;
}

export interface ResilientOptions {
  /** 每个模型最多尝试次数（含首次） */
  maxAttempts?: number;
  /** 首次退避（毫秒），之后指数增长并带抖动 */
  baseDelayMs?: number;
  /** 连续失败多少次熔断 */
  breakerThreshold?: number;
  /** 熔断持续（毫秒） */
  breakerCooldownMs?: number;
  /** 测试注入 */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface BreakerState {
  failures: number;
  openedAt?: number;
}

/** 熔断器按模型名记在模块级：同进程内所有任务共享（本地执行器 / CLI / 评测） */
const breakers = new Map<string, BreakerState>();
export function resetBreakers() {
  breakers.clear();
}

/**
 * 判定是否「瞬时失败」：值得重试的是网关抖动、限流、超时、连接被重置、流中途断开；
 * 参数错误（4xx）、鉴权失败、用户取消、出网被策略拒绝 —— 重试也不会变好，直接抛出。
 */
export function isTransientError(e: unknown): boolean {
  const err = e as { status?: number; name?: string; message?: string; code?: string; cause?: { code?: string } };
  if (err?.name === 'APIUserAbortError' || err?.name === 'AbortError') return false;
  const msg = `${err?.message ?? ''} ${err?.code ?? ''} ${err?.cause?.code ?? ''}`;
  if (/出网被拒|不在出网白名单/.test(msg)) return false;
  if (typeof err?.status === 'number') {
    return err.status === 408 || err.status === 409 || err.status === 425 || err.status === 429 || err.status >= 500;
  }
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|socket hang up|fetch failed|terminated|aborted|Premature close|中继空闲超时|network|timeout/i.test(
    msg,
  );
}

/** 错误说明：带上 HTTP 状态码，UI 与日志一眼看出是限流还是网关 5xx */
export function describeError(e: unknown): string {
  const err = e as { status?: number; message?: string };
  const msg = err?.message ?? String(e);
  return typeof err?.status === 'number' && !msg.includes(String(err.status)) ? `HTTP ${err.status}: ${msg}` : msg;
}

/**
 * 模型调用韧性（T-409）：重试 + 降级 + 熔断。
 * openai SDK 只重试「请求发起」阶段；流式输出中途断开会直接把整个任务打失败 ——
 * 生产 vLLM 抖动是常态。这里对整次调用做指数退避重试（丢弃已流出的半截文本并告知 UI），
 * 主模型耗尽后切降级模型，连续失败达到阈值则熔断一段时间快速失败，避免把队列拖死。
 */
export class ResilientModel implements ChatModel {
  readonly name: string;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(
    private readonly primary: ChatModel,
    private readonly fallback?: ChatModel,
    opts: ResilientOptions = {},
  ) {
    this.name = primary.name;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.baseDelayMs = opts.baseDelayMs ?? 500;
    this.threshold = opts.breakerThreshold ?? 5;
    this.cooldownMs = opts.breakerCooldownMs ?? 30_000;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? (() => Date.now());
  }

  private breaker(model: ChatModel): BreakerState {
    let b = breakers.get(model.name);
    if (!b) {
      b = { failures: 0 };
      breakers.set(model.name, b);
    }
    return b;
  }

  /** 熔断中返回剩余秒数，否则 0 */
  private openFor(model: ChatModel): number {
    const b = this.breaker(model);
    if (b.openedAt === undefined) return 0;
    const left = b.openedAt + this.cooldownMs - this.now();
    if (left > 0) return Math.ceil(left / 1000);
    // 冷却结束：半开，允许探测一次
    b.openedAt = undefined;
    b.failures = 0;
    return 0;
  }

  async chat(
    messages: ChatMessage[],
    tools: ToolSpec[],
    onDelta: (d: ModelDelta) => void,
    signal: AbortSignal,
  ): Promise<ModelResult> {
    const candidates = [
      { model: this.primary, fallback: false },
      ...(this.fallback && this.fallback.name !== this.primary.name ? [{ model: this.fallback, fallback: true }] : []),
    ];
    let lastErr: unknown = new Error('模型不可用');

    for (let ci = 0; ci < candidates.length; ci++) {
      const cand = candidates[ci]!;
      const breaker = this.breaker(cand.model);

      for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
        const left = this.openFor(cand.model);
        if (left > 0) {
          lastErr = new Error(`模型 ${cand.model.name} 熔断中（连续失败 ${breaker.failures} 次），约 ${left}s 后恢复`);
          break; // 换下一个候选
        }
        let streamed = false;
        try {
          const res = await cand.model.chat(
            messages,
            tools,
            (d) => {
              if (d.textDelta) streamed = true;
              onDelta(d);
            },
            signal,
          );
          breaker.failures = 0;
          return res;
        } catch (e) {
          lastErr = e;
          if (signal.aborted || !isTransientError(e)) throw e;
          breaker.failures++;
          if (breaker.failures >= this.threshold) breaker.openedAt = this.now();

          const exhausted = attempt >= this.maxAttempts;
          const next = exhausted ? candidates[ci + 1] : cand;
          if (!next) break; // 没有下一步了，跳出后抛 lastErr
          onDelta({
            retry: {
              attempt,
              maxAttempts: this.maxAttempts,
              reason: describeError(e),
              fallback: next.fallback,
              model: next.model.name,
              streamedPartial: streamed,
            },
          });
          if (exhausted) break; // 交给外层循环切候选
          const backoff = this.baseDelayMs * 2 ** (attempt - 1) * (0.8 + Math.random() * 0.4);
          await this.sleep(backoff);
        }
      }
    }
    throw lastErr;
  }
}
