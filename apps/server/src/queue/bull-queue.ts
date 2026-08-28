import { Queue, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import type { TaskQueue } from './queue.port.js';

/**
 * BullMQ 队列（多副本）。任务 id 入 Redis 队列，任一副本的 Worker 可领取执行 ——
 * 天然负载均衡；副本崩溃时 job 会被重新投递给其他副本（stalled 检测）。
 */
export class BullQueue implements TaskQueue {
  readonly kind = 'bullmq' as const;
  private queue: Queue;
  private worker?: Worker;
  private connection: IORedis;

  constructor(
    redisUrl: string,
    private concurrency: number,
  ) {
    this.connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    this.queue = new Queue('apolla-tasks', { connection: this.connection });
  }

  async enqueue(taskId: string) {
    await this.queue.add(
      'run',
      { taskId },
      {
        jobId: taskId, // 幂等：同一任务不会重复入队
        removeOnComplete: 1000,
        removeOnFail: 5000,
        attempts: 1, // Agent 任务有副作用，不自动重试；失败交由用户决定
      },
    );
  }

  consume(handler: (taskId: string) => Promise<void>) {
    this.worker = new Worker(
      'apolla-tasks',
      async (job: Job<{ taskId: string }>) => handler(job.data.taskId),
      { connection: this.connection, concurrency: this.concurrency },
    );
  }

  async size() {
    return this.queue.getWaitingCount();
  }

  async close() {
    await this.worker?.close();
    await this.queue.close();
    this.connection.disconnect();
  }
}
