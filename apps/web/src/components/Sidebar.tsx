import { NavLink, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useUI } from '../store';
import { LOCALES, useI18n, type I18nKey, type Locale } from '../i18n';
import {
  IconPlus,
  IconAssistant,
  IconProject,
  IconExpert,
  IconAuto,
  IconLibrary,
  IconMore,
  IconSearch,
} from '../icons';

interface NavItem {
  to: string;
  labelKey: I18nKey;
  icon: (p: { className?: string }) => React.ReactNode;
  exact?: boolean;
  hintKey?: I18nKey;
}

const NAV: NavItem[] = [
  { to: '/', labelKey: 'sidebar.newTask', icon: IconPlus, exact: true },
  { to: '/files', labelKey: 'sidebar.projects', icon: IconProject },
  { to: '/skills', labelKey: 'sidebar.skills', icon: IconExpert },
  { to: '/automation', labelKey: 'sidebar.automation', icon: IconAuto },
  { to: '/library', labelKey: 'sidebar.library', icon: IconLibrary },
  { to: '/members', labelKey: 'sidebar.members', icon: IconExpert },
  { to: '/admin', labelKey: 'sidebar.more', icon: IconMore, hintKey: 'sidebar.moreHint' },
];

/** 语言 → 语言名文案 key（用各语言自称，不随界面语言变化）。 */
const LANG_LABEL: Record<Locale, I18nKey> = {
  'zh-CN': 'lang.zh-CN',
  'en-US': 'lang.en-US',
};

export function Sidebar() {
  const nav = useNavigate();
  const { workspaceId } = useUI();
  const { t, locale, setLocale } = useI18n();
  const { data: sessions } = useQuery({
    queryKey: ['sessions', workspaceId],
    queryFn: () => api.sessions(workspaceId!),
    enabled: !!workspaceId,
  });

  return (
    <aside className="w-[248px] shrink-0 bg-sidebar border-r border-line flex flex-col h-full">
      <div className="flex items-center gap-2 px-4 h-14 shrink-0">
        <div className="w-6 h-6 rounded-lg bg-primary flex items-center justify-center text-white text-[13px] font-bold">
          A
        </div>
        <span className="font-semibold text-[15px] tracking-tight">{t('app.name')}</span>
        <span className="text-ink-faint text-[11px] ml-auto">v1.0</span>
      </div>

      <nav className="px-2.5 pt-1">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.exact}
            className={({ isActive }) =>
              `flex items-center gap-2.5 px-3 h-9 rounded-lg text-[13.5px] mb-0.5 transition-colors ${
                isActive
                  ? 'bg-white text-ink font-medium shadow-[0_1px_2px_rgba(0,0,0,0.04)]'
                  : 'text-ink-soft hover:bg-white/60'
              }`
            }
          >
            <item.icon className="w-[18px] h-[18px] shrink-0" />
            <span className="truncate">{t(item.labelKey)}</span>
            {item.hintKey && (
              <span className="ml-auto text-[11px] text-ink-faint">{t(item.hintKey)}</span>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="flex-1 overflow-y-auto px-2.5 mt-3">
        <div className="px-2 text-[11px] font-medium text-ink-faint mb-1.5 flex items-center gap-1">
          {sessions?.length
            ? t('sidebar.tasksWithCount', { n: sessions.length })
            : t('sidebar.tasks')}
        </div>
        {sessions?.map((s) => {
          const last = s.tasks[0];
          return (
            <button
              key={s.id}
              onClick={() => last && nav(`/task/${last.id}`)}
              className="w-full text-left px-2.5 py-2 rounded-lg hover:bg-white/60 mb-0.5 group"
            >
              <div className="text-[13px] truncate text-ink-soft group-hover:text-ink">
                {s.title || last?.prompt || t('sidebar.untitledTask')}
              </div>
            </button>
          );
        })}
        {!sessions?.length && (
          <div className="px-2.5 py-4 text-[12px] text-ink-faint">{t('sidebar.emptyTasks')}</div>
        )}
      </div>

      <div className="p-2.5 border-t border-line-soft">
        <button
          onClick={() => nav('/')}
          className="w-full flex items-center gap-2 justify-center h-9 rounded-lg bg-primary hover:bg-primary-hover text-white text-[13px] font-medium transition-colors"
        >
          <IconPlus className="w-[18px] h-[18px]" />
          {t('sidebar.newTask')}
        </button>

        <div className="flex items-center gap-1 mt-2 px-0.5">
          <span className="text-[11px] text-ink-faint mr-auto">{t('sidebar.language')}</span>
          {LOCALES.map((l) => (
            <button
              key={l}
              onClick={() => setLocale(l)}
              className={`px-2 h-6 rounded-md text-[11.5px] transition-colors ${
                locale === l
                  ? 'bg-white text-ink font-medium shadow-[0_1px_2px_rgba(0,0,0,0.04)]'
                  : 'text-ink-faint hover:bg-white/60'
              }`}
            >
              {t(LANG_LABEL[l])}
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
}
