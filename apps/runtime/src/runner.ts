import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PermissionMode, ModelTier } from '@apolla/protocol';
import { AgentLoop } from './loop.js';
import type { EventSink, ControlSource } from './emitter.js';
import { createModel, type ModelConfig } from './model-factory.js';
import { loadSkills } from './skills.js';

export interface RunTaskParams {
  taskId?: string;
  sessionId?: string;
  prompt: string;
  workspaceDir: string;
  mode?: PermissionMode;
  modelTier?: ModelTier;
  attachments?: string[];
  modelConfig: ModelConfig;
  skillRoots?: string[];
  webfetchAllowlist?: string[];
  searxngUrl?: string;
  now?: string;
}

/** 组装并运行一次任务。被 CLI、评测、（沙箱内）server-bridge 共用。 */
export async function runTask(
  params: RunTaskParams,
  sink: EventSink,
  control: ControlSource,
): Promise<{ status: string; summary: string; usage: { inTokens: number; outTokens: number; model: string } }> {
  const taskId = params.taskId ?? randomUUID();
  const mode = params.mode ?? 'auto';
  const model = createModel(params.modelConfig);
  const skillRoots = params.skillRoots ?? [path.resolve(process.cwd(), 'skills')];
  const skills = loadSkills(...skillRoots);
  const allowlist = params.webfetchAllowlist ?? [];

  sink.emit({
    v: 1,
    type: 'task.created',
    taskId,
    sessionId: params.sessionId ?? taskId,
    prompt: params.prompt,
    mode,
    modelRoute: model.name,
  });
  sink.emit({ v: 1, type: 'task.status', status: 'running' });

  const loop = new AgentLoop(
    {
      workspaceDir: params.workspaceDir,
      mode,
      model,
      skills,
      prompt: params.prompt,
      attachments: params.attachments,
      webEnabled: allowlist.length > 0 || !!params.searxngUrl,
      webfetchAllowlist: allowlist,
      searxngUrl: params.searxngUrl,
      now: params.now ?? new Date().toISOString(),
    },
    sink,
    control,
  );

  const result = await loop.run();

  if (result.status === 'completed') {
    sink.emit({ v: 1, type: 'task.status', status: 'completed' });
    sink.emit({ v: 1, type: 'task.completed', summary: result.summary });
  } else if (result.status === 'failed') {
    sink.emit({ v: 1, type: 'task.status', status: 'failed' });
  } else {
    sink.emit({ v: 1, type: 'task.status', status: 'cancelled' });
  }
  return { ...result, usage: loop.usage };
}
