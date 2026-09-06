import { describe, expect, it } from 'vitest';
import type { TaskEventRecord } from '@apolla/protocol';
import { SseGate } from './sse-gate.js';

/** SSE 投递闸门：先订阅再回放不丢事件；乱序不丢事件；重复不重投 */
const rec = (seq: number): TaskEventRecord =>
  ({ taskId: 't', seq, ts: '2026-01-01T00:00:00.000Z', event: { v: 1, type: 'task.status', status: 'running' } }) as TaskEventRecord;

describe('SseGate', () => {
  it('★ 回放期间到达的实时事件先暂存，回放结束后按 seq 放行，不丢', () => {
    const out: number[] = [];
    const g = new SseGate(0);
    g.live(rec(5), (r) => out.push(r.seq)); // 回放尚未结束就来了
    g.live(rec(4), (r) => out.push(r.seq));
    g.replayed(1);
    g.replayed(2);
    g.replayed(3);
    g.markReady((r) => out.push(r.seq));
    expect(out).toEqual([4, 5]);
  });

  it('★ 实时乱序：大 seq 先到不会让后到的小 seq 被丢弃（旧逻辑会丢）', () => {
    const out: number[] = [];
    const g = new SseGate(0);
    g.markReady(() => undefined);
    for (const s of [7, 4, 5, 6]) g.live(rec(s), (r) => out.push(r.seq));
    expect(out.sort((a, b) => a - b)).toEqual([4, 5, 6, 7]);
  });

  it('重复 seq 只投一次；客户端已有（≤ Last-Event-ID）的不投', () => {
    const out: number[] = [];
    const g = new SseGate(3);
    g.markReady(() => undefined);
    for (const s of [2, 3, 4, 4, 5, 4]) g.live(rec(s), (r) => out.push(r.seq));
    expect(out).toEqual([4, 5]);
  });

  it('回放过的 seq 若又经实时到达（回放与订阅重叠窗口）也不重投', () => {
    const out: number[] = [];
    const g = new SseGate(0);
    g.live(rec(3), (r) => out.push(r.seq));
    g.replayed(1);
    g.replayed(2);
    g.replayed(3); // 回放也拿到了 3
    g.markReady((r) => out.push(r.seq));
    g.live(rec(4), (r) => out.push(r.seq));
    expect(out).toEqual([4]);
    expect(g.maxSeq).toBe(4);
  });
});
