import type { TaskEvent } from '@apolla/protocol';
import type { ControlSource } from '@apolla/runtime';
import { runTask } from '@apolla/runtime';
import type { Executor, ExecRequest, ExecResult } from './executor.js';

/**
 * 本地执行器：进程内调用 runtime.runTask。
 * 开发/评测用，零容器依赖。生产用 DockerExecutor 做隔离。
 * 注意：工作区目录直接指向 storage 的真实目录，无需拉取/回传。
 */
export class LocalExecutor implements Executor {
  async run(
    req: ExecRequest,
    onEvent: (e: TaskEvent) => void,
    control: ControlSource,
  ): Promise<ExecResult> {
    return runTask(
      {
        taskId: req.taskId,
        sessionId: req.sessionId,
        prompt: req.prompt,
        workspaceDir: req.workspaceDir,
        mode: req.mode,
        modelTier: req.modelTier,
        attachments: req.attachments,
        modelConfig: { model: req.model.name, baseUrl: req.model.baseUrl, apiKey: req.model.apiKey },
        skillRoots: req.skillRoots,
        webfetchAllowlist: req.webfetchAllowlist,
        searxngUrl: req.searxngUrl,
      },
      { emit: onEvent },
      control,
    );
  }
}
