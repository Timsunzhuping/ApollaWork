import { useQuery } from '@tanstack/react-query';
import { api } from '../api';

export function Admin() {
  const { data: usage } = useQuery({ queryKey: ['usage'], queryFn: () => api.adminUsage(7) });
  const { data: audit } = useQuery({ queryKey: ['audit'], queryFn: api.adminAudit });

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[960px] mx-auto px-8 py-10">
        <h1 className="text-[24px] font-bold mb-1">管理后台</h1>
        <p className="text-ink-soft text-[14px] mb-7">模型治理、用量看板与审计（近 7 天）。</p>

        <div className="grid grid-cols-4 gap-3 mb-6">
          <Stat label="任务总数" value={usage?.taskCount ?? 0} />
          <Stat label="输入 token" value={fmt(usage?.totalIn)} />
          <Stat label="输出 token" value={fmt(usage?.totalOut)} />
          <Stat label="模型数" value={Object.keys(usage?.byModel ?? {}).length} />
        </div>

        <Section title="按状态分布">
          <div className="flex flex-wrap gap-2">
            {(usage?.byStatus ?? []).map((s: any) => (
              <span key={s.status} className="px-3 py-1.5 rounded-lg bg-surface border border-line text-[13px]">
                {s.status}：<b>{s._count}</b>
              </span>
            ))}
          </div>
        </Section>

        <Section title="按模型用量">
          <div className="bg-surface border border-line rounded-xl overflow-hidden">
            {Object.entries(usage?.byModel ?? {}).map(([model, v]: [string, any]) => (
              <div key={model} className="flex items-center gap-3 px-4 py-2.5 border-b border-line-soft last:border-0 text-[13px]">
                <span className="font-mono flex-1">{model}</span>
                <span className="text-ink-soft">{v.count} 次调用</span>
                <span className="text-ink-faint font-mono">in {fmt(v.in)} / out {fmt(v.out)}</span>
              </div>
            ))}
            {!Object.keys(usage?.byModel ?? {}).length && (
              <div className="px-4 py-8 text-center text-ink-faint text-[13px]">暂无用量数据</div>
            )}
          </div>
        </Section>

        <Section title="审计日志">
          <div className="bg-surface border border-line rounded-xl overflow-hidden">
            {audit?.slice(0, 30).map((a) => (
              <div key={a.id} className="flex items-center gap-3 px-4 py-2 border-b border-line-soft last:border-0 text-[12.5px]">
                <span className="font-mono text-primary-hover w-32 shrink-0">{a.action}</span>
                <span className="text-ink-soft flex-1 truncate">{a.detail ?? a.target ?? ''}</span>
                <span className="text-ink-faint font-mono">{new Date(a.ts).toLocaleString('zh-CN')}</span>
              </div>
            ))}
            {!audit?.length && <div className="px-4 py-8 text-center text-ink-faint text-[13px]">暂无审计记录</div>}
          </div>
        </Section>
      </div>
    </div>
  );
}

const fmt = (n?: number) => (n ?? 0).toLocaleString();

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-surface border border-line rounded-xl p-4">
      <div className="text-[12px] text-ink-faint mb-1">{label}</div>
      <div className="text-[22px] font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-6">
      <h2 className="text-[13px] font-medium text-ink-soft mb-2">{title}</h2>
      {children}
    </div>
  );
}
