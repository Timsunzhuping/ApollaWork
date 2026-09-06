import { describe, expect, it } from 'vitest';
import type { TaskEvent } from '@apolla/protocol';
import { compactTrace, isFailureSample, toJsonl, toSample, type TaskLike } from './failure-samples.js';

/** 失败样本采集（T-420）：入集判定、轨迹压缩、导出格式 */
const base: TaskLike = {
  id: 't1',
  prompt: '做一份预算表',
  mode: 'auto',
  modelRoute: 'qwen3-32b',
  status: 'completed',
  summary: '完成',
  rating: null,
  ratingNote: null,
  createdAt: new Date('2026-09-01T00:00:00Z'),
  usageJson: '{"inTokens":1200,"outTokens":300,"model":"qwen3-32b"}',
};
const ev = (seq: number, e: object) => ({ seq, event: e as TaskEvent });

describe('isFailureSample', () => {
  it('失败 / 低分（≤2）/ 两者 进集；正常完成且高分不进', () => {
    expect(isFailureSample({ status: 'failed', rating: null })).toBe('failed');
    expect(isFailureSample({ status: 'completed', rating: 2 })).toBe('low_rating');
    expect(isFailureSample({ status: 'failed', rating: 1 })).toBe('both');
    expect(isFailureSample({ status: 'completed', rating: 5 })).toBeNull();
    expect(isFailureSample({ status: 'completed', rating: null })).toBeNull();
  });
});

describe('compactTrace', () => {
  it('★ 只保留可学习的步骤，长文本截断，忽略心跳类事件', () => {
    const steps = compactTrace([
      ev(1, { v: 1, type: 'task.created', taskId: 't1', sessionId: 's', prompt: 'p', mode: 'auto' }),
      ev(2, { v: 1, type: 'usage.updated', usage: { inTokens: 1, outTokens: 1, model: 'm' } }),
      ev(3, { v: 1, type: 'tool.call', callId: 'c1', name: 'Bash', argsPreview: 'x'.repeat(500) }),
      ev(4, { v: 1, type: 'tool.result', callId: 'c1', name: 'Bash', ok: false, resultPreview: '退出码 1' }),
      ev(5, { v: 1, type: 'model.retry', messageId: 'm', attempt: 1, maxAttempts: 3, reason: 'HTTP 503', fallback: false, model: 'q', streamedPartial: false }),
      ev(6, { v: 1, type: 'message.completed', messageId: 'm', role: 'assistant', text: '我放弃了' }),
      ev(7, { v: 1, type: 'message.completed', messageId: 'sys', role: 'system', text: '系统提示' }),
      ev(8, { v: 1, type: 'task.failed', error: { code: 'x', message: '超时' } }),
    ]);
    expect(steps.map((s) => s.type)).toEqual(['tool.call', 'tool.result', 'model.retry', 'assistant', 'task.failed']);
    expect(steps[0]!.args!.length).toBeLessThanOrEqual(401);
    expect(steps[1]).toMatchObject({ ok: false, result: '退出码 1' });
    expect(steps[4]).toMatchObject({ error: '超时' });
  });
});

describe('toSample / toJsonl', () => {
  it('★ 低分任务成样本：带评价、用量与轨迹；不含工作区文件内容', () => {
    const s = toSample({ ...base, rating: 1, ratingNote: '表格数字全错' }, [
      ev(1, { v: 1, type: 'tool.call', callId: 'c1', name: 'Write', argsPreview: '{"path":"a.csv"}' }),
    ]);
    expect(s).toMatchObject({ taskId: 't1', reason: 'low_rating', rating: 1, note: '表格数字全错', model: 'qwen3-32b', usage: { inTokens: 1200, outTokens: 300 } });
    expect(s!.steps).toHaveLength(1);
    expect(JSON.stringify(s)).not.toContain('quarter,budget');
  });

  it('正常任务返回 null；坏 usageJson 不致命', () => {
    expect(toSample(base, [])).toBeNull();
    expect(toSample({ ...base, status: 'failed', usageJson: '{bad' }, [])?.usage).toBeNull();
  });

  it('JSONL 每行一条，末尾换行；空集为空串', () => {
    const s = toSample({ ...base, status: 'failed' }, [])!;
    const out = toJsonl([s, s]);
    expect(out.split('\n').filter(Boolean)).toHaveLength(2);
    expect(out.endsWith('\n')).toBe(true);
    expect(toJsonl([])).toBe('');
  });
});
