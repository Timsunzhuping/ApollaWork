import { z } from 'zod';
import { ApprovalDecision, ApprovalScope, ModelTier, PermissionMode } from './core.js';

/** REST DTO（PRD §4.7） */

export const CreateTaskDto = z.object({
  prompt: z.string().min(1).max(20_000),
  mode: PermissionMode.default('auto'),
  modelTier: ModelTier.default('auto'),
  attachments: z.array(z.string()).default([]).describe('工作区文件相对路径'),
  skills: z.array(z.string()).default([]).describe('显式指定的技能'),
});
export type CreateTaskDto = z.infer<typeof CreateTaskDto>;

export const TaskInputDto = z.object({ text: z.string().min(1).max(10_000) });
export type TaskInputDto = z.infer<typeof TaskInputDto>;

export const ResolveApprovalDto = z.object({
  decision: ApprovalDecision,
  scope: ApprovalScope.default('once'),
});
export type ResolveApprovalDto = z.infer<typeof ResolveApprovalDto>;

export const AnswerQuestionDto = z.object({ answer: z.string() });
export type AnswerQuestionDto = z.infer<typeof AnswerQuestionDto>;

export const CreateWorkspaceDto = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(500).optional(),
  defaultMode: PermissionMode.default('auto'),
});
export type CreateWorkspaceDto = z.infer<typeof CreateWorkspaceDto>;

export const CreateSessionDto = z.object({
  title: z.string().max(128).optional(),
});
export type CreateSessionDto = z.infer<typeof CreateSessionDto>;

export const UpsertModelProviderDto = z.object({
  name: z.string().min(1),
  baseUrl: z.string().url(),
  apiKey: z.string().optional(),
  model: z.string().min(1),
  tier: ModelTier,
  enabled: z.boolean().default(true),
});
export type UpsertModelProviderDto = z.infer<typeof UpsertModelProviderDto>;
