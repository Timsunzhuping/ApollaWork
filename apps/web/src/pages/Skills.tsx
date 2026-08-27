import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { IconSpark, IconExpert, IconPlus, IconCheck } from '../icons';

export function Skills() {
  const [tab, setTab] = useState<'installed' | 'market'>('installed');
  const { data: skills } = useQuery({ queryKey: ['skills'], queryFn: api.skills });
  const { data: market } = useQuery({ queryKey: ['marketplace'], queryFn: api.marketplace });
  const qc = useQueryClient();

  const install = async (name: string) => {
    await api.installSkill(name);
    qc.invalidateQueries({ queryKey: ['marketplace'] });
    qc.invalidateQueries({ queryKey: ['skills'] });
  };
  const uninstall = async (name: string) => {
    await api.uninstallSkill(name);
    qc.invalidateQueries({ queryKey: ['marketplace'] });
    qc.invalidateQueries({ queryKey: ['skills'] });
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[860px] mx-auto px-8 py-10">
        <div className="flex items-center gap-2 mb-1">
          <IconExpert className="w-5 h-5 text-primary" />
          <h1 className="text-[24px] font-bold">专家 · 技能 · 连接器</h1>
        </div>
        <p className="text-ink-soft text-[14px] mb-5">
          技能是给 Agent 的可复用能力包（遵循 SKILL.md 规范），任务执行时按需自动加载。
          管理企业连接器请到 <Link to="/connectors" className="text-primary underline">连接器</Link>。
        </p>

        <div className="flex gap-1 mb-5 border-b border-line">
          {(['installed', 'market'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 h-9 text-[13.5px] border-b-2 -mb-px ${
                tab === t ? 'border-primary text-ink font-medium' : 'border-transparent text-ink-soft'
              }`}
            >
              {t === 'installed' ? `已启用技能 (${skills?.length ?? 0})` : '技能市场'}
            </button>
          ))}
        </div>

        {tab === 'installed' && (
          <div className="grid grid-cols-2 gap-3">
            {skills?.map((s) => (
              <div key={s.name} className="bg-surface border border-line rounded-xl p-4">
                <div className="flex items-center gap-2 mb-1.5">
                  <div className="w-7 h-7 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
                    <IconSpark className="w-4 h-4" />
                  </div>
                  <span className="font-medium text-[14px]">{s.name}</span>
                  <span className="ml-auto text-[11px] px-2 py-0.5 rounded-full bg-primary-soft text-primary-hover">
                    {s.scope === 'builtin' ? '内置' : '已安装'}
                  </span>
                </div>
                <p className="text-[13px] text-ink-soft leading-relaxed">{s.description}</p>
              </div>
            ))}
          </div>
        )}

        {tab === 'market' && (
          <div className="grid grid-cols-2 gap-3">
            {market?.map((m) => (
              <div key={m.name} className="bg-surface border border-line rounded-xl p-4">
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="font-medium text-[14px]">{m.name}</span>
                  <span className="text-[11px] text-ink-faint">v{m.version}</span>
                  <div className="ml-auto">
                    {m.installed ? (
                      <button onClick={() => uninstall(m.name)} className="flex items-center gap-1 px-2.5 h-7 rounded-lg bg-primary-soft text-primary-hover text-[12px]">
                        <IconCheck className="w-3.5 h-3.5" /> 已安装
                      </button>
                    ) : (
                      <button onClick={() => install(m.name)} className="flex items-center gap-1 px-2.5 h-7 rounded-lg bg-primary text-white text-[12px] hover:bg-primary-hover">
                        <IconPlus className="w-3.5 h-3.5" /> 安装
                      </button>
                    )}
                  </div>
                </div>
                <p className="text-[13px] text-ink-soft leading-relaxed">{m.description}</p>
              </div>
            ))}
            {!market?.length && <div className="text-ink-faint text-[13px]">市场暂无可安装技能。</div>}
          </div>
        )}
      </div>
    </div>
  );
}
