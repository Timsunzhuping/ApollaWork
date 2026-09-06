import { useState } from 'react';
import { api } from '../api';
import { useI18n } from '../i18n';
import { IconDoc, IconDownload, IconFile } from '../icons';

interface Art {
  path: string;
  title: string;
  kind: string;
  mime?: string;
}

const PREVIEWABLE = /\.(pdf|png|jpe?g|gif|svg|html?|md|txt|csv|json)$/i;

export function ArtifactPanel({ workspaceId, artifacts }: { workspaceId: string; artifacts: Art[] }) {
  const [active, setActive] = useState<Art | null>(artifacts[0] ?? null);
  const { t } = useI18n();
  const cur = active ?? artifacts[0];

  return (
    <aside data-testid="artifact-panel" className="w-[400px] shrink-0 border-l border-line bg-surface flex flex-col h-full">
      <div className="h-14 shrink-0 border-b border-line flex items-center px-4 gap-2">
        <IconDoc className="w-4 h-4 text-primary" />
        <span className="text-[13px] font-medium">
          {t('artifact.title', { n: artifacts.length })}
        </span>
      </div>
      <div className="flex gap-1.5 px-3 py-2 overflow-x-auto border-b border-line-soft">
        {artifacts.map((a) => (
          <button
            key={a.path}
            onClick={() => setActive(a)}
            className={`px-2.5 h-7 rounded-lg text-[12px] whitespace-nowrap ${
              cur?.path === a.path ? 'bg-primary-soft text-primary-hover' : 'text-ink-soft hover:bg-line-soft'
            }`}
          >
            {a.title}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-auto p-3">
        {cur && <Preview workspaceId={workspaceId} art={cur} />}
      </div>
      {cur && (
        <div className="shrink-0 p-3 border-t border-line">
          <a
            href={api.fileUrl(workspaceId, cur.path)}
            className="flex items-center justify-center gap-1.5 h-9 rounded-lg bg-primary hover:bg-primary-hover text-white text-[13px] font-medium"
          >
            <IconDownload className="w-4 h-4" />{' '}
            {t('artifact.download', { name: cur.path.split('/').pop() ?? cur.path })}
          </a>
        </div>
      )}
    </aside>
  );
}

function Preview({ workspaceId, art }: { workspaceId: string; art: Art }) {
  const { t } = useI18n();
  const url = api.fileUrl(workspaceId, art.path, true);
  if (!PREVIEWABLE.test(art.path)) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-ink-faint gap-2 py-16">
        <IconFile className="w-10 h-10" />
        <div className="text-[13px]">{art.path.split('/').pop()}</div>
        <div className="text-[12px]">{t('artifact.noPreview')}</div>
      </div>
    );
  }
  if (/\.pdf$/i.test(art.path)) {
    return <iframe src={url} className="w-full h-full min-h-[70vh] rounded-lg border border-line" title={art.title} />;
  }
  if (/\.(png|jpe?g|gif|svg)$/i.test(art.path)) {
    return <img src={url} alt={art.title} className="max-w-full rounded-lg border border-line" />;
  }
  // 文本类：直接内嵌 iframe（服务端按 mime 返回）
  return <iframe src={url} className="w-full h-full min-h-[70vh] rounded-lg border border-line bg-white" title={art.title} />;
}
