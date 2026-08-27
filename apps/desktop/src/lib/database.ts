import fs from 'node:fs';
import { databaseFile } from './env.js';
import type { ResolvedPaths } from './types.js';

/** promisify(execFile) 的最小签名（便于测试注入）。 */
export type ExecFileAsync = (
  file: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

/** SQLite 是否已存在。 */
export function databaseExists(userDataDir: string): boolean {
  return fs.existsSync(databaseFile(userDataDir));
}

export interface EnsureDatabaseDeps {
  paths: ResolvedPaths;
  /** server 环境（必须已含 DATABASE_URL_PRISMA，prisma/seed 据此定位库） */
  env: NodeJS.ProcessEnv;
  execFileAsync: ExecFileAsync;
  onLog?: (msg: string) => void;
}

/**
 * 确保本地 SQLite 就绪：
 *  - server 侧（PrismaClient）不会自动建表，故桌面端首次启动负责 `prisma db push`；
 *  - 随后复用 apps/server/prisma/seed.ts 灌入组织/管理员/默认工作台（dev 认证依赖它）。
 * 串行执行，任一步失败即抛出（附 stderr）。库已存在则整体跳过。
 */
export async function ensureDatabase(userDataDir: string, deps: EnsureDatabaseDeps): Promise<{ created: boolean }> {
  if (databaseExists(userDataDir)) {
    deps.onLog?.('数据库已存在，跳过初始化');
    return { created: false };
  }
  fs.mkdirSync(userDataDir, { recursive: true });
  const opts = { cwd: deps.paths.serverCwd, env: deps.env };

  try {
    deps.onLog?.('首次启动：创建数据库结构（prisma db push）…');
    await deps.execFileAsync(
      deps.paths.prismaBin,
      ['db', 'push', '--schema', deps.paths.schemaPath, '--skip-generate'],
      opts,
    );
  } catch (e) {
    throw new Error(`建库失败（prisma db push）：${errText(e)}`);
  }

  try {
    deps.onLog?.('灌入种子数据（seed.ts）…');
    await deps.execFileAsync(deps.paths.tsxBin, [deps.paths.seedPath], opts);
  } catch (e) {
    throw new Error(`种子数据失败（seed.ts）：${errText(e)}`);
  }

  deps.onLog?.('数据库初始化完成');
  return { created: true };
}

function errText(e: unknown): string {
  if (e && typeof e === 'object') {
    const anyE = e as { stderr?: string; message?: string };
    return (anyE.stderr && anyE.stderr.trim()) || anyE.message || String(e);
  }
  return String(e);
}
