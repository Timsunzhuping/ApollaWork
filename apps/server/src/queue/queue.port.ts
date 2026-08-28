/**
 * 队列抽象（生产 P1）。
 * - InprocQueue：单副本内存队列（开发/单机部署）。进程退出未执行的任务由启动恢复兜底。
 * - BullQueue：BullMQ + Redis，多副本共享队列，支持负载均衡、重试与「副本崩溃后任务被他人接管」。
 */
export interface TaskQueue {
  /** 入队一个任务 id */
  enqueue(taskId: string): Promise<void>;
  /** 注册消费者（由 TaskManager 提供实际执行逻辑） */
  consume(handler: (taskId: string) => Promise<void>): void;
  /** 当前等待数（可观测） */
  size(): Promise<number>;
  close(): Promise<void>;
  readonly kind: 'inproc' | 'bullmq';
}
