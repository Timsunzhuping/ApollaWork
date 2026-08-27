import type { ControlSource } from '@apolla/runtime';
import type { ApprovalDecision, ApprovalScope } from '@apolla/protocol';

/**
 * 每个运行中任务的控制器：把 HTTP 端点的审批/回答/追加输入/取消
 * 桥接到 runtime 的 ControlSource（Promise 阻塞语义）。
 */
export class TaskControl implements ControlSource {
  private cancelled = false;
  private inputs: string[] = [];
  private pendingApprovals = new Map<string, (ok: boolean) => void>();
  private pendingAnswers = new Map<string, (ans: string) => void>();
  /** 本任务内「全部允许」的审批种类由 loop 侧维护；这里仅传递单次结果 */

  waitApproval(approvalId: string): Promise<boolean> {
    if (this.cancelled) return Promise.resolve(false);
    return new Promise((resolve) => this.pendingApprovals.set(approvalId, resolve));
  }

  resolveApproval(approvalId: string, decision: ApprovalDecision, _scope: ApprovalScope): boolean {
    const fn = this.pendingApprovals.get(approvalId);
    if (!fn) return false;
    this.pendingApprovals.delete(approvalId);
    fn(decision === 'approved');
    return true;
  }

  waitAnswer(questionId: string): Promise<string> {
    return new Promise((resolve) => this.pendingAnswers.set(questionId, resolve));
  }

  resolveAnswer(questionId: string, answer: string): boolean {
    const fn = this.pendingAnswers.get(questionId);
    if (!fn) return false;
    this.pendingAnswers.delete(questionId);
    fn(answer);
    return true;
  }

  addInput(text: string) {
    this.inputs.push(text);
  }

  drainUserInputs(): string[] {
    const r = this.inputs;
    this.inputs = [];
    return r;
  }

  cancel() {
    this.cancelled = true;
    // 唤醒所有阻塞中的审批/回答，避免任务卡死
    for (const [, fn] of this.pendingApprovals) fn(false);
    this.pendingApprovals.clear();
    for (const [, fn] of this.pendingAnswers) fn('（任务已取消）');
    this.pendingAnswers.clear();
  }

  isCancelled() {
    return this.cancelled;
  }

  hasPendingApproval(approvalId: string) {
    return this.pendingApprovals.has(approvalId);
  }
}
