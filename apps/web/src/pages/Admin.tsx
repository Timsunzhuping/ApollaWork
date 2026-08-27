import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';

export function Admin() {
  const { data: usage } = useQuery({ queryKey: ['usage'], queryFn: () => api.adminUsage(7) });
  const { data: audit } = useQuery({ queryKey: ['audit'], queryFn: api.adminAudit });

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[960px] mx-auto px-8 py-10">
        <h1 className="text-[24px] font-bold mb-1">管理后台</h1>
        <p className="text-ink-soft text-[14px] mb-7">模型治理、用量看板与审计。</p>

        <ModelProviders />

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

function ModelProviders() {
  const qc = useQueryClient();
  const { data: models } = useQuery({ queryKey: ['models'], queryFn: fetchModels });
  const [form, setForm] = useState({ name: '', baseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'qwen3:4b', tier: 'deep' });
  const [result, setResult] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  async function fetchModels() {
    const res = await fetch('/api/v1/admin/models');
    return res.json() as Promise<any[]>;
  }
  const save = async () => {
    if (!form.name || !form.baseUrl || !form.model) return;
    setSaving(true);
    try {
      await fetch('/api/v1/admin/models', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(form) });
      setForm({ ...form, name: '', apiKey: '' });
      qc.invalidateQueries({ queryKey: ['models'] });
    } finally {
      setSaving(false);
    }
  };
  const test = async (id: string) => {
    setResult((r) => ({ ...r, [id]: '测试中…' }));
    const res = await fetch(`/api/v1/admin/models/${id}/test`, { method: 'POST' }).then((r) => r.json());
    setResult((r) => ({ ...r, [id]: res.ok ? `✓ 连通：${res.reply || 'ok'}` : `✗ ${res.error}` }));
  };
  const remove = async (id: string) => {
    await fetch(`/api/v1/admin/models/${id}`, { method: 'DELETE' });
    qc.invalidateQueries({ queryKey: ['models'] });
  };

  return (
    <Section title="模型接入（配置后即可用真实模型；档位 deep=复杂任务 / fast=简单任务 / auto=兜底）">
      <div className="bg-surface border border-line rounded-xl p-4 mb-3">
        <div className="grid grid-cols-3 gap-2 mb-2">
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="名称，如 vLLM-Qwen" className="px-3 h-9 rounded-lg border border-line outline-none text-[13px]" />
          <input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="Base URL (/v1)" className="px-3 h-9 rounded-lg border border-line outline-none text-[13px] font-mono col-span-2" />
        </div>
        <div className="grid grid-cols-3 gap-2 mb-2">
          <input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="模型名" className="px-3 h-9 rounded-lg border border-line outline-none text-[13px] font-mono" />
          <input value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} placeholder="API Key（加密存储）" type="password" className="px-3 h-9 rounded-lg border border-line outline-none text-[13px]" />
          <select value={form.tier} onChange={(e) => setForm({ ...form, tier: e.target.value })} className="px-3 h-9 rounded-lg border border-line outline-none text-[13px]">
            <option value="deep">deep（深度）</option>
            <option value="fast">fast（快速）</option>
            <option value="auto">auto（兜底）</option>
          </select>
        </div>
        <button onClick={save} disabled={saving} className="px-4 h-9 rounded-lg bg-primary hover:bg-primary-hover text-white text-[13px] font-medium">
          添加 / 更新模型
        </button>
      </div>
      <div className="bg-surface border border-line rounded-xl overflow-hidden">
        {(models ?? []).map((m: any) => (
          <div key={m.id} className="px-4 py-2.5 border-b border-line-soft last:border-0">
            <div className="flex items-center gap-3 text-[13px]">
              <span className="px-2 py-0.5 rounded bg-primary-soft text-primary-hover text-[11px] font-medium">{m.tier}</span>
              <span className="font-medium">{m.name}</span>
              <span className="text-ink-faint font-mono text-[12px]">{m.model} @ {m.baseUrl}</span>
              <div className="ml-auto flex gap-1.5">
                <button onClick={() => test(m.id)} className="px-2.5 h-7 rounded-lg bg-line-soft text-[12px] hover:bg-line">测试</button>
                <button onClick={() => remove(m.id)} className="px-2 h-7 rounded-lg text-ink-faint text-[12px] hover:bg-line-soft">删除</button>
              </div>
            </div>
            {result[m.id] && <div className="text-[12px] mt-1 text-ink-soft font-mono">{result[m.id]}</div>}
          </div>
        ))}
        {!models?.length && <div className="px-4 py-6 text-center text-ink-faint text-[13px]">未配置模型 —— 当前使用环境变量默认模型。添加一个即可从界面管理。</div>}
      </div>
    </Section>
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
