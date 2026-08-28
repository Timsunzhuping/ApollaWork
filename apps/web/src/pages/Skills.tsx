import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useI18n } from '../i18n';
import { IconSpark, IconExpert, IconPlus, IconCheck } from '../icons';

export function Skills() {
  const [tab, setTab] = useState<'installed' | 'market'>('installed');
  const { t } = useI18n();
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
          <h1 className="text-[24px] font-bold">{t('skills.title')}</h1>
        </div>
        <p className="text-ink-soft text-[14px] mb-5">
          {t('skills.subtitle')} {t('skills.connectorsHintPrefix')}{' '}
          <Link to="/connectors" className="text-primary underline">
            {t('skills.connectorsLink')}
          </Link>
          {t('skills.connectorsHintSuffix')}
        </p>

        <div className="flex gap-1 mb-5 border-b border-line">
          {(['installed', 'market'] as const).map((key) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`px-4 h-9 text-[13.5px] border-b-2 -mb-px ${
                tab === key
                  ? 'border-primary text-ink font-medium'
                  : 'border-transparent text-ink-soft'
              }`}
            >
              {key === 'installed'
                ? t('skills.tab.installed', { n: skills?.length ?? 0 })
                : t('skills.tab.market')}
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
                    {s.scope === 'builtin' ? t('skills.scope.builtin') : t('skills.installed')}
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
                        <IconCheck className="w-3.5 h-3.5" /> {t('skills.installed')}
                      </button>
                    ) : (
                      <button onClick={() => install(m.name)} className="flex items-center gap-1 px-2.5 h-7 rounded-lg bg-primary text-white text-[12px] hover:bg-primary-hover">
                        <IconPlus className="w-3.5 h-3.5" /> {t('skills.install')}
                      </button>
                    )}
                  </div>
                </div>
                <p className="text-[13px] text-ink-soft leading-relaxed">{m.description}</p>
              </div>
            ))}
            {!market?.length && (
              <div className="text-ink-faint text-[13px]">{t('skills.marketEmpty')}</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
