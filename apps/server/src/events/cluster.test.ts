import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { EventBus } from './event-bus.service.js';
import type { TaskEvent } from '@apolla/protocol';

/**
 * 跨副本事件分发测试（生产 P1）。
 * 用一个遵循 ioredis pub/sub 语义的内存假实现（共享 broker），
 * 验证「任务在 A 副本执行、SSE 连在 B 副本」时用户仍能收到全部事件，
 * 且 A 副本本地订阅者不会因 Redis 回声收到重复事件。
 */

/** 进程间共享的假 broker */
const broker = {
  subscribers: [] as { patterns: string[]; handler: (p: string, c: string, m: string) => void }[],
  publish(channel: string, message: string) {
    for (const s of this.subscribers) {
      for (const p of s.patterns) {
        const re = new RegExp('^' + p.replace(/\*/g, '.*') + '$');
        if (re.test(channel)) s.handler(p, channel, message);
      }
    }
  },
  reset() {
    this.subscribers = [];
  },
};

/** 共享计数器空间：模拟 Redis 的跨进程原子性 */
const counters = new Map<string, number>();

class FakeRedis {
  private patterns: string[] = [];
  private handler?: (p: string, c: string, m: string) => void;
  async connect() {}
  async incr(key: string) {
    const v = (counters.get(key) ?? 0) + 1;
    counters.set(key, v);
    return v;
  }
  async incrby(key: string, by: number) {
    const v = (counters.get(key) ?? 0) + by;
    counters.set(key, v);
    return v;
  }
  async expire() {
    return 1;
  }
  async psubscribe(...patterns: string[]) {
    this.patterns.push(...patterns);
    broker.subscribers.push({
      patterns: this.patterns,
      handler: (p, c, m) => this.handler?.(p, c, m),
    });
  }
  on(event: string, cb: (p: string, c: string, m: string) => void) {
    if (event === 'pmessage') this.handler = cb;
  }
  async publish(channel: string, message: string) {
    broker.publish(channel, message);
    return 1;
  }
  async quit() {}
}

/** 每个"副本"独立一份事件表（模拟共享 DB：这里用同一个数组） */
const sharedRows: any[] = [];
class SharedPrisma {
  taskEventRow = {
    create: async ({ data }: any) => {
      sharedRows.push(data);
      return data;
    },
    findMany: async ({ where, orderBy }: any) => {
      let r = sharedRows.filter((x) => x.taskId === where.taskId);
      if (where.seq?.gt !== undefined) r = r.filter((x) => x.seq > where.seq.gt);
      return [...r].sort((a, b) => (orderBy.seq === 'asc' ? a.seq - b.seq : b.seq - a.seq));
    },
    findFirst: async ({ where }: any) => {
      const r = sharedRows.filter((x) => x.taskId === where.taskId).sort((a, b) => b.seq - a.seq);
      return r[0] ?? null;
    },
  };
}

const clusterCfg = { clusterMode: true, redisUrl: 'redis://fake' } as never;
const ev = (n: number): TaskEvent => ({ v: 1, type: 'message.delta', messageId: 'm', delta: `d${n}` });

let replicaA: EventBus;
let replicaB: EventBus;
let origFactory: typeof EventBus.redisFactory;

beforeEach(async () => {
  broker.reset();
  counters.clear();
  sharedRows.length = 0;
  origFactory = EventBus.redisFactory;
  EventBus.redisFactory = () => new FakeRedis() as never;
  replicaA = new EventBus(new SharedPrisma() as never, clusterCfg);
  replicaB = new EventBus(new SharedPrisma() as never, clusterCfg);
  await replicaA.onModuleInit();
  await replicaB.onModuleInit();
});

afterEach(() => {
  EventBus.redisFactory = origFactory;
});

describe('多副本事件分发（P1：修复前多副本下用户看不到进度）', () => {
  it('集群模式下启用 Redis 分发', () => {
    expect(replicaA.mode).toBe('redis');
    expect(replicaB.mode).toBe('redis');
  });

  it('★ 任务在 A 副本执行，SSE 连在 B 副本 —— B 的订阅者收到全部事件', async () => {
    const seenOnB: number[] = [];
    replicaB.subscribe('task-1', (rec) => seenOnB.push(rec.seq));

    // A 副本执行任务并发布事件
    await replicaA.publish('task-1', ev(1));
    await replicaA.publish('task-1', ev(2));
    await replicaA.publish('task-1', ev(3));

    expect(seenOnB).toEqual([1, 2, 3]);
  });

  it('★ 发布副本上的本地订阅者不会收到重复（Redis 回声被 instanceId 过滤）', async () => {
    const seenOnA: number[] = [];
    replicaA.subscribe('task-2', (rec) => seenOnA.push(rec.seq));
    await replicaA.publish('task-2', ev(1));
    await replicaA.publish('task-2', ev(2));
    expect(seenOnA).toEqual([1, 2]); // 而不是 [1,1,2,2]
  });

  it('两个副本各有订阅者时，双方都恰好收到一次', async () => {
    const a: number[] = [];
    const b: number[] = [];
    replicaA.subscribe('task-3', (r) => a.push(r.seq));
    replicaB.subscribe('task-3', (r) => b.push(r.seq));
    await replicaA.publish('task-3', ev(1));
    await replicaB.publish('task-3', ev(2)); // 另一副本也可发布（如审批解决）
    expect(a).toEqual([1, 2]);
    expect(b).toEqual([1, 2]);
  });

  it('回放走共享 DB —— 任一副本都能补齐历史（SSE 重连跨副本）', async () => {
    await replicaA.publish('task-4', ev(1));
    await replicaA.publish('task-4', ev(2));
    const replayedOnB = await replicaB.replay('task-4', 0);
    expect(replayedOnB.map((r) => r.seq)).toEqual([1, 2]);
    const afterFirst = await replicaB.replay('task-4', 1);
    expect(afterFirst.map((r) => r.seq)).toEqual([2]);
  });

  it('Redis 不可用时自动退化为进程内分发（不影响单机可用性）', async () => {
    EventBus.redisFactory = () => {
      throw new Error('redis down');
    };
    const solo = new EventBus(new SharedPrisma() as never, clusterCfg);
    await solo.onModuleInit();
    expect(solo.mode).toBe('inproc');
    const seen: number[] = [];
    solo.subscribe('task-5', (r) => seen.push(r.seq));
    await solo.publish('task-5', ev(1));
    expect(seen).toEqual([1]); // 本地仍正常
  });
});
