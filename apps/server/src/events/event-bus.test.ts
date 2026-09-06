import { describe, expect, it, beforeEach } from 'vitest';
import type { TaskEvent } from '@apolla/protocol';
import { EventBus } from './event-bus.service.js';

/** 内存版 Prisma 替身，仅实现 EventBus 用到的 taskEventRow 方法。 */
class FakePrisma {
  rows: { taskId: string; seq: number; type: string; payload: string; ts: Date }[] = [];
  taskEventRow = {
    create: async ({ data }: any) => {
      this.rows.push(data);
      return data;
    },
    findMany: async ({ where, orderBy }: any) => {
      let r = this.rows.filter((x) => x.taskId === where.taskId);
      if (where.seq?.gt !== undefined) r = r.filter((x) => x.seq > where.seq.gt);
      r = [...r].sort((a, b) => (orderBy.seq === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      return r;
    },
    findFirst: async ({ where }: any) => {
      const r = this.rows.filter((x) => x.taskId === where.taskId).sort((a, b) => b.seq - a.seq);
      return r[0] ?? null;
    },
  };
}

let bus: EventBus;
let fake: FakePrisma;

beforeEach(() => {
  fake = new FakePrisma();
  bus = new EventBus(fake as never, { clusterMode: false, redisUrl: '' } as never);
});

const ev = (n: number): TaskEvent => ({
  v: 1,
  type: 'message.delta',
  messageId: 'm',
  delta: `d${n}`,
});

describe('EventBus（T-103 事件溯源）', () => {
  it('★ 并发 fire-and-forget 发布：即便 DB 写入乱序完成，投递仍严格按 seq 顺序（T-411 e2e 暴露的丢事件根因）', async () => {
    // DB 写入随机延迟：seq 大的可能先落库。旧实现投递顺序跟随落库顺序 → SSE 端单调过滤丢掉小 seq。
    const slow = new FakePrisma();
    slow.taskEventRow.create = async ({ data }: any) => {
      await new Promise((r) => setTimeout(r, Math.random() * 20));
      slow.rows.push(data);
      return data;
    };
    const b = new EventBus(slow as never, { clusterMode: false, redisUrl: '' } as never);
    const delivered: number[] = [];
    b.subscribe('t1', (rec) => delivered.push(rec.seq));
    const all = Array.from({ length: 12 }, (_, i) => b.publish('t1', ev(i + 1))); // 调用方不 await
    await Promise.all(all);
    expect(delivered).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  });

  it('seq 单调递增', async () => {
    const a = await bus.publish('t1', ev(1));
    const b = await bus.publish('t1', ev(2));
    const c = await bus.publish('t1', ev(3));
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3]);
  });

  it('不同任务的 seq 相互独立', async () => {
    await bus.publish('t1', ev(1));
    const other = await bus.publish('t2', ev(1));
    expect(other.seq).toBe(1);
  });

  it('回放返回与发布一致的完整序列（replay == live）', async () => {
    const live: TaskEvent[] = [];
    const unsub = bus.subscribe('t1', (rec) => live.push(rec.event));
    for (let i = 1; i <= 5; i++) await bus.publish('t1', ev(i));
    unsub();

    const replayed = await bus.replay('t1', 0);
    expect(replayed.map((r) => r.event)).toEqual(live);
    expect(replayed.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it('Last-Event-ID 断点续传：只回放 seq 之后的事件', async () => {
    for (let i = 1; i <= 5; i++) await bus.publish('t1', ev(i));
    const after3 = await bus.replay('t1', 3);
    expect(after3.map((r) => r.seq)).toEqual([4, 5]);
  });

  it('订阅者只收到订阅后的事件；退订后不再收到', async () => {
    await bus.publish('t1', ev(1)); // 订阅前
    const got: number[] = [];
    const unsub = bus.subscribe('t1', (rec) => got.push(rec.seq));
    await bus.publish('t1', ev(2));
    await bus.publish('t1', ev(3));
    unsub();
    await bus.publish('t1', ev(4)); // 退订后
    expect(got).toEqual([2, 3]);
  });

  it('primeSeq 从持久化恢复计数（进程重启续期）', async () => {
    for (let i = 1; i <= 3; i++) await bus.publish('t1', ev(i));
    const bus2 = new EventBus(fake as never, { clusterMode: false, redisUrl: '' } as never); // 模拟新进程
    await bus2.primeSeq('t1');
    const next = await bus2.publish('t1', ev(4));
    expect(next.seq).toBe(4);
  });
});
