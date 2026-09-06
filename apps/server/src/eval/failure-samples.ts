import type { TaskEvent } from '@apolla/protocol';

/**
 * 失败样本采集（T-420，评测-微调闭环的第一环）。
 * 把「失败的」或「用户打低分的」任务整理成一条可训练/可标注的样本：
 * 用户意图、模型路由、最终状态、用户评价，以及**压缩后的轨迹**（工具调用与结果摘要、审批决定、错误）。
 * 不含工作区文件内容与密钥；resultPreview 已是 runtime 截断后的摘要。
 */

export interface TaskLike {
  id: string;
  prompt: string;
  mode: string;
  modelRoute: string | null;
  status: string;
  summary: string | null;
  rating: number | null;
  ratingNote: string | null;
  createdAt: Date | string;
  usageJson: string | null;
}

export interface TraceStep {
  seq: number;
  type: string;
  name?: string;
  args?: string;
  ok?: boolean;
  result?: string;
  text?: string;
  decision?: string;
  error?: string;
}

export interface FailureSample {
  taskId: string;
  createdAt: string;
  prompt: string;
  mode: string;
  model: string | null;
  status: string;
  summary: string | null;
  rating: number | null;
  note: string | null;
  usage: { inTokens: number; outTokens: number } | null;
  /** 为什么进了样本集：failed / low_rating / both */
  reason: 'failed' | 'low_rating' | 'both';
  steps: TraceStep[];
}

export const LOW_RATING_MAX = 2;

/** 是否应进入样本集 */
export function isFailureSample(t: Pick<TaskLike, 'status' | 'rating'>): FailureSample['reason'] | null {
  const failed = t.status === 'failed';
  const low = t.rating !== null && t.rating <= LOW_RATING_MAX;
  if (failed && low) return 'both';
  if (failed) return 'failed';
  if (low) return 'low_rating';
  return null;
}

const clip = (s: string | undefined, n = 400) => (s && s.length > n ? s.slice(0, n) + '…' : s);

/** 事件流 → 压缩轨迹：只留模型能从中学到东西的步骤 */
export function compactTrace(events: { seq: number; event: TaskEvent }[]): TraceStep[] {
  const steps: TraceStep[] = [];
  for (const { seq, event: e } of events) {
    switch (e.type) {
      case 'tool.call':
        steps.push({ seq, type: 'tool.call', name: e.name, args: clip(e.argsPreview) });
        break;
      case 'tool.result':
        steps.push({ seq, type: 'tool.result', name: e.name, ok: e.ok, result: clip(e.resultPreview) });
        break;
      case 'message.completed':
        if (e.role === 'assistant' && e.text.trim()) steps.push({ seq, type: 'assistant', text: clip(e.text, 800) });
        break;
      case 'approval.resolved':
        steps.push({ seq, type: 'approval', decision: e.decision });
        break;
      case 'question.asked':
        steps.push({ seq, type: 'question', text: clip(e.question) });
        break;
      case 'user.input':
        steps.push({ seq, type: 'user.input', text: clip(e.text) });
        break;
      case 'model.retry':
        steps.push({ seq, type: 'model.retry', error: clip(e.reason), name: e.model });
        break;
      case 'task.failed':
        steps.push({ seq, type: 'task.failed', error: clip(e.error.message) });
        break;
      default:
        break;
    }
  }
  return steps;
}

export function toSample(t: TaskLike, events: { seq: number; event: TaskEvent }[]): FailureSample | null {
  const reason = isFailureSample(t);
  if (!reason) return null;
  let usage: FailureSample['usage'] = null;
  try {
    const u = t.usageJson ? (JSON.parse(t.usageJson) as { inTokens?: number; outTokens?: number }) : null;
    if (u) usage = { inTokens: u.inTokens ?? 0, outTokens: u.outTokens ?? 0 };
  } catch {
    /* 坏 JSON 当无用量 */
  }
  return {
    taskId: t.id,
    createdAt: t.createdAt instanceof Date ? t.createdAt.toISOString() : new Date(t.createdAt).toISOString(),
    prompt: t.prompt,
    mode: t.mode,
    model: t.modelRoute,
    status: t.status,
    summary: t.summary,
    rating: t.rating,
    note: t.ratingNote,
    usage,
    reason,
    steps: compactTrace(events),
  };
}

/** 导出为 JSONL（每行一条样本） */
export function toJsonl(samples: FailureSample[]): string {
  return samples.map((s) => JSON.stringify(s)).join('\n') + (samples.length ? '\n' : '');
}
