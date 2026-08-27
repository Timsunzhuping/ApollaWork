/* eslint-disable */
/**
 * 集成冒烟测试（真实拉起内嵌 server，不含 Electron GUI）。
 *
 * 复用与主进程完全相同的编排逻辑（launchLocalServer）：
 *   探测端口 → 组装本地执行模式环境 → 首次 prisma db push + seed → spawn server → 轮询就绪。
 * 然后校验：/api/v1/me 返回 200 且是 seed 出的管理员；根路径 / 由 server 托管前端；
 * /api/v1/workspaces 返回默认工作台。最后回收子进程并清理临时 userData。
 *
 * 前置：需先构建 server/web/runtime 与 desktop：
 *   pnpm --filter @apolla/server --filter @apolla/web --filter @apolla/runtime run build
 *   pnpm --filter @apolla/desktop run build
 * 运行：node test/smoke.cjs
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

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const desktopDistDir = path.join(repoRoot, 'apps', 'desktop', 'dist');
const paths = lib.resolvePaths({ isPackaged: false, resourcesPath: '', desktopDistDir });

// 前置构建检查
const need = [];
if (!fs.existsSync(paths.serverMain)) need.push(paths.serverMain);
if (!fs.existsSync(path.join(paths.webDist, 'index.html'))) need.push(path.join(paths.webDist, 'index.html'));
if (!fs.existsSync(paths.prismaBin)) need.push(paths.prismaBin);
if (!fs.existsSync(paths.tsxBin)) need.push(paths.tsxBin);
if (need.length) {
  console.error('冒烟前置缺失（请先构建 server/web/runtime）：\n  ' + need.join('\n  '));
  process.exit(1);
}

// 兜底超时，避免脚本挂死
const hardTimer = setTimeout(() => {
  console.error('✗ 冒烟整体超时（150s）');
  process.exit(1);
}, 150_000);
hardTimer.unref();

(async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apolla-desktop-smoke-'));
  console.log('临时 userData：', userDataDir);
  let child = null;
  try {
    const result = await lib.launchLocalServer({
      userDataDir,
      paths,
      settings: { MODEL_DEFAULT: 'mock' }, // 无需 LLM
      startPort: 3701, // 避开可能在跑的 3001 dev server
      readyTimeoutMs: 120_000,
      onLog: (m) => console.log('   ', m),
    });
    child = result.child;
    console.log('本地服务就绪：', result.baseUrl);

    // 1) /api/v1/me → 200 且是 seed 出的管理员
    const meRes = await fetch(result.healthUrl);
    assert.strictEqual(meRes.status, 200, '/api/v1/me 应返回 200');
    const me = await meRes.json();
    console.log('   /me =', JSON.stringify(me));
    assert.ok(me && typeof me.email === 'string', '/me 应含 email');
    assert.strictEqual(me.role, 'admin', 'dev 认证应注入管理员');

    // 2) 根路径由 server 托管前端（验证 SERVE_WEB=1 + WEB_DIST 生效）
    const rootRes = await fetch(result.baseUrl + '/');
    assert.strictEqual(rootRes.status, 200, '/ 应由 server 托管前端');
    const html = await rootRes.text();
    assert.ok(/Apolla Work/i.test(html) && /<div id="root">/.test(html), '/ 应返回 web 的 index.html');

    // 3) 业务接口连通（DB + 认证 + seed 默认工作台）
    const wsRes = await fetch(result.baseUrl + '/api/v1/workspaces');
    assert.strictEqual(wsRes.status, 200, '/api/v1/workspaces 应返回 200');
    const workspaces = await wsRes.json();
    assert.ok(Array.isArray(workspaces) && workspaces.length >= 1, '应至少有一个默认工作台');
    console.log('   workspaces =', workspaces.map((w) => w.name).join(', '));

    // 4) SQLite 确实落盘在 userData
    assert.ok(fs.existsSync(lib.databaseFile(userDataDir)), 'apolla.db 应存在于 userData');

    console.log('\n✓ 冒烟通过：本地执行模式端到端可用（server 拉起 + 建库 + seed + 托管前端 + 接口连通）');
  } catch (e) {
    console.error('\n✗ 冒烟失败：', e && e.message ? e.message : e);
    process.exitCode = 1;
  } finally {
    if (child && !child.killed) {
      try {
        child.kill();
      } catch {}
      // 给子进程一点时间释放端口/句柄
      await new Promise((r) => setTimeout(r, 500));
    }
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {}
    clearTimeout(hardTimer);
  }
})();
