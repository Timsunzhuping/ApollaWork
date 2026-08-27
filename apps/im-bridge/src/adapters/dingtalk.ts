import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { ChannelAdapter, InboundMessage } from '../channel.js';
import { sharedServer, type SharedHttpServer } from './http-util.js';

export interface DingTalkOptions {
  /** 回调监听端口（env DINGTALK_PORT，默认 3210，可与企微/飞书共享） */
  port?: number;
  /** 自定义机器人 webhook（env DINGTALK_WEBHOOK_URL）；未配置则只打日志 */
  webhookUrl?: string;
  /** 机器人「加签」密钥（env DINGTALK_SECRET）；配置后 webhook 附加 timestamp+sign */
  secret?: string;
}

/**
 * 钉钉签名（自定义机器人「加签」/ outgoing 机器人共用同一算法）：
 * sign = base64( HMAC-SHA256( `${timestamp}\n${secret}`, key = secret ) )
 */
export function dingtalkSign(timestampMs: number | string, secret: string): string {
  return crypto
    .createHmac('sha256', secret)
    .update(`${timestampMs}\n${secret}`, 'utf8')
    .digest('base64');
}

/**
 * 钉钉通道（HTTP 回调骨架）。
 *
 * 收：POST /dingtalk/callback。兼容两种 body：
 *   1) 明文 JSON { chatId, userId, text }（开发/网关转发用）；
 *   2) 钉钉 outgoing 机器人原生消息 { conversationId, senderStaffId, text: { content } }。
 *   outgoing 机器人只会推送 @机器人 的消息，无需在此过滤。
 * 发：POST 自定义机器人 webhook（markdown 消息）；配置 DINGTALK_SECRET 时按「加签」
 *   规则在 URL 上附加 timestamp + sign（算法见 dingtalkSign，已实现）。
 *   与企微同理，webhook 绑定固定群，chatId 不参与寻址。
 */
export class DingTalkAdapter implements ChannelAdapter {
  readonly name = 'dingtalk';
  private server?: SharedHttpServer;

  constructor(private opts: DingTalkOptions = {}) {}

  async start(onMessage: (msg: InboundMessage) => Promise<void>): Promise<void> {
    const port = this.opts.port ?? Number(process.env.DINGTALK_PORT ?? 3210);
    this.server = sharedServer(port);
    this.server.route('POST', '/dingtalk/callback', (body, req) => {
      if (!this.verifyInbound(req)) return { errcode: -1, errmsg: 'bad signature' };
      const msg = this.parseInbound(body);
      if (!msg) return { errcode: -1, errmsg: '无法解析消息体' };
      // 先应答回调，任务处理异步进行
      void onMessage(msg).catch((e) => console.error('[dingtalk] 消息处理失败：', e));
      return { errcode: 0 };
    });
    await this.server.acquire();
  }

  /** 兼容明文 JSON 与钉钉 outgoing 原生消息两种形态 */
  private parseInbound(body: unknown): InboundMessage | null {
    const b = body as Record<string, unknown> | undefined;
    if (!b) return null;
    if (typeof b.chatId === 'string' && typeof b.text === 'string') {
      return {
        channel: this.name,
        chatId: b.chatId,
        userId: typeof b.userId === 'string' ? b.userId : 'unknown',
        text: b.text,
      };
    }
    const content = (b.text as { content?: string } | undefined)?.content;
    if (typeof b.conversationId === 'string' && typeof content === 'string') {
      return {
        channel: this.name,
        chatId: b.conversationId,
        userId: typeof b.senderStaffId === 'string' ? b.senderStaffId : 'unknown',
        text: content.trim(),
      };
    }
    return null;
  }

  /**
   * TODO(钉钉入向校验)：outgoing 机器人回调头部带 timestamp 与 sign，
   * 应校验 sign === dingtalkSign(timestamp, appSecret) 且 |now - timestamp| < 1h。
   * 签名算法已在 dingtalkSign 实现，待配置 outgoing 的 appSecret 后接上。当前放行。
   */
  private verifyInbound(_req: IncomingMessage): boolean {
    return true;
  }

  async sendText(chatId: string, text: string): Promise<void> {
    const base = this.opts.webhookUrl ?? process.env.DINGTALK_WEBHOOK_URL;
    if (!base) {
      console.log(`[dingtalk] 未配置 DINGTALK_WEBHOOK_URL，仅打日志 → ${chatId}:\n${text}`);
      return;
    }
    const url = new URL(base);
    const secret = this.opts.secret ?? process.env.DINGTALK_SECRET;
    if (secret) {
      // 「加签」安全设置：URL 附加毫秒时间戳与签名
      const ts = Date.now();
      url.searchParams.set('timestamp', String(ts));
      url.searchParams.set('sign', dingtalkSign(ts, secret));
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { title: 'Apolla', text } }),
    });
    if (!res.ok) throw new Error(`钉钉 webhook 回推失败：HTTP ${res.status}`);
  }

  async stop(): Promise<void> {
    await this.server?.release();
    this.server = undefined;
  }
}
