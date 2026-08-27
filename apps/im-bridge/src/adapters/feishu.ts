import type { ChannelAdapter, InboundMessage } from '../channel.js';
import { sharedServer, type SharedHttpServer } from './http-util.js';

export interface FeishuOptions {
  /** 回调监听端口（env FEISHU_PORT，默认 3210，可与企微/钉钉共享） */
  port?: number;
  /** 自定义机器人 webhook（env FEISHU_WEBHOOK_URL）；未配置则只打日志 */
  webhookUrl?: string;
}

/** 飞书事件订阅 v2 的消息事件（只声明用到的字段） */
interface FeishuEventBody {
  type?: string;
  challenge?: string;
  header?: { event_type?: string };
  event?: {
    sender?: { sender_id?: { open_id?: string } };
    message?: { chat_id?: string; message_type?: string; content?: string };
  };
}

/**
 * 飞书通道（HTTP 回调骨架）。
 *
 * 收：POST /feishu/callback：
 *   - url_verification：飞书配置事件订阅 URL 时的握手，原样回显 challenge（已实现）；
 *   - im.message.receive_v1：事件订阅推送的消息事件，best-effort 解析 chat_id /
 *     open_id / content.text（content 是 JSON 字符串），并去掉 @_user_N 占位；
 *   - 明文 JSON { chatId, userId, text }（开发/网关转发用）。
 *   TODO：真实环境需校验 Verification Token，配置了 Encrypt Key 时 body 是
 *   {"encrypt": "..."} 需 AES-256-CBC 解密；「仅 @机器人 触发」应结合
 *   event.message.mentions 判断（订阅「接收群聊中 @机器人 消息」事件时飞书已过滤）。
 * 发：POST 自定义机器人 webhook：{ msg_type: 'text', content: { text } }。
 */
export class FeishuAdapter implements ChannelAdapter {
  readonly name = 'feishu';
  private server?: SharedHttpServer;

  constructor(private opts: FeishuOptions = {}) {}

  async start(onMessage: (msg: InboundMessage) => Promise<void>): Promise<void> {
    const port = this.opts.port ?? Number(process.env.FEISHU_PORT ?? 3210);
    this.server = sharedServer(port);
    this.server.route('POST', '/feishu/callback', (body) => {
      const b = (body ?? {}) as FeishuEventBody & Partial<InboundMessage>;
      // 1) URL 校验握手：回显 challenge
      if (b.type === 'url_verification' && typeof b.challenge === 'string') {
        return { challenge: b.challenge };
      }
      const msg = this.parseInbound(b);
      if (!msg) return { code: -1, msg: '无法解析消息体' };
      // 先应答回调（飞书要求 3s 内），任务处理异步进行
      void onMessage(msg).catch((e) => console.error('[feishu] 消息处理失败：', e));
      return { code: 0 };
    });
    await this.server.acquire();
  }

  /** 兼容明文 JSON 与飞书事件订阅 v2 两种形态 */
  private parseInbound(b: FeishuEventBody & Partial<InboundMessage>): InboundMessage | null {
    if (typeof b.chatId === 'string' && typeof b.text === 'string') {
      return {
        channel: this.name,
        chatId: b.chatId,
        userId: typeof b.userId === 'string' ? b.userId : 'unknown',
        text: b.text,
      };
    }
    if (b.header?.event_type === 'im.message.receive_v1' && b.event?.message?.chat_id) {
      const m = b.event.message;
      let text = '';
      try {
        // content 是 JSON 字符串，text 消息形如 {"text":"@_user_1 帮我调研..."}
        text = String((JSON.parse(m.content ?? '{}') as { text?: string }).text ?? '');
      } catch {
        return null;
      }
      text = text.replace(/@_user_\d+\s*/g, '').trim();
      if (!text) return null;
      return {
        channel: this.name,
        chatId: m.chat_id!,
        userId: b.event.sender?.sender_id?.open_id ?? 'unknown',
        text,
      };
    }
    return null;
  }

  async sendText(chatId: string, text: string): Promise<void> {
    const url = this.opts.webhookUrl ?? process.env.FEISHU_WEBHOOK_URL;
    if (!url) {
      console.log(`[feishu] 未配置 FEISHU_WEBHOOK_URL，仅打日志 → ${chatId}:\n${text}`);
      return;
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: { text } }),
    });
    if (!res.ok) throw new Error(`飞书 webhook 回推失败：HTTP ${res.status}`);
  }

  async stop(): Promise<void> {
    await this.server?.release();
    this.server = undefined;
  }
}
