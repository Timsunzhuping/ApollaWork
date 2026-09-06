import type { ApprovalKind, PermissionMode, TaskEvent, TodoItem, ToolName } from '@apolla/protocol';
import type { ZodTypeAny } from 'zod';

/** 工具执行结果：output 返回给模型；truncatedRef 指向完整输出落盘位置 */
export interface ToolOutcome {
  ok: boolean;
  output: string;
  truncatedRef?: string;
}

/** 运行时注入给工具的执行上下文 */
export interface ToolContext {
  workspaceDir: string;
  mode: PermissionMode;
  /** 上报事件（由 runtime 负责补 taskId/seq 并转发） */
  emit(event: TaskEvent): void;
  /**
   * 请求审批。返回是否批准。
   * runtime 负责：auto 模式下按策略直批；ask 模式发起 approval.requested 并阻塞等待；
   * 「本任务内全部允许」的缓存也在 runtime 实现。
   */
  requestApproval(req: { kind: ApprovalKind; title: string; detail: string }): Promise<boolean>;
  /** 向用户提问（阻塞等待答案） */
  askUser(question: string, options: string[]): Promise<string>;
  /** 任务是否已被取消（工具应尽快让出） */
  isCancelled(): boolean;
  /** 计划清单（TodoWrite 维护，进系统提醒） */
  todos: TodoItem[];
  config: {
    webfetchAllowlist: string[];
    searxngUrl?: string;
    /** 出网用的 fetch。沙箱内为经 server 中继的实现（容器本身无网），缺省用全局 fetch */
    fetchImpl?: typeof fetch;
    /** 生效的危险命令规则（策略中心下发；缺省内置） */
    dangerRules?: import('./dangerous.js').DangerRule[];
  };
}

export interface ToolDef<T = unknown> {
  name: ToolName;
  description: string;
  schema: ZodTypeAny;
  execute(input: T, ctx: ToolContext, callId: string): Promise<ToolOutcome>;
}

export const ok = (output: string, truncatedRef?: string): ToolOutcome => ({
  ok: true,
  output,
  truncatedRef,
});
export const fail = (output: string): ToolOutcome => ({ ok: false, output });
