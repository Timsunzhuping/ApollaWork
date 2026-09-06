import path from 'node:path';
import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import Docker from 'dockerode';
import { Logger } from '@nestjs/common';
import type { TaskEvent } from '@apolla/protocol';
import type { ControlSource } from '@apolla/runtime';
import type { Executor, ExecRequest, ExecResult } from './executor.js';
import type { AppConfig } from '../config.js';
import { SandboxBridge } from './sandbox-bridge.js';
import { buildEgressPolicy } from './egress-policy.js';

/**
 * Docker 执行器（PRD §4.5，生产）：每任务一沙箱容器。
 *
 * T-402 网络隔离：容器 NetworkMode=none，彻底没有网络接口 —— 这是红线「默认禁出网」的
 * 容器层机制，不再依赖命令正则。控制通道走 attach 的 stdio（无网络、无 Unix socket，
 * Docker Desktop / Linux / K8s 通用）；模型调用与白名单出网由 SandboxBridge 在 server 侧
 * 按 EgressPolicy 判定后代为访问，模型密钥只在 server 侧注入，容器环境里没有它。
 */
export class DockerExecutor implements Executor {
  private docker: Docker;
  private readonly logger = new Logger('Sandbox');

  /** client 可注入（测试用假实现，验证容器安全配置而无需真实 Docker）。 */
  constructor(
    private config: AppConfig,
    client?: Docker,
    private hooks: { onContainer?: (delta: 1 | -1) => void; onEgress?: (outcome: 'allowed' | 'denied') => void } = {},
  ) {
    this.docker = client ?? new Docker();
  }

  /** 组装容器创建参数（抽出以便测试安全配置）。 */
  buildContainerSpec(req: ExecRequest, token: string) {
    return {
      Image: this.config.sandboxImage,
      Cmd: ['node', '/opt/apolla/apps/runtime/dist/sandbox-main.js'],
      Env: [
        `APOLLA_TASK_ID=${req.taskId}`,
        `APOLLA_TOKEN=${token}`,
        `APOLLA_PROMPT_B64=${Buffer.from(req.prompt).toString('base64')}`,
        `APOLLA_MODE=${req.mode}`,
        `APOLLA_PROXY_PORT=3128`,
        `MODEL_DEFAULT=${req.model.name}`,
        `MODEL_BASE_URL=${req.model.baseUrl ?? ''}`,
        `MODEL_FALLBACK=${req.model.fallback ?? ''}`,
        // 注意：没有 MODEL_API_KEY —— 模型请求由 server 中继并在 server 侧注入密钥
        `WEBFETCH_ALLOWLIST=${req.webfetchAllowlist.join(',')}`,
        `TASK_MAX_DURATION_MS=${req.maxDurationMs ?? 0}`,
        `TASK_MAX_TOKENS=${req.maxTokens ?? 0}`,
        ...(req.dangerRules ? [`DANGER_RULES_B64=${Buffer.from(JSON.stringify(req.dangerRules)).toString('base64')}`] : []),
        // 根文件系统只读（T-403）：所有可写位置显式指向 tmpfs
        'HOME=/home/apolla',
        'TMPDIR=/tmp',
        'MPLCONFIGDIR=/tmp/mpl',
        'XDG_CACHE_HOME=/tmp/cache',
        'PYTHONDONTWRITEBYTECODE=1',
      ],
      // stdio 即控制通道：stdin 下行、stdout 上行、stderr 容器日志
      OpenStdin: true,
      StdinOnce: false,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      HostConfig: {
        Binds: [`${path.resolve(req.workspaceDir)}:/workspace`],
        NetworkMode: 'none', // ★ 无网络接口；一切出网走 server 中继
        Memory: 4 * 1024 * 1024 * 1024,
        NanoCpus: 2_000_000_000,
        PidsLimit: 512, // 防 fork bomb 耗尽宿主 PID
        AutoRemove: true,
        Privileged: false,
        // 加固（T-403）：丢弃全部 capability；no-new-privileges 防 setuid 提权；
        // seccomp / AppArmor 保持 Docker 默认 profile（绝不 unconfined）
        CapDrop: ['ALL'],
        CapAdd: [] as string[],
        SecurityOpt: ['no-new-privileges'],
        // 根文件系统只读：镜像里的 runtime、技能、python 包一律不可改；
        // 唯二可写处是工作区 bind 与下面的 tmpfs（随容器销毁）
        ReadonlyRootfs: true,
        Tmpfs: {
          '/tmp': 'rw,nosuid,size=1g',
          '/home/apolla': 'rw,nosuid,size=256m',
        },
        Ulimits: [
          { Name: 'nofile', Soft: 4096, Hard: 8192 },
          { Name: 'nproc', Soft: 512, Hard: 512 },
        ],
        IpcMode: 'private',
      },
      WorkingDir: '/workspace',
      User: '1001:1001', // 非 root
    };
  }

  async run(
    req: ExecRequest,
    onEvent: (e: TaskEvent) => void,
    control: ControlSource,
  ): Promise<ExecResult> {
    const token = randomUUID();
    const bridge = new SandboxBridge({
      token,
      control,
      onEvent,
      policy: buildEgressPolicy(req),
      modelName: req.model.name,
      onEgress: this.hooks.onEgress,
      log: (level, msg, meta) => {
        const line = `${msg} ${JSON.stringify({ taskId: req.taskId, ...meta })}`;
        if (level === 'warn') this.logger.warn(line);
        else this.logger.log(line);
      },
    });

    let container: Docker.Container | undefined;
    let stream: NodeJS.ReadWriteStream | undefined;
    try {
      container = await this.docker.createContainer(this.buildContainerSpec(req, token) as never);

      // 先 attach 再 start，不漏掉容器最早写出的帧
      stream = (await container.attach({
        stream: true,
        stdin: true,
        stdout: true,
        stderr: true,
        hijack: true,
      })) as NodeJS.ReadWriteStream;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      (this.docker.modem as { demuxStream: (s: unknown, o: unknown, e: unknown) => void }).demuxStream(
        stream,
        stdout,
        stderr,
      );
      const rl = readline.createInterface({ input: stdout, crlfDelay: Infinity });
      const s = stream;
      bridge.attach({
        write: (line) => {
          s.write(line + '\n');
        },
        onLine: (cb) => rl.on('line', cb),
        onClose: (cb) => s.on('close', cb),
      });
      // 容器 stderr = 沙箱日志，逐行记录（有上限，防止刷屏）
      let errLines = 0;
      readline.createInterface({ input: stderr }).on('line', (l) => {
        if (errLines++ < 200) this.logger.debug(`[${req.taskId}] ${l}`);
      });

      await container.start();
      this.hooks.onContainer?.(1);

      // 用户取消时直接杀容器（避免等待 Agent 自行让出）
      const killPoll = setInterval(() => {
        if (control.isCancelled()) {
          container?.kill().catch(() => undefined);
          clearInterval(killPoll);
        }
      }, 500);

      // dockerode 的 wait() 返回 { StatusCode } 对象，不是数组
      const exit = (await container.wait()) as { StatusCode?: number } | undefined;
      clearInterval(killPoll);
      await new Promise((r) => setTimeout(r, 300)); // 给最后的帧留时间

      const result = bridge.result();
      if (result.status === 'failed' && !result.summary) {
        result.summary = `沙箱容器退出（code=${exit?.StatusCode ?? '?'}），未收到完成事件。`;
      }
      return result;
    } catch (e) {
      throw new Error(
        `Docker 执行失败（镜像 ${this.config.sandboxImage} 是否已构建？）：${(e as Error).message}`,
      );
    } finally {
      if (container) this.hooks.onContainer?.(-1);
      bridge.dispose();
      try {
        stream?.end();
      } catch {
        /* 已关闭 */
      }
    }
  }
}
