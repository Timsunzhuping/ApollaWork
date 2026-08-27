import type {
  CreateTaskDto,
  PermissionMode,
  ModelTier,
  TaskEvent,
} from '@apolla/protocol';

const BASE = '/api/v1';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
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
  fileUrl: (wsId: string, path: string, inline = false) =>
    `${BASE}/workspaces/${wsId}/file?path=${encodeURIComponent(path)}${inline ? '&inline=1' : ''}`,
  uploadFiles: async (wsId: string, files: FileList) => {
    const form = new FormData();
    for (const f of Array.from(files)) form.append('file', f, f.name);
    const res = await fetch(`${BASE}/workspaces/${wsId}/files`, { method: 'POST', body: form });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },
  adminUsage: (days = 7) => req<any>(`/admin/usage?days=${days}`),
  adminAudit: () => req<any[]>(`/admin/audit`),

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
  const es = new EventSource(`${BASE}/tasks/${taskId}/events`);
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
