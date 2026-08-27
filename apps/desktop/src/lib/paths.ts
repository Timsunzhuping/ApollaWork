import path from 'node:path';
import type { ResolvedPaths } from './types.js';

export interface ResolvePathsOptions {
  /** app.isPackaged。true=已打包（从 resourcesPath 定位），false=开发（从仓库源码定位） */
  isPackaged: boolean;
  /** process.resourcesPath（打包态）。开发态可传空串。 */
  resourcesPath: string;
  /**
   * 编译后 main.js 所在目录（即 __dirname）。开发态为 apps/desktop/dist，
   * 用于向上回溯仓库根：dist → desktop → apps → <repo root>。
   */
  desktopDistDir: string;
  /** 平台（默认取 process.platform）；win32 时 .bin 可执行文件加 .cmd 后缀。 */
  platform?: NodeJS.Platform;
}

function bin(dir: string, name: string, platform: NodeJS.Platform): string {
  const exe = platform === 'win32' ? `${name}.cmd` : name;
  return path.join(dir, 'node_modules', '.bin', exe);
}

/**
 * 解析开发/打包两种形态下的关键路径。
 *
 * 开发态目录假设（pnpm monorepo）：
 *   <repo>/apps/desktop/dist/main.js  → repo = resolve(desktopDistDir, '../../..')
 *   server = <repo>/apps/server，web = <repo>/apps/web/dist，skills = <repo>/skills
 *   server 子进程 cwd 设为 <repo>/apps/server，使 config.ts 的
 *   skillRoots[1] = resolve(cwd,'../../skills') = <repo>/skills 命中。
 *
 * 打包态目录假设（electron-builder extraResources 见 electron-builder.yml）：
 *   <Resources>/server/dist/main.js、<Resources>/web、<Resources>/skills、<Resources>/runtime
 *   server 子进程 cwd 设为 <Resources>，使 config.ts 的
 *   skillRoots[0] = resolve(cwd,'skills') = <Resources>/skills 命中。
 *   （WEB_DIST/STORAGE_DIR/DATABASE_URL_PRISMA 均以绝对路径注入，不依赖 cwd。）
 */
export function resolvePaths(opts: ResolvePathsOptions): ResolvedPaths {
  const platform = opts.platform ?? process.platform;

  if (opts.isPackaged) {
    const res = opts.resourcesPath;
    const serverRoot = path.join(res, 'server');
    return {
      serverMain: path.join(serverRoot, 'dist', 'main.js'),
      serverCwd: res,
      webDist: path.join(res, 'web'),
      schemaPath: path.join(serverRoot, 'prisma', 'schema.prisma'),
      seedPath: path.join(serverRoot, 'prisma', 'seed.ts'),
      prismaBin: bin(serverRoot, 'prisma', platform),
      tsxBin: bin(serverRoot, 'tsx', platform),
      skillsDir: path.join(res, 'skills'),
      runtimeDir: path.join(res, 'runtime'),
    };
  }

  const repoRoot = path.resolve(opts.desktopDistDir, '..', '..', '..');
  const serverRoot = path.join(repoRoot, 'apps', 'server');
  return {
    serverMain: path.join(serverRoot, 'dist', 'main.js'),
    serverCwd: serverRoot,
    webDist: path.join(repoRoot, 'apps', 'web', 'dist'),
    schemaPath: path.join(serverRoot, 'prisma', 'schema.prisma'),
    seedPath: path.join(serverRoot, 'prisma', 'seed.ts'),
    prismaBin: bin(serverRoot, 'prisma', platform),
    tsxBin: bin(serverRoot, 'tsx', platform),
    skillsDir: path.join(repoRoot, 'skills'),
    runtimeDir: path.join(repoRoot, 'apps', 'runtime'),
  };
}
