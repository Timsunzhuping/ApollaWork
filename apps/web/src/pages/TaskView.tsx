import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useUI } from '../store';
import { useTaskStream } from '../hooks/useTaskStream';
import { Timeline } from '../components/Timeline';
import { Composer } from '../components/Composer';
import { ArtifactPanel } from '../components/ArtifactPanel';
import { useI18n, type I18nKey } from '../i18n';
import { IconSpark } from '../icons';

/** 任务状态 → 文案 key；未知状态直接显示原始值。 */
const STATUS_LABEL: Record<string, I18nKey | undefined> = {
  queued: 'status.queued',
  running: 'status.running',
  waiting_approval: 'status.waiting_approval',
  waiting_input: 'status.waiting_input',
  completed: 'status.completed',
  failed: 'status.failed',
  cancelled: 'status.cancelled',
};

export function TaskView() {
  const { id } = useParams<{ id: string }>();
  const { workspaceId, mode, modelTier } = useUI();
  const nav = useNavigate();
  const { t } = useI18n();
  const { data: task } = useQuery({
    queryKey: ['task', id],
    queryFn: () => api.task(id!),
    enabled: !!id,
  });
  const stream = useTaskStream(id ?? null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [answer, setAnswer] = useState('');

  const busy = !stream.done && ['queued', 'running', 'waiting_approval', 'waiting_input'].includes(stream.status);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [stream.items.length, stream.assistantText]);

  const approve = async (decision: 'approved' | 'denied', scope: 'once' | 'task' = 'once') => {
    if (stream.pendingApproval) await api.resolveApproval(stream.pendingApproval.approvalId, decision, scope);
  };
  const sendAnswer = async () => {
    if (stream.pendingQuestion && answer.trim()) {
      await api.answerQuestion(id!, stream.pendingQuestion.questionId, answer.trim());
      setAnswer('');
    }
  };

  return (
    <div className="h-full flex">
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="h-14 shrink-0 border-b border-line flex items-center px-6 gap-3 bg-surface/60 backdrop-blur">
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-medium truncate">
              {task?.prompt ?? t('task.fallbackTitle')}
            </div>
          </div>
          <StatusBadge
            status={stream.status}
            label={
              STATUS_LABEL[stream.status] ? t(STATUS_LABEL[stream.status]!) : stream.status
            }
          />
          {stream.usage && (
            <span className="text-[11px] text-ink-faint font-mono">
              {stream.usage.model} ·{' '}
              {t('task.tokens', { n: stream.usage.inTokens + stream.usage.outTokens })}
            </span>
          )}
        </header>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-5">
          <div className="max-w-[760px] mx-auto">
            <div className="flex justify-end mb-4">
              <div className="bg-primary-soft text-ink rounded-2xl rounded-br-md px-4 py-2.5 text-[14px] max-w-[80%]">
                {task?.prompt}
              </div>
            </div>

            {stream.items.length === 0 && busy && (
              <div className="flex items-center gap-2 text-ink-soft text-[13px] pl-9">
                <span className="w-3.5 h-3.5 rounded-full border-2 border-primary border-t-transparent spin" />
                {t('task.thinking')}
              </div>
            )}

            <Timeline items={stream.items} />
          </div>
        </div>

        <div className="shrink-0 px-6 pb-4 pt-1">
          <div className="max-w-[760px] mx-auto">
            {stream.pendingApproval && (
              <div className="mb-2 flex items-center gap-2 bg-warn-soft border border-warn/30 rounded-xl px-3.5 py-2.5">
                <span className="text-[13px] text-ink flex-1">
                  ⚠ {stream.pendingApproval.title}
                </span>
                <button
                  onClick={() => approve('denied')}
                  className="px-3 h-8 rounded-lg text-[13px] text-ink-soft hover:bg-white"
                >
                  {t('task.approval.deny')}
                </button>
                <button
                  onClick={() => approve('approved', 'task')}
                  className="px-3 h-8 rounded-lg text-[13px] text-ink-soft hover:bg-white"
                >
                  {t('task.approval.allowAll')}
                </button>
                <button
                  onClick={() => approve('approved')}
                  className="px-3.5 h-8 rounded-lg text-[13px] bg-primary text-white hover:bg-primary-hover"
                >
                  {t('task.approval.approve')}
                </button>
              </div>
            )}
            {stream.pendingQuestion && (
              <div className="mb-2 bg-surface border border-line rounded-xl px-3.5 py-3">
                <div className="text-[13px] mb-2">{stream.pendingQuestion.question}</div>
                <div className="flex flex-wrap gap-1.5">
                  {stream.pendingQuestion.options.map((o) => (
                    <button
                      key={o}
                      onClick={async () => {
                        await api.answerQuestion(id!, stream.pendingQuestion!.questionId, o);
                      }}
                      className="px-3 h-8 rounded-lg text-[13px] border border-line hover:border-primary/40"
                    >
                      {o}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <Composer
              onSubmit={async (text) => {
                // 任务已结束后再 sendInput，后端会 201 收下但无人消费 ——
                // 用户敲的字凭空消失，且占位符本就写着「继续对话或开始新任务」。
                // 故按状态分流：运行中投喂当前任务；已结束则在同一会话里开新任务并跳转。
                if (busy) return api.sendInput(id!, text);
                if (!task?.sessionId) return;
                const next = await api.createTask(task.sessionId, { prompt: text, mode, modelTier });
                nav(`/task/${next.id}`);
              }}
              busy={busy}
              onStop={() => api.cancelTask(id!)}
              compact
              placeholder={
                busy ? t('task.composer.busyPlaceholder') : t('task.composer.idlePlaceholder')
              }
            />
          </div>
        </div>
      </div>

      {(stream.artifacts.length > 0 || (task?.artifacts?.length ?? 0) > 0) && workspaceId && (
        <ArtifactPanel
          workspaceId={workspaceId}
          artifacts={
            stream.artifacts.length
              ? stream.artifacts.map((a) => ({ path: a.path, title: a.title, kind: a.kind, mime: a.mime }))
              : (task?.artifacts ?? [])
          }
        />
      )}
    </div>
  );
}

function StatusBadge({ status, label }: { status: string; label: string }) {
  const cls =
    status === 'completed'
      ? 'bg-primary-soft text-primary-hover'
      : status === 'failed' || status === 'cancelled'
        ? 'bg-danger-soft text-danger'
        : 'bg-warn-soft text-warn';
  const live = ['running', 'queued', 'waiting_approval'].includes(status);
  return (
    <span data-testid="task-status" data-status={status} className={`flex items-center gap-1.5 px-2.5 h-6 rounded-full text-[12px] font-medium ${cls}`}>
      {live && <span className="w-1.5 h-1.5 rounded-full bg-current pulse-dot" />}
      {label}
    </span>
  );
}
