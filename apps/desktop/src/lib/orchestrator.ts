import { promisify } from 'node:util';
import { execFile as _execFile, spawn as _spawn, type ChildProcess } from 'node:child_process';
import { findFreePort } from './net.js';
import { buildServerEnv } from './env.js';
import { ensureDatabase, type ExecFileAsync } from './database.js';
import { waitForServerReady } from './ready.js';
import type { ModelSettings, ResolvedPaths } from './types.js';

export interface LaunchLocalServerOptions {
  userDataDir: string;
  paths: ResolvedPaths;
  settings: ModelSettings;
  /** 起始探测端口，默认 3001 */
  startPort?: number;
  host?: string;
  /** 就绪总超时（毫秒），默认 60000 */
  readyTimeoutMs?: number;
  onLog?: (m: string) => void;
  // —— 可注入依赖（测试用）——
  spawnImpl?: typeof _spawn;
  execFileAsync?: ExecFileAsync;
  fetchImpl?: typeof fetch;
}

export interface LaunchLocalServerResult {
  child: ChildProcess;
  port: number;
  /** http://host:port —— 就绪后加载到 BrowserWindow */
  baseUrl: string;
  /** 健康探测 URL */
  healthUrl: string;
  env: NodeJS.ProcessEnv;
}

/**
 * 本地执行模式的完整拉起流程：
 *   探测空闲端口 → 组装环境 → 确保 SQLite（首启 db push + seed）→ spawn server → 轮询就绪。
 * 用 process.execPath + ELECTRON_RUN_AS_NODE=1 拉起：开发态即 node，打包态让 Electron 以纯 Node 运行 server。
 */
export async function launchLocalServer(opts: LaunchLocalServerOptions): Promise<LaunchLocalServerResult> {
  const host = opts.host ?? '127.0.0.1';
  const spawnImpl = opts.spawnImpl ?? _spawn;
  const execFileAsync = opts.execFileAsync ?? (promisify(_execFile) as unknown as ExecFileAsync);
  const log = opts.onLog ?? (() => {});

  const port = await findFreePort(opts.startPort ?? 3001, host);
  log(`选定空闲端口 ${port}`);

  const env = buildServerEnv({
    port,
    userDataDir: opts.userDataDir,
    webDist: opts.paths.webDist,
    settings: opts.settings,
  });

  await ensureDatabase(opts.userDataDir, { paths: opts.paths, env, execFileAsync, onLog: log });

  log(`拉起 server：${opts.paths.serverMain}`);
  const child = spawnImpl(process.execPath, [opts.paths.serverMain], {
    cwd: opts.paths.serverCwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (d: Buffer) => log(`[server] ${d.toString().trimEnd()}`));
  child.stderr?.on('data', (d: Buffer) => log(`[server:err] ${d.toString().trimEnd()}`));

  let earlyExit: string | null = null;
  child.once('exit', (code, signal) => {
    if (earlyExit === null) earlyExit = `server 进程提前退出（code=${code ?? '?'} signal=${signal ?? '-'}）`;
  });

  const baseUrl = `http://${host}:${port}`;
  const healthUrl = `${baseUrl}/api/v1/me`;

  try {
    await waitForServerReady({
      url: healthUrl,
      timeoutMs: opts.readyTimeoutMs ?? 60_000,
      fetchImpl: opts.fetchImpl,
      shouldAbort: () => earlyExit,
    });
  } catch (e) {
    // 就绪失败：确保回收子进程，避免僵尸
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    throw e;
  }

  log('本地服务就绪');
  return { child, port, baseUrl, healthUrl, env };
}
