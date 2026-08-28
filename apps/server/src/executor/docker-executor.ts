import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Docker from 'dockerode';
import { RuntimeEnvelope, type ControlEnvelope, type TaskEvent } from '@apolla/protocol';
import type { ControlSource } from '@apolla/runtime';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Executor, ExecRequest, ExecResult } from './executor.js';
import type { AppConfig } from '../config.js';

/**
 * Docker 执行器（PRD §4.5，生产）：每任务一沙箱容器。
 * 容器内跑 runtime 的 headless 入口，经 WS 回连 server 上报事件、接收控制信号。
 *
 * 控制信号桥接（生产 P0 修复）：
 *   容器里的 Agent 请求审批 → 事件上报 server → 用户在 UI 批准 →
 *   server 侧 TaskControl 的 promise 兑现 → **必须把结果下发回容器**，
 *   否则容器内的 Agent 会一直等待，任务永久挂起。
 *   之前只转发了「取消」，审批/提问/追加指令都没下发 —— 即 ask 模式在生产不可用。
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
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((r) => wss.once('listening', () => r()));
    const bridgePort = (wss.address() as { port: number }).port;

    let lastUsage = { inTokens: 0, outTokens: 0, model: req.model.name };
    let summary = '';
    let finalStatus = 'failed';
    let socket: WebSocket | undefined;

    const send = (msg: ControlEnvelope) => {
      if (socket?.readyState === 1) socket.send(JSON.stringify(msg));
    };

    wss.on('connection', (ws: WebSocket) => {
      ws.on('message', (raw) => {
        let parsed;
        try {
          parsed = RuntimeEnvelope.safeParse(JSON.parse(raw.toString()));
        } catch {
          return;
        }
        if (!parsed.success) return;
        const msg = parsed.data;

        if (msg.kind === 'hello') {
          if (msg.token !== token) {
            ws.close(1008, 'bad token');
            return;
          }
          socket = ws;
          send({ kind: 'hello.ok' });
          this.pumpCancel(ws, control, send);
          return;
        }

        if (msg.kind === 'event') {
          onEvent(msg.event);
          const e = msg.event;
          if (e.type === 'usage.updated') lastUsage = e.usage;
          if (e.type === 'task.completed') {
            summary = e.summary;
            finalStatus = 'completed';
          }
          if (e.type === 'task.failed') {
            summary = e.error.message;
            finalStatus = 'failed';
          }
          if (e.type === 'task.cancelled') finalStatus = 'cancelled';

          // ★ 关键：容器请求审批/提问时，在 server 侧等待用户决定并把结果下发回容器
          if (e.type === 'approval.requested') {
            void control
              .waitApproval(e.approvalId)
              .then((approved) =>
                send({
                  kind: 'approval.resolved',
                  approvalId: e.approvalId,
                  decision: approved ? 'approved' : 'denied',
                  scope: 'once',
                }),
              )
              .catch(() =>
                send({
                  kind: 'approval.resolved',
                  approvalId: e.approvalId,
                  decision: 'denied',
                  scope: 'once',
                }),
              );
          }
          if (e.type === 'question.asked') {
            void control
              .waitAnswer(e.questionId)
              .then((answer) => send({ kind: 'question.answered', questionId: e.questionId, answer }))
              .catch(() =>
                send({ kind: 'question.answered', questionId: e.questionId, answer: '（无回答）' }),
              );
          }
          return;
        }

        if (msg.kind === 'bye') ws.close();
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
          `APOLLA_BRIDGE=ws://host.docker.internal:${bridgePort}`,
          `APOLLA_PROMPT_B64=${Buffer.from(req.prompt).toString('base64')}`,
          `APOLLA_MODE=${req.mode}`,
          `MODEL_DEFAULT=${req.model.name}`,
          `MODEL_BASE_URL=${req.model.baseUrl ?? ''}`,
          `MODEL_API_KEY=${req.model.apiKey ?? ''}`,
          `WEBFETCH_ALLOWLIST=${req.webfetchAllowlist.join(',')}`,
        ],
        HostConfig: {
          Binds: [`${path.resolve(req.workspaceDir)}:/workspace`],
          NetworkMode: 'bridge',
          Memory: 4 * 1024 * 1024 * 1024,
          NanoCpus: 2_000_000_000,
          PidsLimit: 512, // 防 fork bomb 耗尽宿主 PID
          AutoRemove: true,
          ExtraHosts: ['host.docker.internal:host-gateway'], // Linux 上解析桥地址
          SecurityOpt: ['no-new-privileges'],
        },
        WorkingDir: '/workspace',
        User: '1001:1001',
      });
      await container.start();

      // 用户取消时直接杀容器（避免等待 Agent 自行让出）
      const killPoll = setInterval(() => {
        if (control.isCancelled()) {
          container?.kill().catch(() => undefined);
          clearInterval(killPoll);
        }
      }, 500);

      const [exit] = await container.wait();
      clearInterval(killPoll);
      await new Promise((r) => setTimeout(r, 300)); // 给最后的 WS 消息留时间

      if (finalStatus === 'failed' && !summary) {
        summary = `沙箱容器退出（code=${(exit as { StatusCode?: number } | undefined)?.StatusCode ?? '?'}），未收到完成事件。`;
      }
      return { status: finalStatus, summary, usage: lastUsage };
    } catch (e) {
      throw new Error(
        `Docker 执行失败（镜像 ${this.config.sandboxImage} 是否已构建？）：${(e as Error).message}`,
      );
    } finally {
      wss.close();
    }
  }

  /** 取消信号下发（容器内 Agent 会在下一轮 loop 前让出）。 */
  private pumpCancel(ws: WebSocket, control: ControlSource, send: (m: ControlEnvelope) => void) {
    const poll = setInterval(() => {
      if (control.isCancelled()) {
        send({ kind: 'cancel' });
        clearInterval(poll);
      }
      // 追加指令下发（steering）
      for (const text of control.drainUserInputs()) send({ kind: 'user.input', text });
    }, 300);
    ws.on('close', () => clearInterval(poll));
  }
}
