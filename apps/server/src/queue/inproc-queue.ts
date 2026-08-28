import type { TaskQueue } from './queue.port.js';

/** 单副本内存队列：受 maxConcurrent 限流。 */
export class InprocQueue implements TaskQueue {
  readonly kind = 'inproc' as const;
  private q: string[] = [];
  private active = 0;
  private handler?: (taskId: string) => Promise<void>;

  constructor(private maxConcurrent: number) {}

  async enqueue(taskId: string) {
    this.q.push(taskId);
    this.pump();
  }

  consume(handler: (taskId: string) => Promise<void>) {
    this.handler = handler;
    this.pump();
  }

  private pump() {
    if (!this.handler) return;
    while (this.active < this.maxConcurrent && this.q.length) {
      const id = this.q.shift()!;
      this.active++;
      void this.handler(id).finally(() => {
        this.active--;
        this.pump();
      });
    }
  }

  async size() {
    return this.q.length;
  }

  async close() {
    this.q = [];
  }
}
