/* eslint-disable */
/**
 * 纯函数单元测试（无需 Electron、无需 server、无网络）。
 * 覆盖：端口探测、环境组装、就绪轮询、设置读写、路径解析、建库前置判断。
 * 运行：node test/unit.cjs（依赖已编译的 dist/lib）。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const distIndex = path.join(__dirname, '..', 'dist', 'lib', 'index.js');
if (!fs.existsSync(distIndex)) {
  console.error('缺少 dist/lib —— 请先运行 `pnpm --filter @apolla/desktop run build`');
  process.exit(1);
}
const lib = require(distIndex);

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
}

(async () => {
  console.log('unit: 纯函数');

  // —— net ——
  await test('findFreePort 返回一个真正空闲的端口', async () => {
    const port = await lib.findFreePort(3001);
    assert.ok(Number.isInteger(port) && port >= 3001, `期望 >=3001 的整数，得到 ${port}`);
    assert.strictEqual(await lib.isPortFree(port), true);
  });

  await test('findFreePort 会跳过被占用端口', async () => {
    const net = require('node:net');
    const busy = await lib.findFreePort(3050);
    const srv = net.createServer();
    await new Promise((r) => srv.listen(busy, '127.0.0.1', r));
    try {
      const next = await lib.findFreePort(busy);
      assert.notStrictEqual(next, busy, '应跳过被占用的端口');
      assert.ok(next > busy);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  // —— env ——
  await test('buildServerEnv 注入本地执行模式的全部关键变量', () => {
    const env = lib.buildServerEnv({
      port: 3999,
      userDataDir: '/tmp/apolla-ud',
      webDist: '/opt/web/dist',
      settings: {},
      base: {},
    });
    assert.strictEqual(env.SERVE_WEB, '1');
    assert.strictEqual(env.EXECUTOR, 'local');
    assert.strictEqual(env.STORAGE_DRIVER, 'fs');
    assert.strictEqual(env.QUEUE_DRIVER, 'inproc');
    assert.strictEqual(env.AUTH_MODE, 'dev');
    assert.strictEqual(env.SERVER_PORT, '3999');
    assert.strictEqual(env.WEB_DIST, '/opt/web/dist');
    assert.strictEqual(env.ELECTRON_RUN_AS_NODE, '1');
    assert.ok(env.STORAGE_DIR.endsWith(path.join('apolla-ud', 'storage')));
    assert.ok(env.DATABASE_URL_PRISMA.startsWith('file:'));
    assert.ok(env.DATABASE_URL_PRISMA.endsWith(path.join('apolla-ud', 'apolla.db')));
    assert.strictEqual(env.MODEL_DEFAULT, 'mock', '空设置应回落到 mock');
  });

  await test('buildServerEnv：用户设置 > 环境 > mock，且带上 baseUrl/apiKey', () => {
    const env = lib.buildServerEnv({
      port: 1,
      userDataDir: '/tmp/x',
      webDist: '/w',
      settings: { MODEL_DEFAULT: 'qwen3:8b', MODEL_BASE_URL: 'http://localhost:11434/v1', MODEL_API_KEY: 'k' },
      base: { MODEL_DEFAULT: 'ignored' },
    });
    assert.strictEqual(env.MODEL_DEFAULT, 'qwen3:8b');
    assert.strictEqual(env.MODEL_BASE_URL, 'http://localhost:11434/v1');
    assert.strictEqual(env.MODEL_API_KEY, 'k');

    const env2 = lib.buildServerEnv({ port: 1, userDataDir: '/t', webDist: '/w', settings: {}, base: { MODEL_DEFAULT: 'from-env' } });
    assert.strictEqual(env2.MODEL_DEFAULT, 'from-env', '无用户设置时应取环境值');
  });

  // —— ready ——
  await test('waitForServerReady 在第 3 次探测拿到 200 时成功', async () => {
    let n = 0;
    const ok = await lib.waitForServerReady({
      url: 'http://x',
      timeoutMs: 10_000,
      intervalMs: 1,
      sleepImpl: async () => {},
      fetchImpl: async () => ({ status: ++n >= 3 ? 200 : 503 }),
    });
    assert.strictEqual(ok, true);
    assert.strictEqual(n, 3);
  });

  await test('waitForServerReady 持续非 200 会超时抛错', async () => {
    await assert.rejects(
      lib.waitForServerReady({
        url: 'http://x',
        timeoutMs: 20,
        intervalMs: 5,
        sleepImpl: async () => {},
        fetchImpl: async () => ({ status: 500 }),
      }),
      /超时/,
    );
  });

  await test('waitForServerReady：shouldAbort 触发时立即抛出（子进程提前退出）', async () => {
    await assert.rejects(
      lib.waitForServerReady({
        url: 'http://x',
        timeoutMs: 10_000,
        intervalMs: 1,
        sleepImpl: async () => {},
        fetchImpl: async () => ({ status: 500 }),
        shouldAbort: () => 'server 进程提前退出（code=1）',
      }),
      /提前退出/,
    );
  });

  // —— settings ——
  await test('settings 保存/读取往返 + 白名单过滤', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apolla-set-'));
    try {
      assert.deepStrictEqual(lib.loadSettings(dir), {});
      const merged = lib.saveSettings(dir, { MODEL_DEFAULT: 'mock', HACK: 'x', MODEL_API_KEY: '' });
      assert.strictEqual(merged.MODEL_DEFAULT, 'mock');
      assert.ok(!('HACK' in merged), '非白名单键应被丢弃');
      assert.ok(!('MODEL_API_KEY' in merged), '空字符串键应被丢弃');
      // 合并保留旧值
      const merged2 = lib.saveSettings(dir, { MODEL_BASE_URL: 'http://h/v1' });
      assert.strictEqual(merged2.MODEL_DEFAULT, 'mock');
      assert.strictEqual(merged2.MODEL_BASE_URL, 'http://h/v1');
      assert.deepStrictEqual(lib.loadSettings(dir), merged2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // —— paths ——
  await test('resolvePaths(dev) 指向仓库源码位置', () => {
    const desktopDistDir = path.join('/repo', 'apps', 'desktop', 'dist');
    const p = lib.resolvePaths({ isPackaged: false, resourcesPath: '', desktopDistDir, platform: 'darwin' });
    assert.strictEqual(p.serverMain, path.join('/repo', 'apps', 'server', 'dist', 'main.js'));
    assert.strictEqual(p.serverCwd, path.join('/repo', 'apps', 'server'));
    assert.strictEqual(p.webDist, path.join('/repo', 'apps', 'web', 'dist'));
    assert.strictEqual(p.schemaPath, path.join('/repo', 'apps', 'server', 'prisma', 'schema.prisma'));
    assert.ok(p.prismaBin.endsWith(path.join('.bin', 'prisma')));
    assert.ok(p.tsxBin.endsWith(path.join('.bin', 'tsx')));
    assert.strictEqual(p.skillsDir, path.join('/repo', 'skills'));
  });

  await test('resolvePaths(packaged) 从 resourcesPath 定位，cwd=<Resources> 使 skillRoots 命中', () => {
    const p = lib.resolvePaths({ isPackaged: true, resourcesPath: '/App/Resources', desktopDistDir: '/ignored', platform: 'win32' });
    assert.strictEqual(p.serverMain, path.join('/App/Resources', 'server', 'dist', 'main.js'));
    assert.strictEqual(p.serverCwd, '/App/Resources');
    assert.strictEqual(p.webDist, path.join('/App/Resources', 'web'));
    assert.strictEqual(p.skillsDir, path.join('/App/Resources', 'skills'));
    assert.ok(p.prismaBin.endsWith('prisma.cmd'), 'win32 下 .bin 应加 .cmd 后缀');
  });

  // —— database ——
  await test('databaseExists / databaseFile', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apolla-db-'));
    try {
      assert.strictEqual(lib.databaseExists(dir), false);
      assert.ok(lib.databaseFile(dir).endsWith('apolla.db'));
      fs.writeFileSync(lib.databaseFile(dir), 'x');
      assert.strictEqual(lib.databaseExists(dir), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('ensureDatabase：库已存在则跳过（不调用 execFile）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apolla-ens-'));
    try {
      fs.writeFileSync(lib.databaseFile(dir), 'x');
      let calls = 0;
      const r = await lib.ensureDatabase(dir, {
        paths: { serverCwd: dir, prismaBin: 'prisma', tsxBin: 'tsx', schemaPath: 's', seedPath: 'seed' },
        env: {},
        execFileAsync: async () => {
          calls++;
          return { stdout: '', stderr: '' };
        },
      });
      assert.strictEqual(r.created, false);
      assert.strictEqual(calls, 0, '库已存在不应执行任何命令');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('ensureDatabase：库不存在则按序 db push → seed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apolla-ens2-'));
    fs.rmSync(dir, { recursive: true, force: true }); // 确保目录也不存在
    try {
      const seq = [];
      const r = await lib.ensureDatabase(dir, {
        paths: { serverCwd: dir, prismaBin: '/bin/prisma', tsxBin: '/bin/tsx', schemaPath: '/s.prisma', seedPath: '/seed.ts' },
        env: { DATABASE_URL_PRISMA: 'file:/x' },
        execFileAsync: async (file, args) => {
          seq.push(path.basename(file) + ' ' + args[0]);
          return { stdout: '', stderr: '' };
        },
      });
      assert.strictEqual(r.created, true);
      assert.deepStrictEqual(seq, ['prisma db', 'tsx /seed.ts']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  console.log(`\nunit: ${passed} passed${process.exitCode ? '，有失败' : ''}`);
})();
