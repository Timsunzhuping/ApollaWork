import type { ChannelAdapter, InboundMessage } from './channel.js';

/** GET /tasks/:id 响应的最小视图（只取桥接需要的字段） */
interface TaskView {
  id: string;
  status: string; // queued | running | awaiting_approval | completed | failed | cancelled
  summary?: string | null;
  artifacts?: { path: string; title: string }[];
}

/** 任务的终态（与 server tasks.controller 一致） */
const TERMINAL_STATUS = new Set(['completed', 'failed', 'cancelled']);

export interface BridgeConfig {
  /** Apolla REST 根地址，如 http://localhost:3001/api/v1 */
  apiBase: string;
  /** 集成用 API Key（T-419）：x-api-key 头。不配则只能在 AUTH_MODE=dev 下工作 */
  apiKey?: string;
  /** 拼产物下载链接用的对外地址（不含 /api/v1），如 https://apolla.example.com */
  publicUrl: string;
  /** 默认工作区 ID；不配则取 GET /workspaces 的第一个 */
  workspaceId?: string;
  /** 建任务的权限模式，默认 auto（IM 场景无人守着审批，auto 最合适） */
  taskMode?: string;
  /** 轮询间隔，默认 3s */
  pollIntervalMs?: number;
  /** 轮询总时长上限，默认 10 分钟 */
  pollTimeoutMs?: number;
}

/** 一个进行中任务与其来源 IM 消息的关联（仅内存，重启即失；持久化留给 M2） */
interface PendingTask {
  taskId: string;
  channel: string;
  chatId: string;
  userId: string;
  startedAt: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 核心桥接：IM 消息 → Apolla session+task → 轮询任务状态 → 结果回推到 IM。
 * 每条消息独立建 session（IM 场景一问一答，不做多轮上下文；多轮留给 M2）。
 */
export class Bridge {
  private adapters = new Map<string, ChannelAdapter>();
  /** taskId → 来源 IM 消息（内存关联表） */
  private pending = new Map<string, PendingTask>();
  private cachedWorkspaceId?: string;

  constructor(private config: BridgeConfig) {}

  /** 进行中任务数（测试/观测用） */
  get pendingCount(): number {
    return this.pending.size;
  }

  register(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.name, adapter);
  }

  /** 启动所有已注册通道。onMessage 返回完整处理 Promise，适配器自行决定是否等待。 */
  async start(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      await adapter.start((msg) => this.handleMessage(msg));
      console.log(`[bridge] 通道已启动：${adapter.name}`);
    }
  }

  async stop(): Promise<void> {
    for (const adapter of this.adapters.values()) await adapter.stop();
  }

  /** 主流程：建 session+task → 轮询到终态 → 回推。任何一步失败都回推 ❌。 */
  async handleMessage(msg: InboundMessage): Promise<void> {
    const adapter = this.adapters.get(msg.channel);
    if (!adapter) {
      console.warn(`[bridge] 收到未注册通道 ${msg.channel} 的消息，忽略`);
      return;
    }
    let taskId: string | undefined;
    try {
      const wsId = await this.resolveWorkspace();
      const session = await this.api<{ id: string }>('POST', `/workspaces/${wsId}/sessions`, {
        title: `IM(${msg.channel})：${msg.text.slice(0, 40)}`,
      });
      const task = await this.api<{ id: string; status: string }>(
        'POST',
        `/sessions/${session.id}/tasks`,
        { prompt: msg.text, mode: this.config.taskMode ?? 'auto' },
      );
      taskId = task.id;
      this.pending.set(taskId, {
        taskId,
        channel: msg.channel,
        chatId: msg.chatId,
        userId: msg.userId,
        startedAt: Date.now(),
      });
      console.log(`[bridge] ${msg.channel}/${msg.chatId}/${msg.userId} → 任务 ${taskId} 已创建`);

      const done = await this.pollTask(taskId);
      await adapter.sendText(msg.chatId, this.renderResult(done, wsId));
      console.log(
        `[bridge] 任务 ${taskId} ${done.status}，结果已回推 ${msg.channel}/${msg.chatId}`,
      );
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.error(`[bridge] 处理 ${msg.channel}/${msg.chatId} 的消息失败：${reason}`);
      await adapter
        .sendText(msg.chatId, `❌ 任务失败：${reason}`)
        .catch((err) => console.error('[bridge] 回推失败消息也失败了：', err));
    } finally {
      if (taskId) this.pending.delete(taskId);
    }
  }

  /** 每 pollIntervalMs 查一次任务状态，直到终态或超时（超时抛错，由上层回推 ❌） */
  private async pollTask(taskId: string): Promise<TaskView> {
    const interval = this.config.pollIntervalMs ?? 3_000;
    const timeout = this.config.pollTimeoutMs ?? 600_000;
    const deadline = Date.now() + timeout;
    for (;;) {
      const task = await this.api<TaskView>('GET', `/tasks/${taskId}`);
      if (TERMINAL_STATUS.has(task.status)) return task;
      if (Date.now() >= deadline) {
        throw new Error(
          `任务 ${taskId} 超过 ${Math.round(timeout / 60_000)} 分钟未完成（轮询超时）`,
        );
      }
      await sleep(interval);
    }
  }

  /** 终态任务 → IM 文本：✅ 摘要（前 300 字）+ 产物清单；失败/取消 → ❌ 与原因 */
  private renderResult(task: TaskView, workspaceId: string): string {
    if (task.status === 'completed') {
      const summary = (task.summary ?? '（无摘要）').slice(0, 300);
      const lines = [`✅ 任务完成：${summary}`];
      for (const a of task.artifacts ?? []) {
        lines.push(`- ${a.title}: ${this.fileUrl(workspaceId, a.path)}`);
      }
      return lines.join('\n');
    }
    const verb = task.status === 'cancelled' ? '已取消' : '失败';
    return `❌ 任务${verb}：${task.summary || '（无失败原因）'}`;
  }

  /** 产物下载链接：{APOLLA_PUBLIC_URL}/api/v1/workspaces/{ws}/file?path=... */
  private fileUrl(workspaceId: string, relPath: string): string {
    return `${this.config.publicUrl}/api/v1/workspaces/${workspaceId}/file?path=${encodeURIComponent(relPath)}`;
  }

  /** 默认工作区：配置优先，否则取列表第一个（缓存，避免每条消息都查） */
  private async resolveWorkspace(): Promise<string> {
    if (this.config.workspaceId) return this.config.workspaceId;
    if (this.cachedWorkspaceId) return this.cachedWorkspaceId;
    const list = await this.api<{ id: string; name: string }[]>('GET', '/workspaces');
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error('Apolla 中没有可用工作区，请先创建一个');
    }
    this.cachedWorkspaceId = list[0].id;
    console.log(`[bridge] 未配置默认工作区，使用第一个：${list[0].name}（${list[0].id}）`);
    return this.cachedWorkspaceId;
  }

  /** 极简 REST 封装：非 2xx 或 body 带 {error} 都抛错 */
  private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.config.apiBase}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(this.config.apiKey ? { 'x-api-key': this.config.apiKey } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`Apolla API ${method} ${path} 失败：HTTP ${res.status}`);
    const data = (await res.json()) as T;
    // server 的部分错误以 200 + {error} 返回（如 session not found）
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const err = (data as { error?: string }).error;
      if (err) throw new Error(`Apolla API ${method} ${path} 出错：${err}`);
    }
    return data;
  }
}
