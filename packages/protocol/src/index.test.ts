import { describe, expect, it } from 'vitest';
import { CreateTaskDto, RuntimeEnvelope, TaskEvent, TaskStatus, ToolInputSchemas, ToolNames } from './index.js';

describe('protocol schemas', () => {
  it('TaskEvent 判别联合能解析各类事件', () => {
    const samples: unknown[] = [
      { v: 1, type: 'task.status', status: 'running' },
      { v: 1, type: 'plan.updated', items: [{ id: '1', text: 'a', state: 'pending' }] },
      { v: 1, type: 'tool.call', callId: 'c1', name: 'Bash', argsPreview: 'ls' },
      { v: 1, type: 'artifact.created', path: 'r.md', title: '报告', kind: 'document' },
      { v: 1, type: 'usage.updated', usage: { inTokens: 1, outTokens: 2, model: 'mock' } },
    ];
    for (const s of samples) expect(TaskEvent.safeParse(s).success).toBe(true);
  });

  it('拒绝未知事件类型', () => {
    expect(TaskEvent.safeParse({ v: 1, type: 'nope' }).success).toBe(false);
  });

  it('TaskStatus 覆盖状态机全集', () => {
    for (const s of ['queued', 'running', 'waiting_approval', 'waiting_input', 'completed', 'failed', 'cancelled']) {
      expect(TaskStatus.safeParse(s).success).toBe(true);
    }
  });

  it('CreateTaskDto 应用默认值', () => {
    const parsed = CreateTaskDto.parse({ prompt: '做个表' });
    expect(parsed.mode).toBe('auto');
    expect(parsed.modelTier).toBe('auto');
    expect(parsed.attachments).toEqual([]);
  });

  it('CreateTaskDto 拒绝空 prompt', () => {
    expect(CreateTaskDto.safeParse({ prompt: '' }).success).toBe(false);
  });

  it('RuntimeEnvelope 校验 hello 握手', () => {
    expect(RuntimeEnvelope.safeParse({ kind: 'hello', taskId: 't1', token: 'x' }).success).toBe(true);
    expect(RuntimeEnvelope.safeParse({ kind: 'hello', taskId: 't1' }).success).toBe(false);
  });

  it('工具 schema 表覆盖全部 14 个工具', () => {
    expect(ToolNames.length).toBe(14);
    expect(ToolInputSchemas.Bash.safeParse({ command: 'ls' }).success).toBe(true);
    expect(ToolInputSchemas.Read.safeParse({}).success).toBe(false);
    expect(ToolInputSchemas.AskUserQuestion.safeParse({ question: 'q', options: ['a'] }).success).toBe(false);
    expect(ToolInputSchemas.AskUserQuestion.safeParse({ question: 'q', options: ['a', 'b'] }).success).toBe(true);
  });
});
