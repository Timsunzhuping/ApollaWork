import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useUI } from '../store';
import { useI18n, type I18nKey } from '../i18n';
import { IconAuto, IconPlus } from '../icons';

const PRESETS: { labelKey: I18nKey; cron: string }[] = [
  { labelKey: 'automation.preset.daily9', cron: '0 9 * * *' },
  { labelKey: 'automation.preset.weeklyMon9', cron: '0 9 * * 1' },
  { labelKey: 'automation.preset.hourly', cron: '0 * * * *' },
];

export function Automation() {
  const { workspaceId } = useUI();
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [form, setForm] = useState({ name: '', cron: '0 9 * * *', prompt: '' });
  const [creating, setCreating] = useState(false);

  const { data: rows } = useQuery({
    queryKey: ['automations', workspaceId],
    queryFn: () => api.automations(workspaceId!),
    enabled: !!workspaceId,
  });

  const create = async () => {
    if (!form.name.trim() || !form.prompt.trim()) return;
    setCreating(true);
    try {
      await api.createAutomation(workspaceId!, form);
      setForm({ name: '', cron: '0 9 * * *', prompt: '' });
      qc.invalidateQueries({ queryKey: ['automations', workspaceId] });
    } finally {
      setCreating(false);
    }
  };
  const runNow = async (id: string) => {
    const r = await api.runAutomation(id);
    if (r.taskId) nav(`/task/${r.taskId}`);
  };
  const remove = async (id: string) => {
    await api.deleteAutomation(id);
    qc.invalidateQueries({ queryKey: ['automations', workspaceId] });
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[860px] mx-auto px-8 py-10">
        <div className="flex items-center gap-2 mb-1">
          <IconAuto className="w-5 h-5 text-primary" />
          <h1 className="text-[24px] font-bold">{t('automation.title')}</h1>
        </div>
        <p className="text-ink-soft text-[14px] mb-7">{t('automation.subtitle')}</p>

        <div className="bg-surface border border-line rounded-xl p-4 mb-6">
          <div className="grid grid-cols-2 gap-3 mb-3">
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder={t('automation.namePlaceholder')}
              className="px-3 h-10 rounded-lg border border-line outline-none text-[14px] focus:border-primary/40"
            />
            <div className="flex items-center gap-2">
              <input
                value={form.cron}
                onChange={(e) => setForm({ ...form, cron: e.target.value })}
                placeholder={t('automation.cronPlaceholder')}
                className="flex-1 px-3 h-10 rounded-lg border border-line outline-none text-[14px] font-mono focus:border-primary/40"
              />
            </div>
          </div>
          <div className="flex gap-1.5 mb-3">
            {PRESETS.map((p) => (
              <button
                key={p.cron}
                onClick={() => setForm({ ...form, cron: p.cron })}
                className={`px-2.5 h-7 rounded-lg text-[12px] ${form.cron === p.cron ? 'bg-primary-soft text-primary-hover' : 'text-ink-soft hover:bg-line-soft'}`}
              >
                {t(p.labelKey)}
              </button>
            ))}
          </div>
          <textarea
            value={form.prompt}
            onChange={(e) => setForm({ ...form, prompt: e.target.value })}
            placeholder={t('automation.promptPlaceholder')}
            rows={2}
            className="w-full px-3 py-2 rounded-lg border border-line outline-none text-[14px] resize-none mb-3 focus:border-primary/40"
          />
          <button
            onClick={create}
            disabled={creating}
            className="flex items-center gap-1.5 px-4 h-9 rounded-lg bg-primary hover:bg-primary-hover text-white text-[13px] font-medium"
          >
            <IconPlus className="w-4 h-4" /> {t('automation.create')}
          </button>
        </div>

        <div className="bg-surface border border-line rounded-xl overflow-hidden">
          {rows?.map((a) => (
            <div key={a.id} className="flex items-center gap-3 px-4 py-3 border-b border-line-soft last:border-0">
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-medium truncate">{a.name}</div>
                <div className="text-[12px] text-ink-faint font-mono">
                  {a.cron} ·{' '}
                  {t('automation.next', {
                    time: a.nextRun ? new Date(a.nextRun).toLocaleString(locale) : '—',
                  })}
                  {a.lastRunAt
                    ? ` · ${t('automation.last', {
                        time: new Date(a.lastRunAt).toLocaleString(locale),
                      })}`
                    : ''}
                </div>
              </div>
              <button onClick={() => runNow(a.id)} className="px-3 h-8 rounded-lg bg-primary-soft text-primary-hover text-[12px] hover:bg-primary/15">
                {t('automation.runNow')}
              </button>
              <button onClick={() => remove(a.id)} className="px-2 h-8 rounded-lg text-ink-faint text-[12px] hover:bg-line-soft">
                {t('common.delete')}
              </button>
            </div>
          ))}
          {!rows?.length && (
            <div className="px-4 py-10 text-center text-ink-faint text-[13px]">
              {t('automation.empty')}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
