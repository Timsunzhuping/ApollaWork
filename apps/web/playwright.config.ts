import { defineConfig, devices } from '@playwright/test';

/**
 * 主链路 e2e（T-411）。webServer 用 scripts/e2e-server.sh 起一个 dev 免登 + mock 模型的 server，
 * 前端由 server 托管（与生产单进程部署一致）。CI 里 build 在前一步完成。
 */
const port = Number(process.env.E2E_PORT ?? 3111);

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: `http://localhost:${port}`,
    locale: 'zh-CN',
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'bash ../../scripts/e2e-server.sh',
    port,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
