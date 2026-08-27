#!/usr/bin/env node
import WebSocket from 'ws';
import { RuntimeEnvelope, ControlEnvelope, type TaskEvent, type PermissionMode } from '@apolla/protocol';
import { runTask } from './runner.js';
import type { EventSink, ControlSource } from './emitter.js';

/**
 * 沙箱内 headless 入口（PRD §4.3 / T-007）。
 * 容器启动后：连 server 的 WS 桥 → 跑 runTask → 事件经 WS 上报、控制信号经 WS 下行。
 * 工作区固定挂载在 /workspace。模型配置由 env 注入（生产指向 LiteLLM 网关）。
 */
async function main() {
  const taskId = process.env.APOLLA_TASK_ID!;
  const token = process.env.APOLLA_TOKEN!;
  const bridge = process.env.APOLLA_BRIDGE!;
  const prompt = Buffer.from(process.env.APOLLA_PROMPT_B64 ?? '', 'base64').toString('utf8');
  const mode = (process.env.APOLLA_MODE as PermissionMode) ?? 'auto';

  const ws = new WebSocket(bridge);
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });

  const send = (env: RuntimeEnvelope) => ws.send(JSON.stringify(env));
  send({ kind: 'hello', taskId, token });

  // 控制信号：等待 server 下行
  const pendingApprovals = new Map<string, (ok: boolean) => void>();
  const pendingAnswers = new Map<string, (a: string) => void>();
  let cancelled = false;
  const inputs: string[] = [];

  ws.on('message', (raw) => {
    const parsed = ControlEnvelope.safeParse(JSON.parse(raw.toString()));
    if (!parsed.success) return;
    const msg = parsed.data;
    if (msg.kind === 'approval.resolved') {
      pendingApprovals.get(msg.approvalId)?.(msg.decision === 'approved');
      pendingApprovals.delete(msg.approvalId);
    } else if (msg.kind === 'question.answered') {
      pendingAnswers.get(msg.questionId)?.(msg.answer);
      pendingAnswers.delete(msg.questionId);
    } else if (msg.kind === 'user.input') {
      inputs.push(msg.text);
    } else if (msg.kind === 'cancel') {
      cancelled = true;
      for (const [, fn] of pendingApprovals) fn(false);
      pendingApprovals.clear();
    }
  });

  const sink: EventSink = {
    emit: (event: TaskEvent) => {
      // 从事件里解析出待处理审批/问题 id，以便控制回路匹配
      send({ kind: 'event', event });
    },
  };

  const control: ControlSource = {
    waitApproval: (id) =>
      new Promise((resolve) => {
        if (cancelled) return resolve(false);
        pendingApprovals.set(id, resolve);
      }),
    waitAnswer: (id) => new Promise((resolve) => pendingAnswers.set(id, resolve)),
    drainUserInputs: () => inputs.splice(0, inputs.length),
    isCancelled: () => cancelled,
  };

  try {
    await runTask(
      {
        taskId,
        prompt,
        workspaceDir: '/workspace',
        mode,
        modelConfig: {
          model: process.env.MODEL_DEFAULT ?? 'mock',
          baseUrl: process.env.MODEL_BASE_URL,
          apiKey: process.env.MODEL_API_KEY,
        },
        skillRoots: ['/opt/apolla/skills'],
        webfetchAllowlist: (process.env.WEBFETCH_ALLOWLIST ?? '').split(',').filter(Boolean),
      },
      sink,
      control,
    );
  } finally {
    send({ kind: 'bye' });
    setTimeout(() => ws.close(), 200);
  }
}

main().catch((e) => {
  console.error('sandbox-main 失败：', e);
  process.exit(1);
});
