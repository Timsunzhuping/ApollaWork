import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import type { TaskEvent, TaskEventRecord } from '@apolla/protocol';
import { PrismaService } from '../prisma.service.js';
import { CONFIG, type AppConfig } from '../config.js';

type Listener = (rec: TaskEventRecord) => void;

/**
 * 事件总线（PRD §4.8）：事件是唯一真相。
 *
 * 生产 P1 修复 —— 原实现是进程内 Map，多副本部署时「任务在 A 副本执行、
 * 用户的 SSE 连在 B 副本」会导致完全看不到进度。现在：
 *   - 持久化仍写 TaskEventRow（单调 seq，回放与审计的真相）；
 *   - 跨副本分发经 Redis Pub/Sub（配置 REDIS_URL 且 queueDriver/多副本时启用）；
 *   - 单机无 Redis 时自动退化为进程内分发，行为不变。
 *
 * seq 分配：不能假设单写者 —— 任务在 A 副本执行的同时，审批/追加指令可能由
 * B 副本处理并发事件。集群模式下用 Redis INCR 原子分配（首次从 DB 最大值预热），
 * 单副本模式用本地计数器。DB 上 (taskId, seq) 唯一约束是最后一道保险。
 */
@Injectable()
export class EventBus implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('EventBus');
  private listeners = new Map<string, Set<Listener>>();
  private seqCounters = new Map<string, number>();
  /** 本副本标识：用于跳过自己发出的 Redis 回声，避免重复投递 */
  private readonly instanceId = randomUUID();
  private pub?: Redis;
  private sub?: Redis;
  private redisReady = false;

  /** 可注入的 Redis 工厂（测试用假实现；生产为真实 ioredis）。 */
  static redisFactory: (url: string) => Redis = (url) =>
    new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: true });

  constructor(
    private prisma: PrismaService,
    @Inject(CONFIG) private config: AppConfig,
  ) {}

  async onModuleInit() {
    if (!this.config.clusterMode) {
      this.log.log('事件分发：进程内（单副本模式）');
      return;
    }
    try {
      this.pub = EventBus.redisFactory(this.config.redisUrl);
      this.sub = EventBus.redisFactory(this.config.redisUrl);
      await this.pub.connect();
      await this.sub.connect();
      await this.sub.psubscribe('apolla:events:*');
      this.sub.on('pmessage', (_pattern, channel, message) => {
        try {
          const parsed = JSON.parse(message) as { from: string; rec: TaskEventRecord };
          if (parsed.from === this.instanceId) return; // 自己的回声，本地已投递
          const taskId = channel.slice('apolla:events:'.length);
          this.deliverLocal(taskId, parsed.rec);
        } catch {
          /* 忽略坏消息 */
        }
      });
      this.redisReady = true;
      this.log.log(`事件分发：Redis Pub/Sub（集群模式，实例 ${this.instanceId.slice(0, 8)}）`);
    } catch (e) {
      this.log.error(`Redis 连接失败，退化为进程内分发：${(e as Error).message}`);
    }
  }

  async onModuleDestroy() {
    await this.pub?.quit().catch(() => undefined);
    await this.sub?.quit().catch(() => undefined);
  }

  /** 原子分配下一个 seq：集群走 Redis INCR，单机走本地计数器。 */
  private async nextSeq(taskId: string): Promise<number> {
    if (this.redisReady && this.pub) {
      const key = `apolla:seq:${taskId}`;
      const val = await this.pub.incr(key);
      if (val === 1) {
        // 首次使用：从 DB 已有最大 seq 预热，避免重启后从 1 开始撞号
        const last = await this.prisma.taskEventRow.findFirst({
          where: { taskId },
          orderBy: { seq: 'desc' },
        });
        if (last && last.seq >= 1) {
          const primed = await this.pub.incrby(key, last.seq);
          await this.pub.expire(key, 86400);
          return primed;
        }
        await this.pub.expire(key, 86400); // 24h 后回收，任务早已结束
      }
      return val;
    }
    const seq = (this.seqCounters.get(taskId) ?? 0) + 1;
    this.seqCounters.set(taskId, seq);
    return seq;
  }

  async publish(taskId: string, event: TaskEvent): Promise<TaskEventRecord> {
    const seq = await this.nextSeq(taskId);
    const ts = new Date().toISOString();
    const rec: TaskEventRecord = { taskId, seq, ts, event };

    await this.prisma.taskEventRow.create({
      data: { taskId, seq, type: event.type, payload: JSON.stringify(event), ts: new Date(ts) },
    });

    this.deliverLocal(taskId, rec);

    if (this.redisReady && this.pub) {
      // 跨副本广播（失败不影响主流程：DB 已落库，客户端可用 Last-Event-ID 补齐）
      this.pub
        .publish(`apolla:events:${taskId}`, JSON.stringify({ from: this.instanceId, rec }))
        .catch(() => undefined);
    }
    return rec;
  }

  private deliverLocal(taskId: string, rec: TaskEventRecord) {
    const set = this.listeners.get(taskId);
    if (set) for (const l of set) l(rec);
  }

  subscribe(taskId: string, listener: Listener): () => void {
    let set = this.listeners.get(taskId);
    if (!set) {
      set = new Set();
      this.listeners.set(taskId, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.listeners.delete(taskId);
    };
  }

  /** 回放：取 seq > afterSeq 的历史事件（SSE Last-Event-ID 重连用；跨副本天然可用，因为读的是共享 DB）。 */
  async replay(taskId: string, afterSeq = 0): Promise<TaskEventRecord[]> {
    const rows = await this.prisma.taskEventRow.findMany({
      where: { taskId, seq: { gt: afterSeq } },
      orderBy: { seq: 'asc' },
    });
    return rows.map((r) => ({
      taskId,
      seq: r.seq,
      ts: r.ts.toISOString(),
      event: JSON.parse(r.payload) as TaskEvent,
    }));
  }

  /** 从 DB 恢复 seq 计数（进程重启后继续任务时用）。 */
  async primeSeq(taskId: string) {
    const last = await this.prisma.taskEventRow.findFirst({
      where: { taskId },
      orderBy: { seq: 'desc' },
    });
    if (last) this.seqCounters.set(taskId, last.seq);
  }

  get mode() {
    return this.redisReady ? 'redis' : 'inproc';
  }
}
