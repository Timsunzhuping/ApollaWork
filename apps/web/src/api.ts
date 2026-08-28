import type {
  CreateTaskDto,
  PermissionMode,
  ModelTier,
  TaskEvent,
} from '@apolla/protocol';

import { getToken, clearToken } from './auth/oidc';
import { t } from './i18n';

const BASE = '/api/v1';

/** 统一带上 Bearer 令牌（dev 模式下没有令牌也能通过）。 */
export function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const t = getToken();
  return t ? { ...extra, authorization: `Bearer ${t}` } : extra;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: authHeaders({ 'content-type': 'application/json', ...((init?.headers as Record<string, string>) ?? {}) }),
  });
  if (res.status === 401) {
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
  // EventSource 不支持自定义请求头，令牌走查询参数（服务端同样校验）
  const t = getToken();
  const url = `${BASE}/tasks/${taskId}/events${t ? `?access_token=${encodeURIComponent(t)}` : ''}`;
  const es = new EventSource(url);
  es.onmessage = (msg) => {
    if (!msg.data || msg.data === '{}') return;
    try {
      const event = JSON.parse(msg.data) as TaskEvent;
      onEvent(event, Number(msg.lastEventId || 0));
    } catch {
      /* ignore */
    }
  };
  es.addEventListener('done', () => {
    es.close();
    onDone();
  });
  es.onerror = () => {
    // EventSource 会自动重连；连接彻底关闭时触发 done 兜底
  };
  return () => es.close();
}
