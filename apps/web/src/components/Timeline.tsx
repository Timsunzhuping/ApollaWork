import type { TaskEvent, TodoItem } from '@apolla/protocol';
import type { TimelineItem } from '../hooks/useTaskStream';
import { renderMarkdown } from '../lib/md';
import {
  IconCheck,
  IconTerminal,
  IconEdit,
  IconFile,
  IconSearch,
  IconDoc,
  IconSpark,
} from '../icons';

const TOOL_ICON: Record<string, (p: { className?: string }) => React.ReactNode> = {
  Bash: IconTerminal,
  Write: IconEdit,
  Edit: IconEdit,
  Read: IconFile,
  Grep: IconSearch,
  Glob: IconSearch,
  Skill: IconSpark,
  Artifact: IconDoc,
};

const TOOL_LABEL: Record<string, string> = {
  Bash: '执行命令',
  Write: '写入文件',
  Edit: '编辑文件',
  Read: '读取文件',
  Grep: '搜索内容',
  Glob: '查找文件',
  TodoWrite: '更新计划',
  Skill: '加载技能',
  Artifact: '生成产物',
  WebFetch: '访问网页',
  WebSearch: '联网搜索',
  AskUserQuestion: '请你确认',
};

export function Timeline({ items }: { items: TimelineItem[] }) {
  return (
    <div className="flex flex-col gap-3">
      {items.map((item) => (
        <Item key={item.key} item={item} />
      ))}
    </div>
  );
}

function Item({ item }: { item: TimelineItem }) {
  const e = item.event as TaskEvent & {
    __result?: Extract<TaskEvent, { type: 'tool.result' }>;
    __bash?: string;
    __decision?: string;
  };

  switch (e.type) {
    case 'plan.updated':
      return <PlanCard items={e.items} />;
    case 'message.completed':
      return <MessageCard text={e.text} />;
    case 'tool.call':
      return <ToolCard event={e} />;
    case 'file.diff':
      return <DiffCard path={e.path} patch={e.patch} />;
    case 'approval.requested':
      return <ApprovalCard title={e.title} detail={e.detail} decision={e.__decision} />;
    case 'question.asked':
      return <div className="pl-9 text-[13px] text-warn">● 等待你的回答：{e.question}</div>;
    case 'artifact.created':
      return null; // 产物在右栏展示
    case 'user.input':
      return (
        <div className="flex justify-end">
          <div className="bg-primary-soft text-ink rounded-2xl rounded-br-md px-4 py-2.5 text-[14px] max-w-[80%]">
            {e.text}
          </div>
        </div>
      );
    case 'task.failed':
      return (
        <div className="pl-9 text-[13px] text-danger bg-danger-soft rounded-lg px-3 py-2">
          任务失败：{e.error.message}
        </div>
      );
    default:
      return null;
  }
}

function PlanCard({ items }: { items: TodoItem[] }) {
  return (
    <div className="fade-up bg-surface border border-line rounded-xl p-3.5">
      <div className="flex items-center gap-1.5 text-[12px] font-medium text-ink-soft mb-2">
        <IconCheck className="w-3.5 h-3.5" /> 执行计划
      </div>
      <div className="flex flex-col gap-1.5">
        {items.map((t) => (
          <div key={t.id} className="flex items-center gap-2 text-[13.5px]">
            <span
              className={`w-4 h-4 rounded-full border flex items-center justify-center shrink-0 ${
                t.state === 'done'
                  ? 'bg-primary border-primary text-white'
                  : t.state === 'in_progress'
                    ? 'border-primary'
                    : 'border-line'
              }`}
            >
              {t.state === 'done' && <IconCheck className="w-2.5 h-2.5" />}
              {t.state === 'in_progress' && <span className="w-1.5 h-1.5 rounded-full bg-primary pulse-dot" />}
            </span>
            <span
              className={
                t.state === 'done'
                  ? 'text-ink-faint line-through'
                  : t.state === 'in_progress'
                    ? 'text-ink font-medium'
                    : 'text-ink-soft'
              }
            >
              {t.text}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function MessageCard({ text }: { text: string }) {
  if (!text.trim()) return null;
  return (
    <div className="fade-up flex gap-3">
      <div className="w-6 h-6 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0 mt-0.5">
        <IconSpark className="w-3.5 h-3.5" />
      </div>
      <div
        className="prose-cn text-[14px] flex-1 min-w-0"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
      />
    </div>
  );
}

function ToolCard({
  event,
}: {
  event: Extract<TaskEvent, { type: 'tool.call' }> & {
    __result?: Extract<TaskEvent, { type: 'tool.result' }>;
    __bash?: string;
  };
}) {
  const Icon = TOOL_ICON[event.name] ?? IconTerminal;
  const label = TOOL_LABEL[event.name] ?? event.name;
  const result = event.__result;
  const running = !result;
  return (
    <div className="fade-up pl-9 relative">
      <div className="absolute left-2.5 top-1 w-6 h-6 rounded-lg bg-surface border border-line flex items-center justify-center text-ink-soft">
        {running ? <span className="w-3 h-3 rounded-full border-2 border-primary border-t-transparent spin" /> : <Icon className="w-3.5 h-3.5" />}
      </div>
      <div className="bg-surface border border-line rounded-xl overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2 text-[13px]">
          <span className="font-medium">{label}</span>
          <span className="text-ink-faint font-mono text-[12px] truncate">{event.argsPreview}</span>
          {result && (
            <span
              className={`ml-auto text-[11px] shrink-0 ${result.ok ? 'text-primary' : 'text-danger'}`}
            >
              {result.ok ? '✓ 完成' : '✗ 失败'}
              {result.durationMs ? ` · ${(result.durationMs / 1000).toFixed(1)}s` : ''}
            </span>
          )}
        </div>
        {event.__bash && (
          <pre className="bg-[#1a2420] text-[#c9d4ce] text-[12px] font-mono px-3 py-2.5 overflow-x-auto max-h-64 leading-relaxed m-0">
            {event.__bash.slice(-4000)}
          </pre>
        )}
        {result && !result.ok && result.resultPreview && !event.__bash && (
          <div className="px-3 py-2 text-[12px] text-danger bg-danger-soft/50 border-t border-line font-mono">
            {result.resultPreview}
          </div>
        )}
      </div>
    </div>
  );
}

function DiffCard({ path, patch }: { path: string; patch: string }) {
  const lines = patch.split('\n').filter((l) => !l.startsWith('---') && !l.startsWith('+++') && !l.startsWith('Index') && !l.startsWith('==='));
  return (
    <div className="fade-up pl-9">
      <div className="bg-surface border border-line rounded-xl overflow-hidden">
        <div className="px-3 py-2 text-[12px] font-mono text-ink-soft border-b border-line flex items-center gap-1.5">
          <IconEdit className="w-3.5 h-3.5" /> {path}
        </div>
        <pre className="text-[12px] font-mono overflow-x-auto max-h-72 m-0 py-1">
          {lines.slice(0, 200).map((l, i) => (
            <div
              key={i}
              className={`px-3 ${
                l.startsWith('+')
                  ? 'bg-primary-soft text-primary-hover'
                  : l.startsWith('-')
                    ? 'bg-danger-soft text-danger'
                    : l.startsWith('@@')
                      ? 'text-ink-faint bg-line-soft'
                      : 'text-ink-soft'
              }`}
            >
              {l || ' '}
            </div>
          ))}
        </pre>
      </div>
    </div>
  );
}

function ApprovalCard({
  title,
  detail,
  decision,
}: {
  title: string;
  detail: string;
  decision?: string;
}) {
  return (
    <div className={`fade-up pl-9`}>
      <div
        className={`rounded-xl border px-3.5 py-3 ${
          decision === 'approved'
            ? 'border-primary/30 bg-primary-soft/40'
            : decision === 'denied'
              ? 'border-line bg-line-soft'
              : 'border-warn/40 bg-warn-soft'
        }`}
      >
        <div className="text-[13px] font-medium flex items-center gap-1.5">
          {decision ? (decision === 'approved' ? '✓ 已批准' : '✗ 已拒绝') : '⚠ 需要审批'}：{title}
        </div>
        <div className="text-[12px] text-ink-soft font-mono mt-1 break-all">{detail}</div>
      </div>
    </div>
  );
}
