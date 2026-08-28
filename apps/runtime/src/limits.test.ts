import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TaskEvent } from '@apolla/protocol';
import { AgentLoop } from './loop.js';
import type { EventSink, ControlSource } from './emitter.js';
import type { ChatModel } from './model.js';

/**
 * 单任务上限测试（生产成本/容量控制）。
 * 此前只有步数上限（40 步）：慢模型下 40 × 100 秒 = 一小时，
 * 单任务能长期占住并发槽位；且配额只在建任务时检查，
 * 一个失控循环可以在下次检查前烧掉整月预算。
 */
class Sink implements EventSink {
  events: TaskEvent[] = [];
  emit(e: TaskEvent) {
    this.events.push(e);
  }
}
class Ctl implements ControlSource {
  async waitApproval() { return true; }
  async waitAnswer() { return 'x'; }
  drainUserInputs() { return []; }
  isCancelled() { return false; }
}

/** 永远要求继续调用工具的模型 —— 模拟失控循环 */
class LoopingModel implements ChatModel {
  readonly name = 'looping';
  constructor(private tokensPerCall = 100, private delayMs = 0) {}
  async chat(_m: never[], _t: never[], onDelta: (d: { textDelta?: string }) => void) {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    onDelta({ textDelta: '继续' });
    return {
      text: '继续',
      toolCalls: [{ id: `c${Math.random()}`, name: 'TodoWrite', arguments: JSON.stringify({ items: [] }) }],
      usage: { inTokens: this.tokensPerCall, outTokens: this.tokensPerCall },
      finishReason: 'tool_calls',
    };
  }
}

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), 'apolla-lim-'));
const opts = (model: ChatModel, extra: Record<string, unknown>) => ({
  workspaceDir: ws(),
  mode: 'auto' as const,
  model,
  skills: [],
  prompt: '一直做下去',
  webEnabled: false,
  webfetchAllowlist: [],
  now: new Date().toISOString(),
  ...extra,
});

describe('单任务上限', () => {
  it('★ token 预算耗尽时停止（防失控循环烧掉整月预算）', async () => {
    const sink = new Sink();
    // 每次调用 200 token，预算 1000 → 最多几步就该停
    const loop = new AgentLoop(
      opts(new LoopingModel(100), { maxTokens: 1000, maxSteps: 100, maxDurationMs: 0 }),
      sink,
      new Ctl(),
    );
    const r = await loop.run();
    expect(r.status).toBe('completed');
    expect(r.summary).toContain('预算上限');
    const used = loop.usage.inTokens + loop.usage.outTokens;
    expect(used).toBeLessThan(2000); // 远小于 100 步 × 200 = 20000
  });

  it('★ 墙钟时长上限生效（慢模型下步数上限形同虚设）', async () => {
    const sink = new Sink();
    const loop = new AgentLoop(
      // 每次调用 60ms，100 步本会跑 6 秒；限时 300ms 应提前停
      opts(new LoopingModel(10, 60), { maxDurationMs: 300, maxSteps: 100, maxTokens: 0 }),
      sink,
      new Ctl(),
    );
    const t0 = Date.now();
    const r = await loop.run();
    const elapsed = Date.now() - t0;
    expect(r.summary).toContain('时长上限');
    expect(elapsed).toBeLessThan(3000);
  });

  it('停止时把已产出内容告知用户，而不是静默失败', async () => {
    const sink = new Sink();
    const loop = new AgentLoop(
      opts(new LoopingModel(100), { maxTokens: 500, maxSteps: 100, maxDurationMs: 0 }),
      sink,
      new Ctl(),
    );
    const r = await loop.run();
    expect(r.summary).toMatch(/已产出的内容仍可使用/);
    // 用户能在事件流里看到这条说明
    expect(sink.events.some((e) => e.type === 'message.completed' && e.text.includes('上限'))).toBe(true);
  });

  it('设为 0 表示不限（保留给特殊场景）', async () => {
    const sink = new Sink();
    const loop = new AgentLoop(
      opts(new LoopingModel(10), { maxTokens: 0, maxDurationMs: 0, maxSteps: 3 }),
      sink,
      new Ctl(),
    );
    const r = await loop.run();
    // 只受步数限制，跑满 3 步
    expect(r.summary).toContain('最大步数');
  });
});
