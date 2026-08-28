import { useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useUI } from '../store';
import { fmtBytes } from '../lib/md';
import { useI18n } from '../i18n';
import { IconFile, IconDownload, IconPlus } from '../icons';

export function Files() {
  const { workspaceId } = useUI();
  const { t } = useI18n();
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const { data: files } = useQuery({
    queryKey: ['files', workspaceId],
    queryFn: () => api.files(workspaceId!),
    enabled: !!workspaceId,
  });

  const upload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files?.length || !workspaceId) return;
    await api.uploadFiles(workspaceId, e.target.files);
    qc.invalidateQueries({ queryKey: ['files', workspaceId] });
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[860px] mx-auto px-8 py-10">
        <div className="flex items-center mb-6">
          <div>
            <h1 className="text-[24px] font-bold mb-1">{t('files.title')}</h1>
            <p className="text-ink-soft text-[14px]">{t('files.subtitle')}</p>
          </div>
          <button
            onClick={() => inputRef.current?.click()}
            className="ml-auto flex items-center gap-1.5 px-3.5 h-9 rounded-lg bg-primary hover:bg-primary-hover text-white text-[13px] font-medium"
          >
            <IconPlus className="w-4 h-4" /> {t('files.upload')}
          </button>
          <input ref={inputRef} type="file" multiple hidden onChange={upload} />
        </div>

        <div className="bg-surface border border-line rounded-xl overflow-hidden">
          {files?.map((f) => (
            <div key={f.path} className="flex items-center gap-3 px-4 py-2.5 border-b border-line-soft last:border-0">
              <IconFile className="w-4 h-4 text-ink-faint shrink-0" />
              <span className="text-[13.5px] flex-1 truncate">{f.path}</span>
              <span className="text-[12px] text-ink-faint font-mono">{fmtBytes(f.size)}</span>
              <a
                href={api.fileUrl(workspaceId!, f.path)}
                className="text-ink-faint hover:text-primary p-1"
                title={t('common.download')}
              >
                <IconDownload className="w-4 h-4" />
              </a>
            </div>
          ))}
          {!files?.length && (
            <div className="px-4 py-12 text-center text-ink-faint text-[13px]">
              {t('files.empty')}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
