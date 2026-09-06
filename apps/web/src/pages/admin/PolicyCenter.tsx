import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type PolicyView } from '../../api';
import { useI18n } from '../../i18n';

const KINDS = ['bash_command', 'file_delete', 'file_overwrite', 'network_egress'] as const;

/**
 * 策略中心（T-413）：审批规则表。
 * 内置规则只能启停（关掉「递归删除」这类规则会留审计），自定义规则可增删改、可限定到某个工作空间。
 * 变更免重启：下一个任务启动时即按新集合判定。
 */
export function PolicyCenter() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const { data: rules } = useQuery({ queryKey: ['policies'], queryFn: api.policies });
  const [form, setForm] = useState({ kind: 'bash_command' as (typeof KINDS)[number], pattern: '', flags: '', reason: '', workspaceId: '' });
  const [err, setErr] = useState<string | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['policies'] });
  const onErr = (e: unknown) => setErr((e as Error).message);

  const toggleBuiltin = useMutation({ mutationFn: (p: { key: string; enabled: boolean }) => api.setBuiltinPolicy(p.key, p.enabled), onSuccess: refresh, onError: onErr });
  const toggleCustom = useMutation({ mutationFn: (p: { id: string; enabled: boolean }) => api.updatePolicy(p.id, { enabled: p.enabled }), onSuccess: refresh, onError: onErr });
  const remove = useMutation({ mutationFn: (id: string) => api.deletePolicy(id), onSuccess: refresh, onError: onErr });
  const create = useMutation({
    mutationFn: () =>
      api.createPolicy({
        kind: form.kind,
        pattern: form.pattern,
        flags: form.flags,
        reason: form.reason,
        workspaceId: form.workspaceId.trim() || null,
      }),
    onSuccess: () => {
      setErr(null);
      setForm({ kind: 'bash_command', pattern: '', flags: '', reason: '', workspaceId: '' });
      refresh();
    },
    onError: onErr,
  });

  const builtins = (rules ?? []).filter((r) => r.builtin);
  const customs = (rules ?? []).filter((r) => !r.builtin);

  return (
    <section className="mb-10" data-testid="policy-center">
      <h2 className="text-[15px] font-semibold mb-1">{t('policy.title')}</h2>
      <p className="text-[13px] text-ink-soft mb-4">{t('policy.subtitle')}</p>
      {err && <div className="mb-3 text-[12.5px] text-danger bg-danger-soft rounded-lg px-3 py-2">{err}</div>}

      <h3 className="text-[13px] font-medium text-ink-soft mb-2">{t('policy.builtin')}</h3>
      <div className="rounded-xl border border-line bg-surface overflow-hidden mb-6">
        {builtins.map((r) => (
          <Row key={r.builtinKey!} r={r} onToggle={(enabled) => toggleBuiltin.mutate({ key: r.builtinKey!, enabled })} />
        ))}
      </div>

      <h3 className="text-[13px] font-medium text-ink-soft mb-2">
        {t('policy.custom')} <span className="text-ink-faint font-normal">({customs.length})</span>
      </h3>
      <div className="rounded-xl border border-line bg-surface overflow-hidden mb-3">
        {customs.map((r) => (
          <Row key={r.id!} r={r} onToggle={(enabled) => toggleCustom.mutate({ id: r.id!, enabled })} onRemove={() => remove.mutate(r.id!)} />
        ))}
        {!customs.length && <div className="px-4 py-4 text-[13px] text-ink-faint">{t('policy.noCustom')}</div>}
      </div>

      <form
        className="grid grid-cols-1 md:grid-cols-6 gap-2 rounded-xl border border-dashed border-line p-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (form.pattern.trim() && form.reason.trim()) create.mutate();
        }}
      >
        <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as (typeof KINDS)[number] })} className="px-2 h-9 rounded-lg border border-line text-[13px] bg-surface">
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {t(`policy.kind.${k}` as const)}
            </option>
          ))}
        </select>
        <input data-testid="policy-pattern" value={form.pattern} onChange={(e) => setForm({ ...form, pattern: e.target.value })} placeholder={t('policy.patternPlaceholder')} className="md:col-span-2 px-3 h-9 rounded-lg border border-line outline-none text-[13px] font-mono bg-surface" />
        <input value={form.flags} onChange={(e) => setForm({ ...form, flags: e.target.value })} placeholder="i" maxLength={6} className="px-3 h-9 rounded-lg border border-line outline-none text-[13px] font-mono bg-surface" />
        <input data-testid="policy-reason" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder={t('policy.reasonPlaceholder')} className="px-3 h-9 rounded-lg border border-line outline-none text-[13px] bg-surface" />
        <button data-testid="policy-add" type="submit" disabled={create.isPending} className="h-9 px-3 rounded-lg bg-primary hover:bg-primary-hover disabled:opacity-50 text-white text-[13px] font-medium">
          {t('policy.add')}
        </button>
        <input value={form.workspaceId} onChange={(e) => setForm({ ...form, workspaceId: e.target.value })} placeholder={t('policy.workspacePlaceholder')} className="md:col-span-6 px-3 h-9 rounded-lg border border-line outline-none text-[12.5px] font-mono bg-surface" />
      </form>
    </section>
  );
}

function Row({ r, onToggle, onRemove }: { r: PolicyView; onToggle: (enabled: boolean) => void; onRemove?: () => void }) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-3 px-4 py-2 border-b border-line last:border-b-0 text-[13px]" data-testid="policy-row">
      <label className="flex items-center gap-2 shrink-0 cursor-pointer">
        <input type="checkbox" checked={r.enabled} onChange={(e) => onToggle(e.target.checked)} className="accent-[var(--color-primary)]" />
        <span className={`text-[11px] px-1.5 py-0.5 rounded ${r.enabled ? 'bg-primary-soft text-primary' : 'bg-line-soft text-ink-faint'}`}>
          {t(`policy.kind.${r.kind as (typeof KINDS)[number]}` as const)}
        </span>
      </label>
      <code className="flex-1 min-w-0 truncate text-[12px] text-ink-soft" title={r.pattern}>
        /{r.pattern}/{r.flags}
      </code>
      <span className="truncate max-w-[220px] text-ink">{r.reason}</span>
      {r.workspaceId && <span className="text-[11px] text-ink-faint shrink-0">{t('policy.scopedTo', { id: r.workspaceId.slice(0, 8) })}</span>}
      {onRemove && (
        <button onClick={onRemove} className="text-[12px] text-ink-soft hover:text-danger px-2 h-7 rounded hover:bg-danger-soft shrink-0">
          {t('policy.remove')}
        </button>
      )}
    </div>
  );
}
