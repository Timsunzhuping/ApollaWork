import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useUI } from '../store';
import { Composer } from '../components/Composer';
import { IconDoc, IconFinance, IconChart, IconGrid, IconSlides, IconSpark } from '../icons';

const CATEGORIES = [
  { key: 'work', label: '日常办公', icon: IconSpark },
  { key: 'code', label: '代码开发', icon: IconGrid },
  { key: 'design', label: '设计创意', icon: IconSlides },
] as const;

const CHIPS = [
  { label: '文档处理', icon: IconDoc, prompt: '帮我把这份材料整理成一份结构清晰的 Word 报告' },
  { label: '金融服务', icon: IconFinance, prompt: '分析这份财报，输出经营分析和关键财务指标' },
  { label: '数据分析及可视化', icon: IconChart, prompt: '对这份数据做清洗和分析，并生成可视化图表' },
  { label: '个人工作台', icon: IconGrid, prompt: '把这个目录里的周报汇总成一份月度综述' },
  { label: '幻灯片', icon: IconSlides, prompt: '根据这些要点生成一份演示 PPT' },
];

export function Home() {
  const nav = useNavigate();
  const { workspaceId, mode, modelTier, category, setCategory } = useUI();
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
          {me?.name ? `${me.name}，` : ''}Apolla 帮你
        </h1>
        <p className="text-center text-ink-soft text-[14px] mb-7">
          用一句话下达任务，我在企业沙箱里帮你做完并交付文件
        </p>

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
              {c.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap justify-center gap-2 mb-4">
          {CHIPS.map((c) => (
            <button
              key={c.label}
              onClick={() => start(c.prompt)}
              className="flex items-center gap-1.5 px-3.5 h-9 rounded-full bg-surface border border-line text-[13px] text-ink-soft hover:border-primary/40 hover:text-ink transition-colors"
            >
              <c.icon className="w-4 h-4 text-primary" />
              {c.label}
            </button>
          ))}
        </div>

        <Composer onSubmit={start} busy={starting} />

        <p className="text-center text-[12px] text-ink-faint mt-3">
          所有任务在服务端隔离沙箱中执行 · 数据不出内网 · 全程可审计
        </p>
      </div>
    </div>
  );
}
