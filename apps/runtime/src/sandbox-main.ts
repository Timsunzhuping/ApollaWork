#!/usr/bin/env node
import readline from 'node:readline';
import { ControlEnvelope, type RuntimeEnvelope, type TaskEvent, type PermissionMode } from '@apolla/protocol';
import { runTask } from './runner.js';
import type { EventSink, ControlSource } from './emitter.js';
import { createBridgeFetch, startLoopbackProxy, type BridgeChannel } from './bridge-fetch.js';

/**
 * 沙箱内 headless 入口（PRD §4.3 / T-007，T-402 改为无网 stdio 桥）。
 * 容器 NetworkMode=none，彻底没有网络：
 * - 控制通道走 stdio：stdout 每行一个 RuntimeEnvelope 上行，stdin 每行一个 ControlEnvelope 下行；
 * - 模型调用 / WebFetch 经 createBridgeFetch 上送 server 中继，密钥留在 server，容器拿不到；
 * - 127.0.0.1:3128 回环代理让 Bash 里的 curl/python、MCP 连接器的白名单出网走同一策略。
 * stdout 归协议独占，任何日志一律走 stderr。
 */
async function main() {
  // stdout 是协议通道 —— 把 console.log/info/warn 全部改道 stderr，否则一行日志就会污染帧流
  console.log = console.info = console.warn = (...a: unknown[]) => console.error(...a);

  const taskId = process.env.APOLLA_TASK_ID!;
  const token = process.env.APOLLA_TOKEN!;
  const prompt = Buffer.from(process.env.APOLLA_PROMPT_B64 ?? '', 'base64').toString('utf8');
  const mode = (process.env.APOLLA_MODE as PermissionMode) ?? 'auto';

  const write = (env: RuntimeEnvelope) => {
    process.stdout.write(JSON.stringify(env) + '\n');
  };
  const listeners = new Set<(m: ControlEnvelope) => void>();
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let parsed: ReturnType<typeof ControlEnvelope.safeParse>;
    try {
      parsed = ControlEnvelope.safeParse(JSON.parse(line));
    } catch {
      return;
    }
    if (!parsed.success) return;
    for (const l of listeners) l(parsed.data);
  });
  const channel: BridgeChannel = {
    send: write,
    onControl(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };

  // 握手：server 校验令牌后回 hello.ok；拿不到就不跑任务
  write({ kind: 'hello', taskId, token });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('等待 server 握手超时')), 15_000);
    const off = channel.onControl((m) => {
      if (m.kind === 'hello.ok') {
        clearTimeout(t);
        off();
        resolve();
      }
    });
  });

  // 回环代理：Bash/python/MCP 的出网都经它上送 server 判定
  const proxyPort = Number(process.env.APOLLA_PROXY_PORT ?? 3128);
  await startLoopbackProxy(channel, proxyPort);
  const proxyUrl = `http://127.0.0.1:${proxyPort}`;
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) process.env[k] = proxyUrl;
  process.env.NO_PROXY = process.env.no_proxy = '127.0.0.1,localhost';

  const bridgeFetch = createBridgeFetch(channel);

  // 控制信号：审批 / 提问 / 追加指令 / 取消
  const pendingApprovals = new Map<string, (ok: boolean) => void>();
  const pendingAnswers = new Map<string, (a: string) => void>();
  let cancelled = false;
  const inputs: string[] = [];
  channel.onControl((msg) => {
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
    emit: (event: TaskEvent) => write({ kind: 'event', event }),
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
          // 密钥不进容器：server 中继时在自己那侧注入 Authorization
          apiKey: 'relayed-by-server',
          fallbackModel: process.env.MODEL_FALLBACK || undefined,
        },
        fetchImpl: bridgeFetch,
        skillRoots: ['/opt/apolla/skills'],
        maxDurationMs: Number(process.env.TASK_MAX_DURATION_MS ?? 0) || undefined,
        maxTokens: Number(process.env.TASK_MAX_TOKENS ?? 0) || undefined,
        webfetchAllowlist: (process.env.WEBFETCH_ALLOWLIST ?? '').split(',').filter(Boolean),
      },
      sink,
      control,
    );
  } finally {
    write({ kind: 'bye' });
    // 给 stdout 刷完的时间，再让进程自然退出
    setTimeout(() => process.exit(0), 200);
  }
}

main().catch((e) => {
  console.error('sandbox-main 失败：', e);
  process.exit(1);
});
