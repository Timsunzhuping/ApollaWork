import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { IconSpark } from '../icons';

export function Skills() {
  const { data: skills } = useQuery({ queryKey: ['skills'], queryFn: api.skills });
  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[860px] mx-auto px-8 py-10">
        <h1 className="text-[24px] font-bold mb-1">专家 · 技能 · 连接器</h1>
        <p className="text-ink-soft text-[14px] mb-7">
          技能是给 Agent 的可复用能力包（遵循 SKILL.md 规范）。任务执行时按需自动加载。
        </p>
        <div className="grid grid-cols-2 gap-3">
          {skills?.map((s) => (
            <div key={s.name} className="bg-surface border border-line rounded-xl p-4 hover:border-primary/30 transition-colors">
              <div className="flex items-center gap-2 mb-1.5">
                <div className="w-7 h-7 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
                  <IconSpark className="w-4 h-4" />
                </div>
                <span className="font-medium text-[14px]">{s.name}</span>
                <span className="ml-auto text-[11px] px-2 py-0.5 rounded-full bg-primary-soft text-primary-hover">
                  {s.scope === 'builtin' ? '内置' : '自定义'}
                </span>
              </div>
              <p className="text-[13px] text-ink-soft leading-relaxed">{s.description}</p>
            </div>
          ))}
          {!skills?.length && <div className="text-ink-faint text-[13px]">尚无可用技能。</div>}
        </div>
      </div>
    </div>
  );
}
