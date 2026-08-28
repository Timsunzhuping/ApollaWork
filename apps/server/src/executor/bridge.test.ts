import { describe, expect, it } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import { RuntimeEnvelope, ControlEnvelope, type TaskEvent } from '@apolla/protocol';
import { TaskControl } from '../tasks/task-control.js';

/**
 * 沙箱控制信号桥接测试（生产 P0）。
 *
 * 不依赖 Docker：用一个 WS 服务端复刻 DockerExecutor 的桥接逻辑，
 * 用一个假"容器"客户端复刻 sandbox-main 的行为，验证：
 *   容器请求审批 → server 侧等待用户 → 用户批准 → **结果下发回容器**。
 * 修复前只下发 cancel，审批结果从不回传 → ask 模式在生产永久挂起。
 */
function bridge(control: TaskControl, onEvent: (e: TaskEvent) => void) {
  const wss = new WebSocketServer({ port: 0 });
  let socket: WebSocket | undefined;
  const send = (m: ControlEnvelope) => {
    if (socket?.readyState === 1) socket.send(JSON.stringify(m));
  };
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const parsed = RuntimeEnvelope.safeParse(JSON.parse(raw.toString()));
      if (!parsed.success) return;
      const msg = parsed.data;
      if (msg.kind === 'hello') {
        socket = ws;
        send({ kind: 'hello.ok' });
        return;
      }
      if (msg.kind === 'event') {
        onEvent(msg.event);
        const e = msg.event;
        // ★ 被测逻辑：把用户决定下发回容器
        if (e.type === 'approval.requested') {
          void control.waitApproval(e.approvalId).then((ok) =>
            send({
              kind: 'approval.resolved',
              approvalId: e.approvalId,
              decision: ok ? 'approved' : 'denied',
              scope: 'once',
            }),
          );
        }
        if (e.type === 'question.asked') {
          void control
            .waitAnswer(e.questionId)
            .then((answer) => send({ kind: 'question.answered', questionId: e.questionId, answer }));
        }
      }
    });
  });
  return { wss, port: () => (wss.address() as { port: number }).port, send };
}

/** 假容器：复刻 sandbox-main 的控制回路 */
function fakeContainer(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const pendingApprovals = new Map<string, (ok: boolean) => void>();
  const pendingAnswers = new Map<string, (a: string) => void>();
  ws.on('message', (raw) => {
    const parsed = ControlEnvelope.safeParse(JSON.parse(raw.toString()));
    if (!parsed.success) return;
    const m = parsed.data;
    if (m.kind === 'approval.resolved') {
      pendingApprovals.get(m.approvalId)?.(m.decision === 'approved');
      pendingApprovals.delete(m.approvalId);
    }
    if (m.kind === 'question.answered') {
      pendingAnswers.get(m.questionId)?.(m.answer);
      pendingAnswers.delete(m.questionId);
    }
  });
  const ready = new Promise<void>((r) => ws.on('open', () => r()));
  return {
    ws,
    ready,
    hello: () => ws.send(JSON.stringify({ kind: 'hello', taskId: 't1', token: 'tok' })),
    emit: (event: TaskEvent) => ws.send(JSON.stringify({ kind: 'event', event })),
    waitApproval: (id: string) =>
      new Promise<boolean>((res) => pendingApprovals.set(id, res)),
    waitAnswer: (id: string) => new Promise<string>((res) => pendingAnswers.set(id, res)),
  };
}

describe('沙箱控制信号桥接（P0：修复前 ask 模式生产永久挂起）', () => {
  it('★ 审批结果下发回容器：用户批准 → 容器内 Agent 继续执行', async () => {
    const control = new TaskControl();
    const events: TaskEvent[] = [];
    const b = bridge(control, (e) => events.push(e));
    const c = fakeContainer(b.port());
    await c.ready;
    c.hello();

    // 容器内 Agent 请求审批并等待
    const agentWaiting = c.waitApproval('appr-1');
    c.emit({ v: 1, type: 'approval.requested', approvalId: 'appr-1', kind: 'bash_command', title: '删除文件', detail: 'rm x' });

    // 等事件到达 server 侧
    await new Promise((r) => setTimeout(r, 50));
    expect(events.some((e) => e.type === 'approval.requested')).toBe(true);

    // 用户在 UI 批准
    control.resolveApproval('appr-1', 'approved', 'once');

    // 容器内的等待应被兑现
    await expect(agentWaiting).resolves.toBe(true);
    b.wss.close();
    c.ws.close();
  });

  it('★ 拒绝同样下发（Agent 走替代方案而非挂起）', async () => {
    const control = new TaskControl();
    const b = bridge(control, () => {});
    const c = fakeContainer(b.port());
    await c.ready;
    c.hello();
    const waiting = c.waitApproval('appr-2');
    c.emit({ v: 1, type: 'approval.requested', approvalId: 'appr-2', kind: 'file_delete', title: 'x', detail: 'y' });
    await new Promise((r) => setTimeout(r, 50));
    control.resolveApproval('appr-2', 'denied', 'once');
    await expect(waiting).resolves.toBe(false);
    b.wss.close();
    c.ws.close();
  });

  it('★ 用户回答问题下发回容器', async () => {
    const control = new TaskControl();
    const b = bridge(control, () => {});
    const c = fakeContainer(b.port());
    await c.ready;
    c.hello();
    const waiting = c.waitAnswer('q-1');
    c.emit({ v: 1, type: 'question.asked', questionId: 'q-1', question: '用哪个格式？', options: ['docx', 'pdf'] });
    await new Promise((r) => setTimeout(r, 50));
    control.resolveAnswer('q-1', 'pdf');
    await expect(waiting).resolves.toBe('pdf');
    b.wss.close();
    c.ws.close();
  });

  it('取消时唤醒所有阻塞中的审批（不留悬挂）', async () => {
    const control = new TaskControl();
    const p = control.waitApproval('appr-3');
    control.cancel();
    await expect(p).resolves.toBe(false);
  });
});
