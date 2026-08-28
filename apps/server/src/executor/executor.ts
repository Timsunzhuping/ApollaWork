import type { TaskEvent, PermissionMode, ModelTier } from '@apolla/protocol';
import type { ControlSource, McpServerConfig } from '@apolla/runtime';

export interface ExecRequest {
  taskId: string;
  sessionId: string;
  prompt: string;
  workspaceDir: string;
  mode: PermissionMode;
  modelTier: ModelTier;
  attachments: string[];
  model: { name: string; baseUrl?: string; apiKey?: string };
  skillRoots: string[];
  webfetchAllowlist: string[];
  searxngUrl?: string;
  mcpServers?: McpServerConfig[];
  maxDurationMs?: number;
  maxTokens?: number;
}

export interface ExecResult {
  status: string;
  summary: string;
  usage: { inTokens: number; outTokens: number; model: string };
}

/**
 * 执行器抽象（ExecutorPort）。
 * - LocalExecutor：进程内直接跑 runtime（开发默认，无需 Docker）。
 * - DockerExecutor：每任务一沙箱容器 + WS 回传（生产，见 docker-executor.ts）。
 */
export interface Executor {
  run(
    req: ExecRequest,
    onEvent: (e: TaskEvent) => void,
    control: ControlSource,
  ): Promise<ExecResult>;
}
