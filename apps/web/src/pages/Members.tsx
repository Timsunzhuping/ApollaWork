import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type MemberRow, type OrgMemberRow } from '../api';
import { useUI } from '../store';
import { useI18n } from '../i18n';
import { IconExpert, IconPlus } from '../icons';

const WS_ROLES = ['owner', 'editor', 'viewer'] as const;

/**
 * 成员与角色管理（T-410）。
 * 此前 server 有成员增删路由但界面零调用——管理员只能调 API 加人。
 * 上半部分：当前工作空间成员（owner / 组织管理员可管）；下半部分：组织成员与角色（仅管理员）。
 */
export function Members() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const { workspaceId } = useUI();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<(typeof WS_ROLES)[number]>('editor');
  const [err, setErr] = useState<string | null>(null);

  const { data: me } = useQuery({ queryKey: ['me'], queryFn: api.me });
  const { data: members } = useQuery({
    queryKey: ['members', workspaceId],
    queryFn: () => api.members(workspaceId!),
    enabled: !!workspaceId,
  });
  const isAdmin = me?.role === 'admin';
  const myRole = members?.find((m) => m.userId === me?.id)?.role;
  const canManage = isAdmin || myRole === 'owner';

  const { data: orgMembers } = useQuery({
    queryKey: ['org-members'],
    queryFn: api.orgMembers,
    enabled: isAdmin,
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['members', workspaceId] });
    void qc.invalidateQueries({ queryKey: ['org-members'] });
  };
  const add = useMutation({
    mutationFn: () => api.addMember(workspaceId!, { email: email.trim(), role }),
    onSuccess: (r) => {
      if ('error' in r && r.error) {
        setErr(r.error);
        return;
      }
      setErr(null);
      setEmail('');
      refresh();
    },
    onError: (e) => setErr((e as Error).message),
  });
  const remove = useMutation({ mutationFn: (userId: string) => api.removeMember(workspaceId!, userId), onSuccess: refresh });
  const changeRole = useMutation({
    mutationFn: (p: { email: string; role: (typeof WS_ROLES)[number] }) => api.addMember(workspaceId!, p),
    onSuccess: refresh,
  });
  const changeOrgRole = useMutation({
    mutationFn: (p: { userId: string; role: 'admin' | 'member' }) => api.setOrgRole(p.userId, p.role),
    onSuccess: refresh,
    onError: (e) => setErr((e as Error).message),
  });

  return (
    <div className="h-full overflow-y-auto" data-testid="members-page">
      <div className="max-w-[880px] mx-auto px-8 py-10">
        <h1 className="text-[24px] font-bold mb-1">{t('members.title')}</h1>
        <p className="text-ink-soft text-[14px] mb-7">{t('members.subtitle')}</p>

        {err && <div className="mb-4 text-[12.5px] text-danger bg-danger-soft rounded-lg px-3 py-2">{err}</div>}

        <section className="mb-10">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[15px] font-semibold flex items-center gap-2">
              <IconExpert className="w-4 h-4 text-primary" />
              {t('members.workspace')}
              <span className="text-ink-faint font-normal">({members?.length ?? 0})</span>
            </h2>
          </div>

          {canManage && (
            <form
              className="flex flex-wrap gap-2 mb-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (email.trim()) add.mutate();
              }}
            >
              <input
                data-testid="member-email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t('members.emailPlaceholder')}
                className="flex-1 min-w-[220px] px-3 h-9 rounded-lg border border-line outline-none text-[13px] bg-surface"
              />
              <select
                data-testid="member-role"
                value={role}
                onChange={(e) => setRole(e.target.value as (typeof WS_ROLES)[number])}
                className="px-2 h-9 rounded-lg border border-line text-[13px] bg-surface"
              >
                {WS_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {t(`members.role.${r}` as const)}
                  </option>
                ))}
              </select>
              <button
                data-testid="member-add"
                type="submit"
                disabled={add.isPending || !email.trim()}
                className="h-9 px-3.5 rounded-lg bg-primary hover:bg-primary-hover disabled:opacity-50 text-white text-[13px] font-medium flex items-center gap-1.5"
              >
                <IconPlus className="w-3.5 h-3.5" />
                {t('members.add')}
              </button>
            </form>
          )}

          <div className="rounded-xl border border-line bg-surface overflow-hidden">
            {(members ?? []).map((m) => (
              <MemberLine
                key={m.userId}
                m={m}
                self={m.userId === me?.id}
                canManage={canManage}
                onRole={(r) => changeRole.mutate({ email: m.email, role: r })}
                onRemove={() => remove.mutate(m.userId)}
              />
            ))}
            {!members?.length && <div className="px-4 py-6 text-[13px] text-ink-faint">{t('members.empty')}</div>}
          </div>
          {!canManage && <p className="text-[12px] text-ink-faint mt-2">{t('members.readonlyHint')}</p>}
        </section>

        {isAdmin && (
          <section>
            <h2 className="text-[15px] font-semibold mb-3">
              {t('members.org')} <span className="text-ink-faint font-normal">({orgMembers?.length ?? 0})</span>
            </h2>
            <div className="rounded-xl border border-line bg-surface overflow-hidden" data-testid="org-members">
              {(orgMembers ?? []).map((u) => (
                <div key={u.userId} className="flex items-center gap-3 px-4 py-2.5 border-b border-line last:border-b-0 text-[13.5px]">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{u.name || u.email}</div>
                    <div className="text-[12px] text-ink-faint truncate">{u.email}</div>
                  </div>
                  <select
                    value={u.role}
                    disabled={u.userId === me?.id}
                    onChange={(e) => changeOrgRole.mutate({ userId: u.userId, role: e.target.value as 'admin' | 'member' })}
                    className="px-2 h-8 rounded-lg border border-line text-[12.5px] bg-surface disabled:opacity-60"
                    title={u.userId === me?.id ? t('members.selfHint') : undefined}
                  >
                    <option value="admin">{t('members.role.admin')}</option>
                    <option value="member">{t('members.role.member')}</option>
                  </select>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function MemberLine({
  m,
  self,
  canManage,
  onRole,
  onRemove,
}: {
  m: MemberRow;
  self: boolean;
  canManage: boolean;
  onRole: (r: (typeof WS_ROLES)[number]) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-3 px-4 py-2.5 border-b border-line last:border-b-0 text-[13.5px]" data-testid="member-row">
      <div className="w-8 h-8 rounded-full bg-primary-soft text-primary flex items-center justify-center text-[12px] font-semibold shrink-0">
        {(m.name || m.email).slice(0, 1).toUpperCase()}
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate">
          {m.name || m.email}
          {self && <span className="ml-2 text-[11px] text-ink-faint">{t('members.you')}</span>}
        </div>
        <div className="text-[12px] text-ink-faint truncate">{m.email}</div>
      </div>
      {canManage ? (
        <select
          value={m.role}
          onChange={(e) => onRole(e.target.value as (typeof WS_ROLES)[number])}
          className="px-2 h-8 rounded-lg border border-line text-[12.5px] bg-surface"
        >
          {WS_ROLES.map((r) => (
            <option key={r} value={r}>
              {t(`members.role.${r}` as const)}
            </option>
          ))}
        </select>
      ) : (
        <span className="text-[12.5px] text-ink-soft">{t(`members.role.${m.role as (typeof WS_ROLES)[number]}` as const)}</span>
      )}
      {canManage && !self && (
        <button
          onClick={onRemove}
          data-testid="member-remove"
          className="text-[12.5px] text-ink-soft hover:text-danger px-2 h-8 rounded-lg hover:bg-danger-soft"
        >
          {t('members.remove')}
        </button>
      )}
    </div>
  );
}
