import type { IncomingMessage } from 'node:http';
import type { ChannelAdapter, InboundMessage } from '../channel.js';
import { sharedServer, type SharedHttpServer } from './http-util.js';

export interface WecomOptions {
  /** 回调监听端口（env WECOM_PORT，默认 3210，可与钉钉/飞书共享同一端口） */
  port?: number;
  /** 群机器人 webhook（回推用，env WECOM_WEBHOOK_URL）；未配置则只打日志 */
  webhookUrl?: string;
}

/**
 * 企业微信通道（HTTP 回调骨架）。
 *
 * 收：POST /wecom/callback，body 为明文 JSON { chatId, userId, text }。
 *   真实企微回调是 XML + AES 加密，需在企微后台配置回调 URL、Token、EncodingAESKey：
 *   - GET 验证：解密 echostr 后原样回显；
 *   - POST 消息：先校验 msg_signature，再用 EncodingAESKey 做 AES-256-CBC 解密取明文 XML。
 *   本骨架未实现解密（见 verifySignature 的 TODO），当前只接受已解密的明文 JSON，
 *   可由前置解密网关转发，或本地开发直接 curl 模拟。
 *   「只响应 @机器人」由企微本身保证（应用只会收到 @ 它的群消息事件），无需在此过滤。
 *
 * 发：POST 群机器人 webhook（markdown 消息）。注意群机器人 webhook 绑定在固定群上，
 *   chatId 实际不参与寻址；要按 chatId 精确回到任意会话需换成企业应用消息 API
 *  （access_token + appchat/send），留作后续任务。
 */
export class WecomAdapter implements ChannelAdapter {
  readonly name = 'wecom';
  private server?: SharedHttpServer;

  constructor(private opts: WecomOptions = {}) {}

  async start(onMessage: (msg: InboundMessage) => Promise<void>): Promise<void> {
    const port = this.opts.port ?? Number(process.env.WECOM_PORT ?? 3210);
    this.server = sharedServer(port);
    this.server.route('POST', '/wecom/callback', (body, req) => {
      if (!verifySignature(req)) return { errcode: -1, errmsg: 'bad signature' };
      const msg = body as Partial<InboundMessage> | undefined;
      if (!msg || typeof msg.chatId !== 'string' || typeof msg.text !== 'string') {
        return { errcode: -1, errmsg: '期望 JSON { chatId, userId, text }' };
      }
      // 企微要求回调 5 秒内应答：先应答，任务处理异步进行
      void onMessage({
        channel: this.name,
        chatId: msg.chatId,
        userId: msg.userId ?? 'unknown',
        text: msg.text,
      }).catch((e) => console.error('[wecom] 消息处理失败：', e));
      return { errcode: 0 };
    });
    await this.server.acquire();
  }

  async sendText(chatId: string, text: string): Promise<void> {
    const url = this.opts.webhookUrl ?? process.env.WECOM_WEBHOOK_URL;
    if (!url) {
      console.log(`[wecom] 未配置 WECOM_WEBHOOK_URL，仅打日志 → ${chatId}:\n${text}`);
      return;
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { content: text } }),
    });
    if (!res.ok) throw new Error(`企微 webhook 回推失败：HTTP ${res.status}`);
  }

  async stop(): Promise<void> {
    await this.server?.release();
    this.server = undefined;
  }
}

/**
 * TODO(企微签名校验)：需要企微后台配置的 Token 与 EncodingAESKey。
 * 真实算法：msg_signature === sha1(sort(token, timestamp, nonce, encrypt)) ，
 * 校验通过后再 AES-256-CBC 解密 encrypt 字段。当前骨架直接放行（仅限内网/开发环境使用）。
 */
export function verifySignature(_req: IncomingMessage): boolean {
  return true; // TODO: 配置 WECOM_TOKEN / WECOM_AES_KEY 后实现真实校验与解密
}
