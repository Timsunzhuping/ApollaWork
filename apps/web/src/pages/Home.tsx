import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useUI } from '../store';
import { Composer } from '../components/Composer';
import { useI18n, type I18nKey } from '../i18n';
import { IconDoc, IconFinance, IconChart, IconGrid, IconSlides, IconSpark } from '../icons';

const CATEGORIES = [
  { key: 'work', labelKey: 'home.category.work', icon: IconSpark },
  { key: 'code', labelKey: 'home.category.code', icon: IconGrid },
  { key: 'design', labelKey: 'home.category.design', icon: IconSlides },
] as const satisfies readonly {
  key: 'work' | 'code' | 'design';
  labelKey: I18nKey;
  icon: unknown;
}[];

const CHIPS: { labelKey: I18nKey; promptKey: I18nKey; icon: (p: { className?: string }) => React.ReactNode }[] = [
  { labelKey: 'home.chip.doc.label', promptKey: 'home.chip.doc.prompt', icon: IconDoc },
  { labelKey: 'home.chip.finance.label', promptKey: 'home.chip.finance.prompt', icon: IconFinance },
  { labelKey: 'home.chip.data.label', promptKey: 'home.chip.data.prompt', icon: IconChart },
  { labelKey: 'home.chip.workspace.label', promptKey: 'home.chip.workspace.prompt', icon: IconGrid },
  { labelKey: 'home.chip.slides.label', promptKey: 'home.chip.slides.prompt', icon: IconSlides },
];

export function Home() {
  const nav = useNavigate();
  const { workspaceId, mode, modelTier, category, setCategory } = useUI();
  const { t } = useI18n();
  const [starting, setStarting] = useState(false);
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: api.me });

  const start = async (prompt: string) => {
    if (!workspaceId || starting) return;
    setStarting(true);
    try {
      const { id: sessionId } = await api.createSession(workspaceId, prompt.slice(0, 30));
      const task = await api.createTask(sessionId, { prompt, mode, modelTier });
      nav(`/task/${task.id}`);
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[720px] mx-auto px-6 pt-[13vh] pb-16">
        <h1 className="text-center text-[30px] font-bold tracking-tight mb-1">
          {me?.name ? t('home.titleWithName', { name: me.name }) : t('home.title')}
        </h1>
        <p className="text-center text-ink-soft text-[14px] mb-7">{t('home.subtitle')}</p>

        <div className="flex justify-center gap-1 mb-6">
          {CATEGORIES.map((c) => (
            <button
              key={c.key}
              onClick={() => setCategory(c.key)}
              className={`flex items-center gap-1.5 px-4 h-9 rounded-full text-[13px] font-medium transition-colors ${
                category === c.key ? 'bg-ink text-white' : 'text-ink-soft hover:bg-line-soft'
              }`}
            >
              <c.icon className="w-4 h-4" />
              {t(c.labelKey)}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap justify-center gap-2 mb-4">
          {CHIPS.map((c) => (
            <button
              key={c.labelKey}
              onClick={() => start(t(c.promptKey))}
              className="flex items-center gap-1.5 px-3.5 h-9 rounded-full bg-surface border border-line text-[13px] text-ink-soft hover:border-primary/40 hover:text-ink transition-colors"
            >
              <c.icon className="w-4 h-4 text-primary" />
              {t(c.labelKey)}
            </button>
          ))}
        </div>

        <Composer onSubmit={start} busy={starting} />

        <p className="text-center text-[12px] text-ink-faint mt-3">{t('home.footer')}</p>
      </div>
    </div>
  );
}
