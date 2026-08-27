import { NavLink, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useUI } from '../store';
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

const NAV = [
  { to: '/', label: '新建任务', icon: IconPlus, exact: true },
  { to: '/files', label: '项目', icon: IconProject },
  { to: '/skills', label: '专家·技能·连接器', icon: IconExpert },
  { to: '/automation', label: '自动化', icon: IconAuto },
  { to: '/library', label: '资料库', icon: IconLibrary },
  { to: '/admin', label: '更多', icon: IconMore, hint: '管理·灵感' },
];

export function Sidebar() {
  const nav = useNavigate();
  const { workspaceId } = useUI();
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
        <span className="font-semibold text-[15px] tracking-tight">Apolla Work</span>
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
            <span className="truncate">{item.label}</span>
            {item.hint && <span className="ml-auto text-[11px] text-ink-faint">{item.hint}</span>}
          </NavLink>
        ))}
      </nav>

      <div className="flex-1 overflow-y-auto px-2.5 mt-3">
        <div className="px-2 text-[11px] font-medium text-ink-faint mb-1.5 flex items-center gap-1">
          任务 {sessions?.length ? `(${sessions.length})` : ''}
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
                {s.title || last?.prompt || '未命名任务'}
              </div>
            </button>
          );
        })}
        {!sessions?.length && (
          <div className="px-2.5 py-4 text-[12px] text-ink-faint">还没有任务，去新建一个吧。</div>
        )}
      </div>

      <div className="p-2.5 border-t border-line-soft">
        <button
          onClick={() => nav('/')}
          className="w-full flex items-center gap-2 justify-center h-9 rounded-lg bg-primary hover:bg-primary-hover text-white text-[13px] font-medium transition-colors"
        >
          <IconPlus className="w-[18px] h-[18px]" />
          新建任务
        </button>
      </div>
    </aside>
  );
}
