import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useI18n } from '../i18n';

export function Admin() {
  const { t, locale } = useI18n();
  const { data: usage } = useQuery({ queryKey: ['usage'], queryFn: () => api.adminUsage(7) });
  const { data: audit } = useQuery({ queryKey: ['audit'], queryFn: api.adminAudit });

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[960px] mx-auto px-8 py-10">
        <h1 className="text-[24px] font-bold mb-1">{t('admin.title')}</h1>
        <p className="text-ink-soft text-[14px] mb-7">{t('admin.subtitle')}</p>

        <ModelProviders />

        <div className="grid grid-cols-4 gap-3 mb-6">
          <Stat label={t('admin.stat.tasks')} value={usage?.taskCount ?? 0} />
          <Stat label={t('admin.stat.inTokens')} value={fmt(usage?.totalIn)} />
          <Stat label={t('admin.stat.outTokens')} value={fmt(usage?.totalOut)} />
          <Stat label={t('admin.stat.models')} value={Object.keys(usage?.byModel ?? {}).length} />
        </div>

        <Section title={t('admin.section.byStatus')}>
          <div className="flex flex-wrap gap-2">
            {(usage?.byStatus ?? []).map((s: any) => (
              <span key={s.status} className="px-3 py-1.5 rounded-lg bg-surface border border-line text-[13px]">
                {s.status}
                {t('common.colon')}
                <b>{s._count}</b>
              </span>
            ))}
          </div>
        </Section>

        <Section title={t('admin.section.byModel')}>
          <div className="bg-surface border border-line rounded-xl overflow-hidden">
            {Object.entries(usage?.byModel ?? {}).map(([model, v]: [string, any]) => (
              <div key={model} className="flex items-center gap-3 px-4 py-2.5 border-b border-line-soft last:border-0 text-[13px]">
                <span className="font-mono flex-1">{model}</span>
                <span className="text-ink-soft">{t('admin.calls', { n: v.count })}</span>
                <span className="text-ink-faint font-mono">
                  {t('admin.inOut', { in: fmt(v.in), out: fmt(v.out) })}
                </span>
              </div>
            ))}
            {!Object.keys(usage?.byModel ?? {}).length && (
              <div className="px-4 py-8 text-center text-ink-faint text-[13px]">
                {t('admin.noUsage')}
              </div>
            )}
          </div>
        </Section>

        <Section title={t('admin.section.audit')}>
          <div className="bg-surface border border-line rounded-xl overflow-hidden">
            {audit?.slice(0, 30).map((a) => (
              <div key={a.id} className="flex items-center gap-3 px-4 py-2 border-b border-line-soft last:border-0 text-[12.5px]">
                <span className="font-mono text-primary-hover w-32 shrink-0">{a.action}</span>
                <span className="text-ink-soft flex-1 truncate">{a.detail ?? a.target ?? ''}</span>
                <span className="text-ink-faint font-mono">{new Date(a.ts).toLocaleString(locale)}</span>
              </div>
            ))}
            {!audit?.length && (
              <div className="px-4 py-8 text-center text-ink-faint text-[13px]">
                {t('admin.noAudit')}
              </div>
            )}
          </div>
        </Section>
      </div>
    </div>
  );
}

function ModelProviders() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const { data: models } = useQuery({ queryKey: ['models'], queryFn: () => api.adminModels() });
  const [form, setForm] = useState({ name: '', baseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'qwen3:4b', tier: 'deep' });
  const [result, setResult] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!form.name || !form.baseUrl || !form.model) return;
    setSaving(true);
    try {
      await api.upsertModel(form);
      setForm({ ...form, name: '', apiKey: '' });
      qc.invalidateQueries({ queryKey: ['models'] });
    } finally {
      setSaving(false);
    }
  };
  const test = async (id: string) => {
    setResult((r) => ({ ...r, [id]: t('common.testing') }));
    const res = await api.testModel(id);
    setResult((r) => ({
      ...r,
      [id]: res.ok
        ? `✓ ${t('admin.models.testOk', { reply: res.reply || 'ok' })}`
        : `✗ ${res.error}`,
    }));
  };
  const remove = async (id: string) => {
    await api.deleteModel(id);
    qc.invalidateQueries({ queryKey: ['models'] });
  };

  return (
    <Section title={t('admin.models.section')}>
      <div className="bg-surface border border-line rounded-xl p-4 mb-3">
        <div className="grid grid-cols-3 gap-2 mb-2">
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t('admin.models.namePlaceholder')} className="px-3 h-9 rounded-lg border border-line outline-none text-[13px]" />
          <input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder={t('admin.models.baseUrlPlaceholder')} className="px-3 h-9 rounded-lg border border-line outline-none text-[13px] font-mono col-span-2" />
        </div>
        <div className="grid grid-cols-3 gap-2 mb-2">
          <input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder={t('admin.models.modelPlaceholder')} className="px-3 h-9 rounded-lg border border-line outline-none text-[13px] font-mono" />
          <input value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} placeholder={t('admin.models.apiKeyPlaceholder')} type="password" className="px-3 h-9 rounded-lg border border-line outline-none text-[13px]" />
          <select value={form.tier} onChange={(e) => setForm({ ...form, tier: e.target.value })} className="px-3 h-9 rounded-lg border border-line outline-none text-[13px]">
            <option value="deep">{t('admin.models.tier.deep')}</option>
            <option value="fast">{t('admin.models.tier.fast')}</option>
            <option value="auto">{t('admin.models.tier.auto')}</option>
          </select>
        </div>
        <button onClick={save} disabled={saving} className="px-4 h-9 rounded-lg bg-primary hover:bg-primary-hover text-white text-[13px] font-medium">
          {t('admin.models.save')}
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
                <button onClick={() => test(m.id)} className="px-2.5 h-7 rounded-lg bg-line-soft text-[12px] hover:bg-line">{t('common.test')}</button>
                <button onClick={() => remove(m.id)} className="px-2 h-7 rounded-lg text-ink-faint text-[12px] hover:bg-line-soft">{t('common.delete')}</button>
              </div>
            </div>
            {result[m.id] && <div className="text-[12px] mt-1 text-ink-soft font-mono">{result[m.id]}</div>}
          </div>
        ))}
        {!models?.length && (
          <div className="px-4 py-6 text-center text-ink-faint text-[13px]">
            {t('admin.models.empty')}
          </div>
        )}
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
