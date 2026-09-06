import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskEvent } from '@apolla/protocol';
import { streamTask } from './api';

/**
 * 任务事件流客户端（T-408/T-411）：用假 EventSource 复刻服务端行为，验证
 * 断线换令牌带 lastEventId 重连、重连回放的重复事件按 seq 去重、done 收尾。
 */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string; lastEventId: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, (() => void)[]>();
  closed = false;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, cb: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
  }
  close() {
    this.closed = true;
  }
  // 测试驱动
  emit(seq: number, event: unknown) {
    this.onmessage?.({ data: JSON.stringify(event), lastEventId: String(seq) });
  }
  fail() {
    this.onerror?.();
  }
  done() {
    for (const cb of this.listeners.get('done') ?? []) cb();
  }
}

const ev = (type: string): TaskEvent => ({ v: 1, type, status: 'running' }) as unknown as TaskEvent;

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const flush = () => vi.advanceTimersByTimeAsync(0);

describe('streamTask', () => {
  it('收到事件回调带 seq；done 后调用 onDone 并关闭', async () => {
    const got: number[] = [];
    const onDone = vi.fn();
    streamTask('t1', (_e, seq) => got.push(seq), onDone);
    await flush();
    const es = FakeEventSource.instances[0]!;
    expect(es.url).toContain('/tasks/t1/events');
    es.emit(1, ev('task.created'));
    es.emit(2, ev('task.status'));
    es.done();
    expect(got).toEqual([1, 2]);
    expect(onDone).toHaveBeenCalled();
    expect(es.closed).toBe(true);
  });

  it('★ 断线后自己重连：带 lastEventId 续传，指数退避', async () => {
    const got: number[] = [];
    streamTask('t1', (_e, seq) => got.push(seq), () => undefined);
    await flush();
    const first = FakeEventSource.instances[0]!;
    first.emit(1, ev('a'));
    first.emit(2, ev('b'));
    first.fail(); // 服务端断连（如令牌过期 401）
    expect(first.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000); // 首次退避 1s
    await flush();
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1]!.url).toContain('lastEventId=2');
  });

  it('★ 重连回放重复事件按 seq 去重，不会重复渲染', async () => {
    const got: number[] = [];
    streamTask('t1', (_e, seq) => got.push(seq), () => undefined);
    await flush();
    const first = FakeEventSource.instances[0]!;
    first.emit(1, ev('a'));
    first.emit(2, ev('b'));
    first.emit(3, ev('c'));
    first.fail();
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    const second = FakeEventSource.instances[1]!;
    second.emit(2, ev('b')); // 服务端从 lastEventId 之后回放，但保守多发了一条
    second.emit(3, ev('c'));
    second.emit(4, ev('d'));
    expect(got).toEqual([1, 2, 3, 4]);
  });

  it('取消后不再重连', async () => {
    const cancel = streamTask('t1', () => undefined, () => undefined);
    await flush();
    const first = FakeEventSource.instances[0]!;
    cancel();
    first.fail();
    await vi.advanceTimersByTimeAsync(5000);
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});
