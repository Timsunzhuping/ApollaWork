import { describe, expect, it } from 'vitest';
import type { TaskEvent } from '@apolla/protocol';
import { reduce } from './useTaskStream';

/**
 * 事件流归约（T-411）：时间线怎么从事件长出来。
 * 覆盖 2026-08 手测暴露的场景：半截文本重试后不重复、产物进右栏、审批解决后状态更新。
 */
const initial = () =>
  ({
    items: [],
    plan: [],
    status: 'queued',
    assistantText: '',
    usage: null,
    pendingApproval: null,
    pendingQuestion: null,
    artifacts: [],
    done: false,
  }) as unknown as Parameters<typeof reduce>[0];

const run = (events: TaskEvent[]) => {
  let s = initial();
  const buffers = new Map<string, string>();
  events.forEach((e, i) => {
    s = reduce(s, e, i + 1, buffers);
  });
  return s;
};

describe('reduce', () => {
  it('message.delta 累积文本，message.completed 收尾并清空累积', () => {
    const s = run([
      { v: 1, type: 'message.delta', messageId: 'm1', delta: '你' } as TaskEvent,
      { v: 1, type: 'message.delta', messageId: 'm1', delta: '好' } as TaskEvent,
    ]);
    expect(s.assistantText).toBe('你好');
    const done = reduce(s, { v: 1, type: 'message.completed', messageId: 'm1', role: 'assistant', text: '你好' } as TaskEvent, 3, new Map());
    expect(done.assistantText).toBe('');
    expect(done.items.some((i) => i.key === 'msg-m1')).toBe(true);
  });

  it('★ model.retry 且已流出半截：丢弃该消息，留一条重试提示（否则重试后文本重复）', () => {
    const s = run([
      { v: 1, type: 'message.delta', messageId: 'm1', delta: '半截' } as TaskEvent,
      {
        v: 1, type: 'model.retry', messageId: 'm1', attempt: 1, maxAttempts: 3, reason: 'HTTP 503',
        fallback: false, model: 'qwen', streamedPartial: true,
      } as TaskEvent,
      { v: 1, type: 'message.delta', messageId: 'm1', delta: '完整' } as TaskEvent,
    ]);
    expect(s.assistantText).toBe('完整');
    expect(s.items.some((i) => i.key.startsWith('retry-'))).toBe(true);
    expect(s.items.filter((i) => i.key === 'msg-m1')).toHaveLength(1);
  });

  it('artifact.created 进 artifacts；task.completed 置终态', () => {
    const s = run([
      { v: 1, type: 'artifact.created', path: 'a.csv', title: '表', mime: 'text/csv', kind: 'spreadsheet' } as TaskEvent,
      { v: 1, type: 'task.completed', summary: '完成' } as TaskEvent,
    ]);
    expect(s.artifacts).toHaveLength(1);
    expect(s.status).toBe('completed');
    expect(s.done).toBe(true);
  });

  it('approval.requested 置 pending，resolved 后清空并在时间线标记决定', () => {
    const s = run([
      { v: 1, type: 'approval.requested', approvalId: 'a1', kind: 'bash_command', title: 'rm', detail: 'rm x' } as TaskEvent,
    ]);
    expect(s.pendingApproval?.approvalId).toBe('a1');
    const r = reduce(s, { v: 1, type: 'approval.resolved', approvalId: 'a1', decision: 'approved', scope: 'once' } as TaskEvent, 2, new Map());
    expect(r.pendingApproval).toBeNull();
    const item = r.items.find((i) => i.key === 'appr-a1') as { event: { __decision?: string } } | undefined;
    expect(item?.event.__decision).toBe('approved');
  });

  it('tool.call 与其 tool.result 合并为同一条', () => {
    const s = run([
      { v: 1, type: 'tool.call', callId: 'c1', name: 'Bash', argsPreview: 'ls' } as TaskEvent,
      { v: 1, type: 'tool.result', callId: 'c1', name: 'Bash', ok: true, resultPreview: 'a b' } as TaskEvent,
    ]);
    expect(s.items.filter((i) => i.key === 'call-c1')).toHaveLength(1);
  });
});
