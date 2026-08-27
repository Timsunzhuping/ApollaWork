import { z } from 'zod';
import { ApprovalDecision, ApprovalKind, ApprovalScope, TaskStatus, TodoItem, Usage } from './core.js';

/**
 * 事件协议（PRD §4.8 / 附录 B）。
 * 事件是唯一真相：前端实时渲染、历史回放、审计、IM 推送全部由该流派生。
 * 所有 payload 带版本号 v，结构性变更必须升版本。
 */

const base = { v: z.literal(1).default(1) };

export const TaskCreatedEvent = z.object({
  ...base,
  type: z.literal('task.created'),
  taskId: z.string(),
  sessionId: z.string(),
  prompt: z.string(),
  mode: z.string(),
  modelRoute: z.string(),
});

export const TaskStatusEvent = z.object({
  ...base,
  type: z.literal('task.status'),
  status: TaskStatus,
});

export const PlanUpdatedEvent = z.object({
  ...base,
  type: z.literal('plan.updated'),
  items: z.array(TodoItem),
});

export const MessageDeltaEvent = z.object({
  ...base,
  type: z.literal('message.delta'),
  messageId: z.string(),
  delta: z.string(),
});

export const MessageCompletedEvent = z.object({
  ...base,
  type: z.literal('message.completed'),
  messageId: z.string(),
  role: z.enum(['assistant', 'user', 'system']),
  text: z.string(),
});

export const ToolCallEvent = z.object({
  ...base,
  type: z.literal('tool.call'),
  callId: z.string(),
  name: z.string(),
  argsPreview: z.string(),
});

export const ToolResultEvent = z.object({
  ...base,
  type: z.literal('tool.result'),
  callId: z.string(),
  name: z.string(),
  ok: z.boolean(),
  resultPreview: z.string(),
  truncatedRef: z.string().optional(),
  durationMs: z.number().optional(),
});

export const BashOutputEvent = z.object({
  ...base,
  type: z.literal('bash.output'),
  callId: z.string(),
  chunk: z.string(),
  stream: z.enum(['stdout', 'stderr']).default('stdout'),
});

export const FileDiffEvent = z.object({
  ...base,
  type: z.literal('file.diff'),
  path: z.string(),
  patch: z.string(),
});

export const ApprovalRequestedEvent = z.object({
  ...base,
  type: z.literal('approval.requested'),
  approvalId: z.string(),
  kind: ApprovalKind,
  title: z.string(),
  detail: z.string(),
});

export const ApprovalResolvedEvent = z.object({
  ...base,
  type: z.literal('approval.resolved'),
  approvalId: z.string(),
  decision: ApprovalDecision,
  scope: ApprovalScope,
  resolvedBy: z.string().optional(),
});

export const QuestionAskedEvent = z.object({
  ...base,
  type: z.literal('question.asked'),
  questionId: z.string(),
  question: z.string(),
  options: z.array(z.string()),
});

export const QuestionAnsweredEvent = z.object({
  ...base,
  type: z.literal('question.answered'),
  questionId: z.string(),
  answer: z.string(),
});

export const ArtifactCreatedEvent = z.object({
  ...base,
  type: z.literal('artifact.created'),
  path: z.string(),
  title: z.string(),
  mime: z.string().optional(),
  kind: z.enum(['document', 'spreadsheet', 'slides', 'chart', 'page', 'data', 'other']).default('other'),
});

export const UsageUpdatedEvent = z.object({
  ...base,
  type: z.literal('usage.updated'),
  usage: Usage,
});

export const UserInputEvent = z.object({
  ...base,
  type: z.literal('user.input'),
  text: z.string(),
});

export const TaskCompletedEvent = z.object({
  ...base,
  type: z.literal('task.completed'),
  summary: z.string(),
});

export const TaskFailedEvent = z.object({
  ...base,
  type: z.literal('task.failed'),
  error: z.object({ code: z.string(), message: z.string() }),
});

export const TaskCancelledEvent = z.object({
  ...base,
  type: z.literal('task.cancelled'),
});

export const TaskEvent = z.discriminatedUnion('type', [
  TaskCreatedEvent,
  TaskStatusEvent,
  PlanUpdatedEvent,
  MessageDeltaEvent,
  MessageCompletedEvent,
  ToolCallEvent,
  ToolResultEvent,
  BashOutputEvent,
  FileDiffEvent,
  ApprovalRequestedEvent,
  ApprovalResolvedEvent,
  QuestionAskedEvent,
  QuestionAnsweredEvent,
  ArtifactCreatedEvent,
  UsageUpdatedEvent,
  UserInputEvent,
  TaskCompletedEvent,
  TaskFailedEvent,
  TaskCancelledEvent,
]);
export type TaskEvent = z.infer<typeof TaskEvent>;
export type TaskEventType = TaskEvent['type'];

/** 带持久化元数据的事件行（task_events 表 / SSE data） */
export const TaskEventRecord = z.object({
  taskId: z.string(),
  seq: z.number().int(),
  ts: z.string(),
  event: TaskEvent,
});
export type TaskEventRecord = z.infer<typeof TaskEventRecord>;

/** runtime -> server 的 WS 消息封装 */
export const RuntimeEnvelope = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('hello'), taskId: z.string(), token: z.string() }),
  z.object({ kind: z.literal('event'), event: TaskEvent }),
  z.object({ kind: z.literal('bye') }),
]);
export type RuntimeEnvelope = z.infer<typeof RuntimeEnvelope>;

/** server -> runtime 的下行控制消息 */
export const ControlEnvelope = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('hello.ok') }),
  z.object({
    kind: z.literal('approval.resolved'),
    approvalId: z.string(),
    decision: ApprovalDecision,
    scope: ApprovalScope,
  }),
  z.object({ kind: z.literal('question.answered'), questionId: z.string(), answer: z.string() }),
  z.object({ kind: z.literal('user.input'), text: z.string() }),
  z.object({ kind: z.literal('cancel') }),
]);
export type ControlEnvelope = z.infer<typeof ControlEnvelope>;
