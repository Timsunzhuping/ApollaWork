import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { useI18n } from '../../i18n';

const SCOPES = ['tasks', 'files', 'admin'] as const;

/**
 * 集成用 API Key（T-419）。外部系统（IM 机器人、自动化脚本）用它调用接口，不再借用户令牌。
 * 明文只在签发那一刻显示一次；之后只看前缀、范围、最近使用、过期，可随时吊销。
 */
export function ApiKeys() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const { data: keys } = useQuery({ queryKey: ['api-keys'], queryFn: api.apiKeys });
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<Set<(typeof SCOPES)[number]>>(new Set(['tasks', 'files']));
  const [days, setDays] = useState('');
  const [issued, setIssued] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['api-keys'] });

  const issue = useMutation({
    mutationFn: () => api.issueApiKey({ name, scopes: [...scopes], expiresInDays: days ? Number(days) : undefined }),
    onSuccess: (r) => {
      setIssued(r.plaintext);
      setName('');
      setErr(null);
      refresh();
    },
    onError: (e) => setErr((e as Error).message),
  });
  const revoke = useMutation({ mutationFn: (id: string) => api.revokeApiKey(id), onSuccess: refresh, onError: (e) => setErr((e as Error).message) });

  return (
    <section className="mb-10" data-testid="api-keys">
      <h2 className="text-[15px] font-semibold mb-1">{t('apikey.title')}</h2>
      <p className="text-[13px] text-ink-soft mb-4">{t('apikey.subtitle')}</p>
      {err && <div className="mb-3 text-[12.5px] text-danger bg-danger-soft rounded-lg px-3 py-2">{err}</div>}

      {issued && (
        <div className="mb-4 rounded-xl border border-primary/40 bg-primary-soft p-4" data-testid="apikey-issued">
          <div className="text-[13px] font-medium mb-1">{t('apikey.issuedTitle')}</div>
          <code className="block text-[12.5px] break-all select-all bg-surface rounded-lg px-3 py-2 border border-line">{issued}</code>
          <div className="text-[12px] text-ink-soft mt-2">{t('apikey.issuedHint')}</div>
          <button onClick={() => setIssued(null)} className="mt-2 text-[12.5px] text-primary hover:underline">
            {t('apikey.issuedDone')}
          </button>
        </div>
      )}

      <div className="rounded-xl border border-line bg-surface overflow-hidden mb-3">
        {(keys ?? []).map((k) => (
          <div key={k.id} className="flex items-center gap-3 px-4 py-2.5 border-b border-line last:border-b-0 text-[13px]" data-testid="apikey-row">
            <div className="flex-1 min-w-0">
              <div className="font-medium truncate">
                {k.name} <code className="text-[11.5px] text-ink-faint">ak_{k.prefix}_…</code>
              </div>
              <div className="text-[12px] text-ink-faint">
                {k.scopes.join(' · ')} · {t('apikey.lastUsed', { when: k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : t('apikey.never') })}
                {k.expiresAt && ` · ${t('apikey.expires', { when: new Date(k.expiresAt).toLocaleDateString() })}`}
              </div>
            </div>
            {k.revokedAt ? (
              <span className="text-[11.5px] px-2 py-0.5 rounded bg-line-soft text-ink-faint">{t('apikey.revoked')}</span>
            ) : (
              <button onClick={() => revoke.mutate(k.id)} className="text-[12.5px] text-ink-soft hover:text-danger px-2 h-8 rounded-lg hover:bg-danger-soft" data-testid="apikey-revoke">
                {t('apikey.revoke')}
              </button>
            )}
          </div>
        ))}
        {!keys?.length && <div className="px-4 py-4 text-[13px] text-ink-faint">{t('apikey.empty')}</div>}
      </div>

      <form
        className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-line p-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && scopes.size) issue.mutate();
        }}
      >
        <input data-testid="apikey-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('apikey.namePlaceholder')} className="flex-1 min-w-[200px] px-3 h-9 rounded-lg border border-line outline-none text-[13px] bg-surface" />
        {SCOPES.map((s) => (
          <label key={s} className="flex items-center gap-1.5 text-[12.5px] px-2 h-9 rounded-lg border border-line bg-surface cursor-pointer">
            <input
              type="checkbox"
              checked={scopes.has(s)}
              onChange={(e) => {
                const next = new Set(scopes);
                if (e.target.checked) next.add(s);
                else next.delete(s);
                setScopes(next);
              }}
            />
            {t(`apikey.scope.${s}` as const)}
          </label>
        ))}
        <input value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, ''))} placeholder={t('apikey.daysPlaceholder')} className="w-[150px] px-3 h-9 rounded-lg border border-line outline-none text-[13px] bg-surface" />
        <button data-testid="apikey-issue" type="submit" disabled={issue.isPending || !name.trim()} className="h-9 px-3.5 rounded-lg bg-primary hover:bg-primary-hover disabled:opacity-50 text-white text-[13px] font-medium">
          {t('apikey.issue')}
        </button>
      </form>
    </section>
  );
}
