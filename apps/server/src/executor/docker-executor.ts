import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Docker from 'dockerode';
import { RuntimeEnvelope, ControlEnvelope, type TaskEvent } from '@apolla/protocol';
import type { ControlSource } from '@apolla/runtime';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Executor, ExecRequest, ExecResult } from './executor.js';
import type { AppConfig } from '../config.js';

/**
 * Docker 执行器（PRD §4.5，生产）：每任务一沙箱容器。
 * 容器内跑 runtime 的 headless 入口，经 WS 回连 server 上报事件、接收控制信号。
 *
 * 说明：本实现给出容器编排与 WS 桥接骨架。要真正启用需先构建 apolla-sandbox 镜像
 * （infra/sandbox）并把 runtime 打包进去（见 infra/sandbox/README）。开发默认用
 * LocalExecutor，故此路径在无镜像时会给出明确错误而非静默失败。
 */
export class DockerExecutor implements Executor {
  private docker = new Docker();
  constructor(private config: AppConfig) {}

  async run(
    req: ExecRequest,
    onEvent: (e: TaskEvent) => void,
    control: ControlSource,
  ): Promise<ExecResult> {
    const token = randomUUID();
    const bridgePort = 0; // 0 = 随机端口
    const wss = new WebSocketServer({ port: bridgePort });
    const actualPort = (wss.address() as { port: number }).port;

    let resolveResult: (r: ExecResult) => void;
    let rejectResult: (e: Error) => void;
    const resultPromise = new Promise<ExecResult>((res, rej) => {
      resolveResult = res;
      rejectResult = rej;
    });
    let lastUsage = { inTokens: 0, outTokens: 0, model: req.model.name };
    let summary = '';

    wss.on('connection', (ws: WebSocket) => {
      ws.on('message', (raw) => {
        const parsed = RuntimeEnvelope.safeParse(JSON.parse(raw.toString()));
        if (!parsed.success) return;
        const msg = parsed.data;
        if (msg.kind === 'hello') {
          if (msg.token !== token) {
            ws.close();
            return;
          }
          this.wireControl(ws, control);
          ws.send(JSON.stringify({ kind: 'hello.ok' } satisfies ControlEnvelope));
        } else if (msg.kind === 'event') {
          onEvent(msg.event);
          if (msg.event.type === 'usage.updated') lastUsage = msg.event.usage;
          if (msg.event.type === 'task.completed') summary = msg.event.summary;
        } else if (msg.kind === 'bye') {
          ws.close();
        }
      });
    });

    let container: Docker.Container | undefined;
    try {
      container = await this.docker.createContainer({
        Image: this.config.sandboxImage,
        Cmd: ['node', '/opt/apolla/runtime/dist/sandbox-main.js'],
        Env: [
          `APOLLA_TASK_ID=${req.taskId}`,
          `APOLLA_TOKEN=${token}`,
          `APOLLA_BRIDGE=ws://host.docker.internal:${actualPort}`,
          `APOLLA_PROMPT_B64=${Buffer.from(req.prompt).toString('base64')}`,
          `APOLLA_MODE=${req.mode}`,
          `MODEL_DEFAULT=${req.model.name}`,
          `MODEL_BASE_URL=${req.model.baseUrl ?? ''}`,
          `MODEL_API_KEY=${req.model.apiKey ?? ''}`,
        ],
        HostConfig: {
          Binds: [`${path.resolve(req.workspaceDir)}:/workspace`],
          NetworkMode: 'bridge',
          Memory: 4 * 1024 * 1024 * 1024,
          NanoCpus: 2_000_000_000,
          ReadonlyRootfs: false,
          AutoRemove: true,
        },
        WorkingDir: '/workspace',
      });
      await container.start();
      const stream = await container.wait();
      // 容器退出后给 WS 收尾时间
      await new Promise((r) => setTimeout(r, 200));
      resolveResult!({ status: summary ? 'completed' : 'failed', summary, usage: lastUsage });
      void stream;
    } catch (e) {
      rejectResult!(
        new Error(
          `Docker 执行失败（镜像 ${this.config.sandboxImage} 是否已构建？）：${(e as Error).message}`,
        ),
      );
    } finally {
      setTimeout(() => wss.close(), 1000);
    }
    return resultPromise;
  }

  private wireControl(ws: WebSocket, control: ControlSource) {
    // server → 容器：目前控制信号由 runtime 侧发起请求、server 回应，
    // 这里预留把 ControlSource 的解析结果下行的通道（审批/回答/取消/输入）。
    const poll = setInterval(() => {
      if (control.isCancelled()) {
        ws.send(JSON.stringify({ kind: 'cancel' } satisfies ControlEnvelope));
        clearInterval(poll);
      }
    }, 300);
    ws.on('close', () => clearInterval(poll));
  }
}
