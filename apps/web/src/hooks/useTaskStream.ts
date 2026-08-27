import { useEffect, useRef, useState } from 'react';
import type { TaskEvent, TodoItem } from '@apolla/protocol';
import { streamTask } from '../api';

export interface TimelineItem {
  key: string;
  event: TaskEvent;
}

export interface StreamState {
  items: TimelineItem[];
  plan: TodoItem[];
  status: string;
  assistantText: string;
  usage: { inTokens: number; outTokens: number; model: string } | null;
  pendingApproval: Extract<TaskEvent, { type: 'approval.requested' }> | null;
  pendingQuestion: Extract<TaskEvent, { type: 'question.asked' }> | null;
  artifacts: Extract<TaskEvent, { type: 'artifact.created' }>[];
  done: boolean;
}

/** 消费任务 SSE，把事件流折叠为可渲染的时间线状态。 */
export function useTaskStream(taskId: string | null): StreamState {
  const [state, setState] = useState<StreamState>(initial());
  const bashBuffers = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    if (!taskId) return;
    setState(initial());
    bashBuffers.current = new Map();

    const cancel = streamTask(
      taskId,
      (event, seq) => {
        setState((prev) => reduce(prev, event, seq, bashBuffers.current));
      },
      () => setState((prev) => ({ ...prev, done: true })),
    );
    return cancel;
  }, [taskId]);

  return state;
}

function initial(): StreamState {
  return {
    items: [],
    plan: [],
    status: 'queued',
    assistantText: '',
    usage: null,
    pendingApproval: null,
    pendingQuestion: null,
    artifacts: [],
    done: false,
  };
}

function reduce(
  prev: StreamState,
  event: TaskEvent,
  seq: number,
  bashBuffers: Map<string, string>,
): StreamState {
  const next = { ...prev };
  switch (event.type) {
    case 'task.status':
      next.status = event.status;
      break;
    case 'plan.updated':
      next.plan = event.items;
      next.items = upsert(prev.items, 'plan', event);
      break;
    case 'message.delta':
      next.assistantText = prev.assistantText + event.delta;
      next.items = upsertMessage(prev.items, event.messageId, next.assistantText);
      break;
    case 'message.completed':
      next.assistantText = '';
      next.items = finalizeMessage(prev.items, event.messageId, event.text);
      break;
    case 'tool.call':
      next.items = [...prev.items, { key: `call-${event.callId}`, event }];
      break;
    case 'tool.result':
      next.items = attachResult(prev.items, event);
      break;
    case 'bash.output': {
      const acc = (bashBuffers.get(event.callId) ?? '') + event.chunk;
      bashBuffers.set(event.callId, acc);
      next.items = attachBash(prev.items, event.callId, acc);
      break;
    }
    case 'file.diff':
      next.items = [...prev.items, { key: `diff-${seq}`, event }];
      break;
    case 'approval.requested':
      next.pendingApproval = event;
      next.items = [...prev.items, { key: `appr-${event.approvalId}`, event }];
      break;
    case 'approval.resolved':
      next.pendingApproval = null;
      next.items = markApprovalResolved(prev.items, event.approvalId, event.decision);
      break;
    case 'question.asked':
      next.pendingQuestion = event;
      next.items = [...prev.items, { key: `q-${event.questionId}`, event }];
      break;
    case 'question.answered':
      next.pendingQuestion = null;
      break;
    case 'artifact.created':
      next.artifacts = [...prev.artifacts, event];
      next.items = [...prev.items, { key: `art-${seq}`, event }];
      break;
    case 'user.input':
      next.items = [...prev.items, { key: `input-${seq}`, event }];
      break;
    case 'usage.updated':
      next.usage = event.usage;
      break;
    case 'task.completed':
      next.status = 'completed';
      next.done = true;
      if (event.summary) next.items = ensureSummary(prev.items, event.summary, seq);
      break;
    case 'task.failed':
      next.status = 'failed';
      next.done = true;
      next.items = [...prev.items, { key: `fail-${seq}`, event }];
      break;
    case 'task.cancelled':
      next.status = 'cancelled';
      next.done = true;
      break;
    default:
      break;
  }
  return next;
}

function upsert(items: TimelineItem[], key: string, event: TaskEvent): TimelineItem[] {
  const idx = items.findIndex((i) => i.key === key);
  if (idx >= 0) {
    const copy = [...items];
    copy[idx] = { key, event };
    return copy;
  }
  return [...items, { key, event }];
}

function upsertMessage(items: TimelineItem[], messageId: string, text: string): TimelineItem[] {
  const key = `msg-${messageId}`;
  const event = { v: 1, type: 'message.completed', messageId, role: 'assistant', text } as TaskEvent;
  return upsert(items, key, event);
}

function finalizeMessage(items: TimelineItem[], messageId: string, text: string): TimelineItem[] {
  if (!text.trim()) return items.filter((i) => i.key !== `msg-${messageId}`);
  return upsertMessage(items, messageId, text);
}

function attachResult(
  items: TimelineItem[],
  ev: Extract<TaskEvent, { type: 'tool.result' }>,
): TimelineItem[] {
  const key = `call-${ev.callId}`;
  return items.map((i) =>
    i.key === key && i.event.type === 'tool.call'
      ? { ...i, event: { ...i.event, __result: ev } as unknown as TaskEvent }
      : i,
  );
}

function attachBash(items: TimelineItem[], callId: string, output: string): TimelineItem[] {
  const key = `call-${callId}`;
  return items.map((i) =>
    i.key === key ? { ...i, event: { ...i.event, __bash: output } as unknown as TaskEvent } : i,
  );
}

function markApprovalResolved(
  items: TimelineItem[],
  approvalId: string,
  decision: string,
): TimelineItem[] {
  const key = `appr-${approvalId}`;
  return items.map((i) =>
    i.key === key ? { ...i, event: { ...i.event, __decision: decision } as unknown as TaskEvent } : i,
  );
}

function ensureSummary(items: TimelineItem[], summary: string, seq: number): TimelineItem[] {
  const hasMsg = items.some((i) => i.event.type === 'message.completed');
  if (hasMsg) return items;
  return [
    ...items,
    {
      key: `summary-${seq}`,
      event: { v: 1, type: 'message.completed', messageId: 'summary', role: 'assistant', text: summary } as TaskEvent,
    },
  ];
}
