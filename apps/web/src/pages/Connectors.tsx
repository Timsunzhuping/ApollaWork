import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useI18n } from '../i18n';
import { IconExpert, IconPlus, IconCheck } from '../icons';

/** 连接器管理（MCP）。示例：stdio 命令型连接器。 */
export function Connectors() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [show, setShow] = useState(false);
  const [form, setForm] = useState({ name: '', command: 'python3', args: '', env: '' });
  const [testResult, setTestResult] = useState<Record<string, string>>({});

  const { data: rows } = useQuery({ queryKey: ['connectors'], queryFn: api.connectors });

  const create = async () => {
    if (!form.name.trim() || !form.command.trim()) return;
    const env: Record<string, string> = {};
    for (const line of form.env.split('\n')) {
      const [k, ...v] = line.split('=');
      if (k.trim()) env[k.trim()] = v.join('=').trim();
    }
    await api.upsertConnector({
      name: form.name,
      config: {
        transport: 'stdio',
        command: form.command,
        args: form.args.split(' ').filter(Boolean),
        env,
      },
    });
    setForm({ name: '', command: 'python3', args: '', env: '' });
    setShow(false);
    qc.invalidateQueries({ queryKey: ['connectors'] });
  };
  const test = async (id: string) => {
    setTestResult((r) => ({ ...r, [id]: t('common.testing') }));
    const res = await api.testConnector(id);
    setTestResult((r) => ({
      ...r,
      [id]: res.ok
        ? `✓ ${t('connectors.testOk', {
            n: res.tools?.length ?? 0,
            tools: (res.tools ?? []).join(', '),
          })}`
        : `✗ ${res.error}`,
    }));
  };
  const remove = async (id: string) => {
    await api.deleteConnector(id);
    qc.invalidateQueries({ queryKey: ['connectors'] });
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[860px] mx-auto px-8 py-10">
        <div className="flex items-center mb-1">
          <div className="flex items-center gap-2">
            <IconExpert className="w-5 h-5 text-primary" />
            <h1 className="text-[24px] font-bold">{t('connectors.title')}</h1>
          </div>
          <button
            onClick={() => setShow(!show)}
            className="ml-auto flex items-center gap-1.5 px-3.5 h-9 rounded-lg bg-primary hover:bg-primary-hover text-white text-[13px] font-medium"
          >
            <IconPlus className="w-4 h-4" /> {t('connectors.add')}
          </button>
        </div>
        <p className="text-ink-soft text-[14px] mb-6">{t('connectors.subtitle')}</p>

        {show && (
          <div className="bg-surface border border-line rounded-xl p-4 mb-5">
            <div className="grid grid-cols-2 gap-3 mb-3">
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t('connectors.namePlaceholder')} className="px-3 h-10 rounded-lg border border-line outline-none text-[14px]" />
              <input value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} placeholder={t('connectors.commandPlaceholder')} className="px-3 h-10 rounded-lg border border-line outline-none text-[14px] font-mono" />
            </div>
            <input value={form.args} onChange={(e) => setForm({ ...form, args: e.target.value })} placeholder={t('connectors.argsPlaceholder')} className="w-full px-3 h-10 rounded-lg border border-line outline-none text-[14px] font-mono mb-3" />
            <textarea value={form.env} onChange={(e) => setForm({ ...form, env: e.target.value })} placeholder={t('connectors.envPlaceholder')} rows={2} className="w-full px-3 py-2 rounded-lg border border-line outline-none text-[13px] font-mono resize-none mb-3" />
            <button onClick={create} className="px-4 h-9 rounded-lg bg-primary hover:bg-primary-hover text-white text-[13px] font-medium">{t('common.save')}</button>
          </div>
        )}

        <div className="bg-surface border border-line rounded-xl overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-line-soft bg-primary-soft/30 text-[13px]">
            <IconCheck className="w-4 h-4 text-primary" />
            <span className="font-medium">{t('connectors.builtinKb')}</span>
            <span className="text-ink-faint text-[12px]">{t('connectors.builtinKbHint')}</span>
          </div>
          {rows?.map((c) => (
            <div key={c.id} className="px-4 py-3 border-b border-line-soft last:border-0">
              <div className="flex items-center gap-3">
                <span className="text-[14px] font-medium">{c.name}</span>
                <span className="text-[12px] text-ink-faint font-mono">{c.config?.command} {(c.config?.args ?? []).join(' ')}</span>
                <div className="ml-auto flex gap-1.5">
                  <button onClick={() => test(c.id)} className="px-2.5 h-7 rounded-lg bg-line-soft text-[12px] hover:bg-line">{t('common.test')}</button>
                  <button onClick={() => remove(c.id)} className="px-2 h-7 rounded-lg text-ink-faint text-[12px] hover:bg-line-soft">{t('common.delete')}</button>
                </div>
              </div>
              {testResult[c.id] && <div className="text-[12px] mt-1.5 text-ink-soft font-mono">{testResult[c.id]}</div>}
            </div>
          ))}
          {!rows?.length && (
            <div className="px-4 py-8 text-center text-ink-faint text-[13px]">
              {t('connectors.empty')}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
