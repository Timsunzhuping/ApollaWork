import type { TaskEvent } from '@apolla/protocol';

/** 事件下沉抽象：CLI 打印到终端；沙箱模式经 WS 上报 server。 */
export interface EventSink {
  emit(event: TaskEvent): void;
}

/** 控制信号来源：审批结果、用户追加输入、取消。 */
export interface ControlSource {
  /** 等待某审批被解决 */
  waitApproval(approvalId: string): Promise<boolean>;
  /** 等待某问题被回答 */
  waitAnswer(questionId: string): Promise<string>;
  /** 取出并清空「用户追加输入」缓冲（下一轮 loop 注入） */
  drainUserInputs(): string[];
  isCancelled(): boolean;
}
