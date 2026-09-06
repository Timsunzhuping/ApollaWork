import { expect, test, type Page } from '@playwright/test';

/**
 * 主链路 e2e（T-411）：这条链路一断产品即不可用。
 * server 以 AUTH_MODE=dev + mock 模型 + 本地执行器起在 playwright.config 的 webServer 里。
 * mock 模型按 prompt 里的 [[ACTIONS]] 脚本出牌，让链路确定可复现。
 */
const actions = (steps: unknown[]) => `[[ACTIONS]]${JSON.stringify(steps)}[[/ACTIONS]]`;

async function submitTask(page: Page, prompt: string) {
  await page.getByTestId('composer-input').fill(prompt);
  await page.getByTestId('composer-send').click();
  await expect(page).toHaveURL(/\/task\//, { timeout: 15_000 });
}

async function waitTerminal(page: Page) {
  await expect(page.getByTestId('task-status')).toHaveAttribute('data-status', /completed|failed|cancelled/, { timeout: 30_000 });
  return page.getByTestId('task-status').getAttribute('data-status');
}

test('登录(dev) → 建任务 → 事件流 → 产物预览/下载', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('composer-input')).toBeVisible();

  await submitTask(
    page,
    '生成季度预算表。' +
      actions([
        { tool: 'Write', args: { path: 'budget-e2e.csv', content: 'quarter,budget\nQ1,120\nQ2,135\n' } },
        { tool: 'Artifact', args: { path: 'budget-e2e.csv', title: 'e2e 预算表', kind: 'spreadsheet' } },
        { say: '预算表已生成' },
      ]),
  );
  expect(await waitTerminal(page)).toBe('completed');

  // 时间线里能看到工具调用与总结
  // exact：用户气泡里的 prompt 也含这段字（在 [[ACTIONS]] 里），只认助手整条消息
  await expect(page.getByText('预算表已生成', { exact: true })).toBeVisible();
  // 产物进右栏，可预览、有下载链接
  const panel = page.getByTestId('artifact-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByText('e2e 预算表')).toBeVisible();
  const download = panel.getByRole('link', { name: /budget-e2e\.csv/ });
  await expect(download).toHaveAttribute('href', /\/file\?path=budget-e2e\.csv/);
  // 预览 iframe 拿到的是 text/plain（CSV 才能内联显示 —— 2026-08 手测缺陷的回归）
  const previewUrl = await panel.locator('iframe').getAttribute('src');
  expect(previewUrl).toContain('inline=1');
  const res = await page.request.get(previewUrl!);
  expect(res.headers()['content-type']).toContain('text/plain');
  expect(await res.text()).toContain('Q1,120');
});

test('任务结束后在 Composer 续写 → 同一会话开新任务（不是静默丢弃）', async ({ page }) => {
  await page.goto('/');
  await submitTask(page, '第一步。' + actions([{ say: '第一步完成' }]));
  expect(await waitTerminal(page)).toBe('completed');
  const firstUrl = page.url();

  await page.getByTestId('composer-input').fill('第二步。' + actions([{ say: '第二步完成' }]));
  await page.getByTestId('composer-send').click();
  await expect(page).not.toHaveURL(firstUrl, { timeout: 15_000 });
  await expect(page).toHaveURL(/\/task\//);
  expect(await waitTerminal(page)).toBe('completed');
  await expect(page.getByText('第二步完成', { exact: true })).toBeVisible();
});

test('ask 模式：危险命令弹审批 → 批准 → 任务完成', async ({ page }) => {
  // 用 API 建 ask 模式任务（Composer 的权限切换是同一接口），再打开任务页走审批
  await page.goto('/');
  const ws = await (await page.request.get('/api/v1/workspaces')).json();
  const session = await (
    await page.request.post(`/api/v1/workspaces/${ws[0].id}/sessions`, { data: { title: 'e2e 审批' } })
  ).json();
  const task = await (
    await page.request.post(`/api/v1/sessions/${session.id}/tasks`, {
      data: {
        prompt: '需要审批。' + actions([{ tool: 'Bash', args: { command: 'echo approved-run' } }, { say: '审批后完成' }]),
        mode: 'ask',
      },
    })
  ).json();
  await page.goto(`/task/${task.id}`);
  await page.getByRole('button', { name: /批准|Approve/ }).first().click({ timeout: 20_000 });
  expect(await waitTerminal(page)).toBe('completed');
  await expect(page.getByText('approved-run', { exact: true })).toBeVisible();
});

test('成员管理：添加 → 出现在列表 → 移除', async ({ page }) => {
  await page.goto('/members');
  await expect(page.getByTestId('members-page')).toBeVisible();
  await page.getByTestId('member-email').fill('member@corp.com');
  await page.getByTestId('member-role').selectOption('viewer');
  await page.getByTestId('member-add').click();
  const row = page.getByTestId('member-row').filter({ hasText: 'member@corp.com' });
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.getByTestId('member-remove').click();
  await expect(row).toHaveCount(0, { timeout: 10_000 });
});

test('缺失静态资源返回 404 而不是 index.html（滚动发布白屏回归）', async ({ page }) => {
  const res = await page.request.get('/assets/index-deadbeef.js');
  expect(res.status()).toBe(404);
  const spa = await page.request.get('/task/does-not-exist');
  expect(spa.status()).toBe(200);
  expect(spa.headers()['content-type']).toContain('text/html');
});
