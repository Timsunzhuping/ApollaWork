import { defineConfig } from 'vitest/config';

/** web 单元测试（T-411）：jsdom 环境跑纯逻辑——事件流归约、令牌续期、store。组件渲染由 Playwright e2e 覆盖。 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    globals: false,
  },
});
