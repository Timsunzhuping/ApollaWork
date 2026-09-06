import { Bridge } from './bridge.js';
import type { ChannelAdapter } from './channel.js';
import { DingTalkAdapter } from './adapters/dingtalk.js';
import { FeishuAdapter } from './adapters/feishu.js';
import { MockAdapter } from './adapters/mock.js';
import { WecomAdapter } from './adapters/wecom.js';

/**
 * IM 桥接服务入口（PRD T-205/206）。
 * 环境变量：
 *   APOLLA_API          Apolla REST 根地址，默认 http://localhost:3001/api/v1
 *   APOLLA_PUBLIC_URL   产物下载链接用的对外地址（默认取 APOLLA_API 去掉 /api/v1）
 *   APOLLA_WORKSPACE_ID 默认工作区（不配则取第一个）
 *   CHANNELS            启用的通道，逗号分隔，默认 wecom,dingtalk,feishu（可加 mock 冒烟）
 *   WECOM_PORT / DINGTALK_PORT / FEISHU_PORT   回调端口，默认都 3210（共享一个服务器）
 *   WECOM_WEBHOOK_URL / DINGTALK_WEBHOOK_URL(+DINGTALK_SECRET) / FEISHU_WEBHOOK_URL  回推 webhook
 */
function createAdapter(name: string): ChannelAdapter {
  switch (name) {
    case 'wecom':
      return new WecomAdapter();
    case 'dingtalk':
      return new DingTalkAdapter();
    case 'feishu':
      return new FeishuAdapter();
    case 'mock':
      return new MockAdapter();
    default:
      throw new Error(`未知通道：${name}（可选 wecom | dingtalk | feishu | mock）`);
  }
}

async function main(): Promise<void> {
  const apiBase = (process.env.APOLLA_API ?? 'http://localhost:3001/api/v1').replace(/\/$/, '');
  const publicUrl = (process.env.APOLLA_PUBLIC_URL ?? apiBase.replace(/\/api\/v1$/, '')).replace(
    /\/$/,
    '',
  );
  const channels = (process.env.CHANNELS ?? 'wecom,dingtalk,feishu')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const bridge = new Bridge({
    apiBase,
    apiKey: process.env.APOLLA_API_KEY, // 管理后台「集成 API Key」签发（scopes: tasks,files）
    publicUrl,
    workspaceId: process.env.APOLLA_WORKSPACE_ID,
    taskMode: process.env.APOLLA_TASK_MODE,
  });
  for (const name of channels) bridge.register(createAdapter(name));
  await bridge.start();
  console.log(`[im-bridge] 已启动。通道=${channels.join(',')} API=${apiBase} 下载域=${publicUrl}`);

  const shutdown = async (sig: string) => {
    console.log(`[im-bridge] 收到 ${sig}，正在退出（进行中任务的回推会丢失）`);
    await bridge.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e) => {
  console.error('[im-bridge] 启动失败：', e);
  process.exit(1);
});
