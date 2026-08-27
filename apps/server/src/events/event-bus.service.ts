import { Injectable } from '@nestjs/common';
import type { TaskEvent, TaskEventRecord } from '@apolla/protocol';
import { PrismaService } from '../prisma.service.js';

type Listener = (rec: TaskEventRecord) => void;

/**
 * 事件总线（PRD §4.8）：事件是唯一真相。
 * - 持久化到 TaskEventRow（单调 seq），供回放；
 * - 内存 pub/sub 供 SSE 实时扇出。
 * 单机进程内实现；集群版换 Redis Streams（保持同一接口）。
 */
@Injectable()
export class EventBus {
  private listeners = new Map<string, Set<Listener>>();
  private seqCounters = new Map<string, number>();

  constructor(private prisma: PrismaService) {}

  async publish(taskId: string, event: TaskEvent): Promise<TaskEventRecord> {
    const seq = (this.seqCounters.get(taskId) ?? 0) + 1;
    this.seqCounters.set(taskId, seq);
    const ts = new Date().toISOString();
    const rec: TaskEventRecord = { taskId, seq, ts, event };
    await this.prisma.taskEventRow.create({
      data: { taskId, seq, type: event.type, payload: JSON.stringify(event), ts: new Date(ts) },
    });
    const set = this.listeners.get(taskId);
    if (set) for (const l of set) l(rec);
    return rec;
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

  /** 回放：取 seq > afterSeq 的历史事件（SSE Last-Event-ID 重连用） */
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

  /** 从 DB 恢复 seq 计数（进程重启后继续任务时用） */
  async primeSeq(taskId: string) {
    const last = await this.prisma.taskEventRow.findFirst({
      where: { taskId },
      orderBy: { seq: 'desc' },
    });
    if (last) this.seqCounters.set(taskId, last.seq);
  }
}
