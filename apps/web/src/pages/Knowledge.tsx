import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useUI } from '../store';
import { useI18n } from '../i18n';
import { IconLibrary, IconFile, IconSearch, IconPlus } from '../icons';

export function Knowledge() {
  const { workspaceId } = useUI();
  const { t } = useI18n();
  const qc = useQueryClient();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<{ doc: string; page: number | null; text: string }[] | null>(null);
  const [searching, setSearching] = useState(false);

  const { data: docs } = useQuery({
    queryKey: ['kb-docs', workspaceId],
    queryFn: () => api.kbDocs(workspaceId!),
    enabled: !!workspaceId,
  });
  const { data: files } = useQuery({
    queryKey: ['files', workspaceId],
    queryFn: () => api.files(workspaceId!),
    enabled: !!workspaceId,
  });

  const indexed = new Set(docs?.map((d) => d.name));
  const ingestable = (files ?? []).filter(
    (f) => /\.(txt|md|csv|pdf|docx|json|log)$/i.test(f.path) && !indexed.has(f.path),
  );

  const ingest = async (path: string) => {
    await api.kbIngest(workspaceId!, path);
    qc.invalidateQueries({ queryKey: ['kb-docs', workspaceId] });
  };
  const runSearch = async () => {
    if (!query.trim()) return;
    setSearching(true);
    try {
      setHits(await api.kbSearch(workspaceId!, query.trim()));
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[860px] mx-auto px-8 py-10">
        <div className="flex items-center gap-2 mb-1">
          <IconLibrary className="w-5 h-5 text-primary" />
          <h1 className="text-[24px] font-bold">{t('knowledge.title')}</h1>
        </div>
        <p className="text-ink-soft text-[14px] mb-7">{t('knowledge.subtitle')}</p>

        <div className="bg-surface border border-line rounded-xl p-4 mb-6">
          <div className="flex gap-2">
            <div className="flex-1 flex items-center gap-2 px-3 h-10 rounded-lg border border-line">
              <IconSearch className="w-4 h-4 text-ink-faint" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && runSearch()}
                placeholder={t('knowledge.searchPlaceholder')}
                className="flex-1 bg-transparent outline-none text-[14px]"
              />
            </div>
            <button
              onClick={runSearch}
              disabled={searching}
              className="px-4 h-10 rounded-lg bg-primary hover:bg-primary-hover text-white text-[13px] font-medium"
            >
              {searching ? t('knowledge.searching') : t('knowledge.search')}
            </button>
          </div>
          {hits && (
            <div className="mt-3 flex flex-col gap-2">
              {hits.length === 0 && (
                <div className="text-ink-faint text-[13px]">{t('knowledge.noHits')}</div>
              )}
              {hits.map((h, i) => (
                <div key={i} className="text-[13px] border-l-2 border-primary/40 pl-3 py-1">
                  <div className="text-ink-faint text-[12px] mb-0.5">
                    {t('knowledge.source', { doc: h.doc })}
                    {h.page ? ` · ${t('knowledge.pageRef', { n: h.page })}` : ''}
                  </div>
                  <div className="text-ink-soft line-clamp-3">{h.text}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-5">
          <div>
            <h2 className="text-[13px] font-medium text-ink-soft mb-2">
              {t('knowledge.indexedDocs', { n: docs?.length ?? 0 })}
            </h2>
            <div className="bg-surface border border-line rounded-xl overflow-hidden">
              {docs?.map((d) => (
                <div key={d.name} className="flex items-center gap-2 px-3 py-2.5 border-b border-line-soft last:border-0 text-[13px]">
                  <IconFile className="w-4 h-4 text-primary shrink-0" />
                  <span className="flex-1 truncate">{d.name}</span>
                  <span className="text-ink-faint text-[11px]">
                    {t('knowledge.chunks', { n: d.chunks })}
                    {d.pages ? ` · ${t('knowledge.pages', { n: d.pages })}` : ''}
                  </span>
                </div>
              ))}
              {!docs?.length && (
                <div className="px-3 py-8 text-center text-ink-faint text-[13px]">
                  {t('knowledge.empty')}
                </div>
              )}
            </div>
          </div>
          <div>
            <h2 className="text-[13px] font-medium text-ink-soft mb-2">
              {t('knowledge.ingestable')}
            </h2>
            <div className="bg-surface border border-line rounded-xl overflow-hidden">
              {ingestable.map((f) => (
                <div key={f.path} className="flex items-center gap-2 px-3 py-2.5 border-b border-line-soft last:border-0 text-[13px]">
                  <span className="flex-1 truncate">{f.path}</span>
                  <button
                    onClick={() => ingest(f.path)}
                    className="flex items-center gap-1 px-2 h-7 rounded-lg bg-primary-soft text-primary-hover text-[12px] hover:bg-primary/15"
                  >
                    <IconPlus className="w-3.5 h-3.5" /> {t('knowledge.ingest')}
                  </button>
                </div>
              ))}
              {!ingestable.length && (
                <div className="px-3 py-8 text-center text-ink-faint text-[13px]">
                  {t('knowledge.ingestEmpty')}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
