import type { TaskEventRecord } from '@apolla/protocol';

/**
 * SSE 投递闸门（T-411 e2e 暴露的实时丢事件修复）。
 *
 * 旧逻辑两处会丢事件：
 *  1) 先 replay 再 subscribe —— 两次 await 之间发布的事件谁都收不到；
 *  2) 实时事件用「seq > maxSeq」单调过滤 —— 只要有一条大 seq 先到，之后所有小 seq 事件全被丢弃
 *     （多副本下审批事件由另一副本发布时天然可能乱序）。
 * 现在：先订阅（未就绪时暂存），回放完成后按 seq 放行暂存队列；实时事件按「已见 seq 集合」去重，
 * 不再因乱序丢事件。客户端同样按 seq 去重，重连回放的重复事件不会重复渲染。
 */
export class SseGate {
  private readonly seen = new Set<number>();
  private ready = false;
  private pending: TaskEventRecord[] = [];
  private max: number;

  constructor(private readonly afterSeq: number) {
    this.max = afterSeq;
  }

  /** 回放阶段：记录已发送的 seq */
  replayed(seq: number) {
    this.seen.add(seq);
    if (seq > this.max) this.max = seq;
  }

  /** 实时回调：未就绪先暂存，就绪后立即判定投递 */
  live(rec: TaskEventRecord, deliver: (rec: TaskEventRecord) => void) {
    if (!this.ready) {
      this.pending.push(rec);
      return;
    }
    this.emit(rec, deliver);
  }

  /** 回放结束：放行暂存队列（按 seq 排序），之后实时事件直接投递 */
  markReady(deliver: (rec: TaskEventRecord) => void) {
    this.ready = true;
    const queued = this.pending.sort((a, b) => a.seq - b.seq);
    this.pending = [];
    for (const rec of queued) this.emit(rec, deliver);
  }

  private emit(rec: TaskEventRecord, deliver: (rec: TaskEventRecord) => void) {
    if (rec.seq <= this.afterSeq || this.seen.has(rec.seq)) return; // 客户端已有 / 重复
    this.seen.add(rec.seq);
    if (rec.seq > this.max) this.max = rec.seq;
    deliver(rec);
  }

  /** 已投递的最大 seq（诊断用） */
  get maxSeq() {
    return this.max;
  }
}
