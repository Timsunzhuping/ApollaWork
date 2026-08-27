import { z } from 'zod';

/** 任务状态机（PRD §4.6 tasks.status） */
export const TaskStatus = z.enum([
  'queued',
  'running',
  'waiting_approval',
  'waiting_input',
  'completed',
  'failed',
  'cancelled',
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

/** 权限模式（PRD F4） */
export const PermissionMode = z.enum(['ask', 'plan', 'auto']);
export type PermissionMode = z.infer<typeof PermissionMode>;

/** 审批种类 */
export const ApprovalKind = z.enum([
  'bash_command',
  'file_overwrite',
  'file_delete',
  'connector_write',
  'network_egress',
  'plan_confirm',
]);
export type ApprovalKind = z.infer<typeof ApprovalKind>;

export const ApprovalDecision = z.enum(['approved', 'denied']);
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

/** 审批范围：仅本次 / 本任务内同类全部允许 */
export const ApprovalScope = z.enum(['once', 'task']);
export type ApprovalScope = z.infer<typeof ApprovalScope>;

export const TodoState = z.enum(['pending', 'in_progress', 'done', 'skipped']);
export type TodoState = z.infer<typeof TodoState>;

export const TodoItem = z.object({
  id: z.string(),
  text: z.string(),
  state: TodoState,
});
export type TodoItem = z.infer<typeof TodoItem>;

/** 模型路由档位（UI 的「Auto / 快速 / 深度」） */
export const ModelTier = z.enum(['auto', 'fast', 'deep']);
export type ModelTier = z.infer<typeof ModelTier>;

export const Usage = z.object({
  inTokens: z.number().int().nonnegative(),
  outTokens: z.number().int().nonnegative(),
  model: z.string(),
});
export type Usage = z.infer<typeof Usage>;
