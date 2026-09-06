import type {
  CreateTaskDto,
  PermissionMode,
  ModelTier,
  TaskEvent,
} from '@apolla/protocol';

import { getToken, clearToken, ensureFreshToken, refreshToken } from './auth/oidc';
import { t } from './i18n';

const BASE = '/api/v1';

/** 统一带上 Bearer 令牌（dev 模式下没有令牌也能通过）。 */
export function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const t = getToken();
  return t ? { ...extra, authorization: `Bearer ${t}` } : extra;
}

async function req<T>(path: string, init?: RequestInit, retried = false): Promise<T> {
  await ensureFreshToken(); // 快过期就先静默续期（T-408）
  // 只有带 body 才声明 JSON：Fastify 对「声明了 application/json 却没有 body」的请求直接 400，
  // 此前所有 DELETE（成员/连接器/模型/策略/自动化）都因此静默失败
  const base: Record<string, string> = init?.body ? { 'content-type': 'application/json' } : {};
  const res = await fetch(BASE + path, {
    ...init,
    headers: authHeaders({ ...base, ...((init?.headers as Record<string, string>) ?? {}) }),
  });
  if (res.status === 401) {
    // 令牌刚过期：用 refresh 换新后重试一次；refresh 也失效才算真的未登录
    if (!retried && (await refreshToken())) return req<T>(path, init, true);
    clearToken();
    window.dispatchEvent(new CustomEvent('apolla:unauthorized'));
    throw new Error(t('error.unauthorized'));
  }
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

export interface Me {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'member';
  orgId: string;
}
export interface MemberRow {
  userId: string;
  role: string;
  email: string;
  name: string;
}
export interface OrgMemberRow {
  userId: string;
  role: 'admin' | 'member';
  email: string;
  name: string;
}
export interface PolicyView {
  id: string | null;
  builtinKey: string | null;
  builtin: boolean;
  workspaceId: string | null;
  kind: string;
  pattern: string;
  flags: string;
  reason: string;
  enabled: boolean;
}
export interface Workspace {
  id: string;
  name: string;
  description?: string;
  defaultMode: string;
}
export interface SessionRow {
  id: string;
  title?: string;
  createdAt: string;
  tasks: { id: string; prompt: string; status: string; createdAt: string }[];
}
export interface Artifact {
  id: string;
  path: string;
  title: string;
  mime?: string;
  kind: string;
}
export interface Approval {
  id: string;
  kind: string;
  title: string;
  detail: string;
  status: string;
}
export interface TaskDetail {
  id: string;
  sessionId: string;
  status: string;
  mode: string;
  prompt: string;
  summary?: string;
  usage?: { inTokens: number; outTokens: number; model: string } | null;
  artifacts: Artifact[];
  approvals: Approval[];
  running: boolean;
}
export interface SkillRow {
  name: string;
  description: string;
  scope: string;
  enabled: boolean;
}
export interface FileRow {
  path: string;
  size: number;
  mime: string;
}

export const api = {
  me: () => req<Me>('/me'),
  workspaces: () => req<Workspace[]>('/workspaces'),
  createWorkspace: (body: { name: string; description?: string }) =>
    req<Workspace>('/workspaces', { method: 'POST', body: JSON.stringify(body) }),
  // 成员与角色（T-410）
  members: (wsId: string) => req<MemberRow[]>(`/workspaces/${wsId}/members`),
  addMember: (wsId: string, body: { email: string; role: 'owner' | 'editor' | 'viewer' }) =>
    req<{ ok?: boolean; error?: string }>(`/workspaces/${wsId}/members`, { method: 'POST', body: JSON.stringify(body) }),
  removeMember: (wsId: string, userId: string) =>
    req<{ ok: boolean }>(`/workspaces/${wsId}/members/${userId}`, { method: 'DELETE' }),
  orgMembers: () => req<OrgMemberRow[]>('/admin/members'),
  // 集成 API Key（T-419）
  apiKeys: () =>
    req<{ id: string; name: string; prefix: string; scopes: string[]; createdAt: string; expiresAt: string | null; lastUsedAt: string | null; revokedAt: string | null }[]>('/admin/api-keys'),
  issueApiKey: (body: { name: string; scopes: string[]; expiresInDays?: number }) =>
    req<{ id: string; plaintext: string }>('/admin/api-keys', { method: 'POST', body: JSON.stringify(body) }),
  revokeApiKey: (id: string) => req<{ ok: boolean }>(`/admin/api-keys/${id}`, { method: 'DELETE' }),
  // 任务反馈（T-420）
  rateTask: (id: string, rating: number, note?: string) =>
    req<{ ok: boolean }>(`/tasks/${id}/feedback`, { method: 'POST', body: JSON.stringify({ rating, note }) }),
  failuresExportUrl: () => {
    const tok = getToken();
    return `${BASE}/admin/failures/export${tok ? `?access_token=${encodeURIComponent(tok)}` : ''}`;
  },
  // 策略中心（T-413）
  policies: () => req<PolicyView[]>('/admin/policies'),
  setBuiltinPolicy: (key: string, enabled: boolean) =>
    req<unknown>(`/admin/policies/builtin/${encodeURIComponent(key)}`, { method: 'POST', body: JSON.stringify({ enabled }) }),
  createPolicy: (body: { kind: string; pattern: string; flags?: string; reason: string; workspaceId?: string | null }) =>
    req<unknown>('/admin/policies', { method: 'POST', body: JSON.stringify(body) }),
  updatePolicy: (id: string, patch: { enabled?: boolean; pattern?: string; flags?: string; reason?: string }) =>
    req<unknown>(`/admin/policies/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deletePolicy: (id: string) => req<unknown>(`/admin/policies/${id}`, { method: 'DELETE' }),
  auditExportUrl: (format: 'csv' | 'jsonl') => {
    const tok = getToken();
    return `${BASE}/admin/audit/export?format=${format}${tok ? `&access_token=${encodeURIComponent(tok)}` : ''}`;
  },
  setOrgRole: (userId: string, role: 'admin' | 'member') =>
    req<{ ok: boolean }>(`/admin/members/${userId}/role`, { method: 'POST', body: JSON.stringify({ role }) }),
  sessions: (wsId: string) => req<SessionRow[]>(`/workspaces/${wsId}/sessions`),
  createSession: (wsId: string, title?: string) =>
    req<{ id: string }>(`/workspaces/${wsId}/sessions`, {
      method: 'POST',
      body: JSON.stringify({ title }),
    }),
  createTask: (sessionId: string, body: Partial<CreateTaskDto> & { prompt: string }) =>
    req<{ id: string; status: string }>(`/sessions/${sessionId}/tasks`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  task: (id: string) => req<TaskDetail>(`/tasks/${id}`),
  cancelTask: (id: string) => req<{ ok: boolean }>(`/tasks/${id}/cancel`, { method: 'POST' }),
  sendInput: (id: string, text: string) =>
    req<{ ok: boolean }>(`/tasks/${id}/input`, { method: 'POST', body: JSON.stringify({ text }) }),
  resolveApproval: (id: string, decision: 'approved' | 'denied', scope: 'once' | 'task' = 'once') =>
    req<{ ok: boolean }>(`/approvals/${id}`, {
      method: 'POST',
      body: JSON.stringify({ decision, scope }),
    }),
  answerQuestion: (taskId: string, qid: string, answer: string) =>
    req<{ ok: boolean }>(`/tasks/${taskId}/questions/${qid}`, {
      method: 'POST',
      body: JSON.stringify({ answer }),
    }),
  skills: () => req<SkillRow[]>('/skills'),
  marketplace: () => req<{ name: string; description: string; version: string; installed: boolean }[]>('/marketplace'),
  installSkill: (name: string) => req<{ ok: boolean }>('/marketplace/install', { method: 'POST', body: JSON.stringify({ name }) }),
  uninstallSkill: (name: string) => req<{ ok: boolean }>('/marketplace/uninstall', { method: 'POST', body: JSON.stringify({ name }) }),
  files: (wsId: string) => req<FileRow[]>(`/workspaces/${wsId}/files`),
  fileUrl: (wsId: string, path: string, inline = false) => {
    // <a href> / <img src> 无法带请求头，令牌走查询参数
    const t = getToken();
    return (
      `${BASE}/workspaces/${wsId}/file?path=${encodeURIComponent(path)}` +
      (inline ? '&inline=1' : '') +
      (t ? `&access_token=${encodeURIComponent(t)}` : '')
    );
  },
  uploadFiles: async (wsId: string, files: FileList) => {
    const form = new FormData();
    for (const f of Array.from(files)) form.append('file', f, f.name);
    const res = await fetch(`${BASE}/workspaces/${wsId}/files`, {
      method: 'POST',
      body: form,
      headers: authHeaders(),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },
  adminUsage: (days = 7) => req<any>(`/admin/usage?days=${days}`),
  adminAudit: () => req<any[]>(`/admin/audit`),
  // 模型接入（走统一 req，自动带 Bearer 令牌；此前用裸 fetch 在 OIDC 模式下会 401）
  adminModels: () => req<any[]>('/admin/models'),
  upsertModel: (body: {
    id?: string;
    name: string;
    baseUrl: string;
    apiKey?: string;
    model: string;
    tier: string;
  }) => req<any>('/admin/models', { method: 'POST', body: JSON.stringify(body) }),
  testModel: (id: string) =>
    req<{ ok: boolean; reply?: string; error?: string }>(`/admin/models/${id}/test`, {
      method: 'POST',
    }),
  deleteModel: (id: string) => req<{ ok: boolean }>(`/admin/models/${id}`, { method: 'DELETE' }),

  // 资料库
  kbDocs: (wsId: string) => req<{ name: string; pages: number; chunks: number }[]>(`/workspaces/${wsId}/kb/docs`),
  kbIngest: (wsId: string, path: string) =>
    req<{ ok: boolean; doc?: string; chunks?: number }>(`/workspaces/${wsId}/kb/ingest`, {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
  kbSearch: (wsId: string, query: string) =>
    req<{ doc: string; page: number | null; text: string; score: number }[]>(
      `/workspaces/${wsId}/kb/search`,
      { method: 'POST', body: JSON.stringify({ query }) },
    ),

  // 连接器
  connectors: () => req<any[]>('/connectors'),
  upsertConnector: (body: any) =>
    req<any>('/connectors', { method: 'POST', body: JSON.stringify(body) }),
  testConnector: (id: string) => req<{ ok: boolean; tools?: string[]; error?: string }>(`/connectors/${id}/test`, { method: 'POST' }),
  deleteConnector: (id: string) => req<{ ok: boolean }>(`/connectors/${id}`, { method: 'DELETE' }),

  // 自动化
  automations: (wsId: string) =>
    req<any[]>(`/workspaces/${wsId}/automations`),
  createAutomation: (wsId: string, body: { name: string; cron: string; prompt: string; tz?: string }) =>
    req<any>(`/workspaces/${wsId}/automations`, { method: 'POST', body: JSON.stringify(body) }),
  runAutomation: (id: string) => req<{ ok: boolean; taskId?: string }>(`/automations/${id}/run`, { method: 'POST' }),
  deleteAutomation: (id: string) => req<{ ok: boolean }>(`/automations/${id}`, { method: 'DELETE' }),
};

export type { PermissionMode, ModelTier, TaskEvent };

/** 订阅任务事件流（SSE），支持断点重放。返回取消函数。 */
export function streamTask(
  taskId: string,
  onEvent: (e: TaskEvent, seq: number) => void,
  onDone: () => void,
): () => void {
  // EventSource 不支持自定义请求头，令牌走查询参数（服务端同样校验）。
  // 不用 EventSource 自带的重连：它会拿着过期令牌无限重试 401。
  // 这里断线后自己关掉，换新令牌并带上 lastEventId 续传（指数退避，T-408）。
  let es: EventSource | undefined;
  let lastId = 0;
  let closed = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const seen = new Set<number>(); // 重连回放会重发一段，按 seq 去重

  const connect = async () => {
    if (closed) return;
    const tok = (await ensureFreshToken()) ?? getToken();
    const q = new URLSearchParams();
    if (tok) q.set('access_token', tok);
    if (lastId) q.set('lastEventId', String(lastId));
    es = new EventSource(`${BASE}/tasks/${taskId}/events${q.size ? `?${q}` : ''}`);
    es.onopen = () => {
      attempt = 0;
    };
    es.onmessage = (msg) => {
      const seq = Number(msg.lastEventId) || 0;
      if (seq) {
        if (seen.has(seq)) return;
        seen.add(seq);
        if (seq > lastId) lastId = seq;
      }
      if (!msg.data || msg.data === '{}') return;
      try {
        onEvent(JSON.parse(msg.data) as TaskEvent, seq || lastId);
      } catch {
        /* ignore */
      }
    };
    es.addEventListener('done', () => {
      closed = true;
      es?.close();
      onDone();
    });
    es.onerror = () => {
      es?.close();
      if (closed) return;
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt++, 5));
      timer = setTimeout(() => void connect(), delay);
    };
  };
  void connect();
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    es?.close();
  };
}
