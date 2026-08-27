import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useUI } from '../store';
import { IconAuto, IconPlus } from '../icons';

const PRESETS = [
  { label: '每天 9:00', cron: '0 9 * * *' },
  { label: '每周一 9:00', cron: '0 9 * * 1' },
  { label: '每小时', cron: '0 * * * *' },
];

export function Automation() {
  const { workspaceId } = useUI();
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
          <h1 className="text-[24px] font-bold">自动化</h1>
        </div>
        <p className="text-ink-soft text-[14px] mb-7">定时触发任务模板 —— 如每天生成数据日报、每周汇总周报。</p>

        <div className="bg-surface border border-line rounded-xl p-4 mb-6">
          <div className="grid grid-cols-2 gap-3 mb-3">
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="任务名称，如「每日数据日报」"
              className="px-3 h-10 rounded-lg border border-line outline-none text-[14px] focus:border-primary/40"
            />
            <div className="flex items-center gap-2">
              <input
                value={form.cron}
                onChange={(e) => setForm({ ...form, cron: e.target.value })}
                placeholder="cron 表达式"
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
                {p.label}
              </button>
            ))}
          </div>
          <textarea
            value={form.prompt}
            onChange={(e) => setForm({ ...form, prompt: e.target.value })}
            placeholder="要执行的指令，如「统计昨天各区域销售并生成日报」"
            rows={2}
            className="w-full px-3 py-2 rounded-lg border border-line outline-none text-[14px] resize-none mb-3 focus:border-primary/40"
          />
          <button
            onClick={create}
            disabled={creating}
            className="flex items-center gap-1.5 px-4 h-9 rounded-lg bg-primary hover:bg-primary-hover text-white text-[13px] font-medium"
          >
            <IconPlus className="w-4 h-4" /> 创建定时任务
          </button>
        </div>

        <div className="bg-surface border border-line rounded-xl overflow-hidden">
          {rows?.map((a) => (
            <div key={a.id} className="flex items-center gap-3 px-4 py-3 border-b border-line-soft last:border-0">
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-medium truncate">{a.name}</div>
                <div className="text-[12px] text-ink-faint font-mono">
                  {a.cron} · 下次 {a.nextRun ? new Date(a.nextRun).toLocaleString('zh-CN') : '—'}
                  {a.lastRunAt ? ` · 上次 ${new Date(a.lastRunAt).toLocaleString('zh-CN')}` : ''}
                </div>
              </div>
              <button onClick={() => runNow(a.id)} className="px-3 h-8 rounded-lg bg-primary-soft text-primary-hover text-[12px] hover:bg-primary/15">
                立即运行
              </button>
              <button onClick={() => remove(a.id)} className="px-2 h-8 rounded-lg text-ink-faint text-[12px] hover:bg-line-soft">
                删除
              </button>
            </div>
          ))}
          {!rows?.length && <div className="px-4 py-10 text-center text-ink-faint text-[13px]">还没有定时任务</div>}
        </div>
      </div>
    </div>
  );
}
