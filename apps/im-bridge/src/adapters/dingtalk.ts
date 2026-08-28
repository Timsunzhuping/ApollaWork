import crypto from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { ChannelAdapter, InboundMessage } from '../channel.js';
import { replyText, sharedServer, type RouteContext, type SharedHttpServer } from './http-util.js';
import {
  checkFreshness,
  headerValue,
  insecurePlaintextEnabled,
  timingSafeEqualStr,
  verifyFail,
  verifyOk,
  warnRejected,
  type VerifyResult,
} from './verify-util.js';

export interface DingTalkOptions {
  /** 回调监听端口（env DINGTALK_PORT，默认 3210，可与企微/飞书共享） */
  port?: number;
  /** 自定义机器人 webhook（env DINGTALK_WEBHOOK_URL）；未配置则只打日志 */
  webhookUrl?: string;
  /** 机器人「加签」密钥（env DINGTALK_SECRET）；配置后 webhook 附加 timestamp+sign */
  secret?: string;
  /** outgoing 机器人的 appSecret（env DINGTALK_APP_SECRET），用于**入向**验签 */
  appSecret?: string;
  /** 明文开发开关（env DINGTALK_INSECURE_PLAINTEXT=1）；生产绝不可开 */
  insecurePlaintext?: boolean;
}

/**
 * 钉钉签名（自定义机器人「加签」/ outgoing 机器人共用同一算法）：
 * sign = base64( HMAC-SHA256( `${timestamp}\n${secret}`, key = secret ) )
 * 注意 timestamp 必须用原始字符串参与拼接，不能归一化后再拼。
 */
export function dingtalkSign(timestampMs: number | string, secret: string): string {
  return crypto
    .createHmac('sha256', secret)
    .update(`${timestampMs}\n${secret}`, 'utf8')
    .digest('base64');
}

/**
 * 钉钉 outgoing 机器人入向验签：请求头 `timestamp` + `sign`。
 * 校验点：① 头齐全 ② 时间戳在 ±5 分钟内（防重放）③ sign 与本地计算一致（定长比较）。
 */
export function verifyDingtalkInbound(
  headers: IncomingHttpHeaders,
  appSecret: string,
  now: number = Date.now(),
): VerifyResult<number> {
  const timestamp = headerValue(headers, 'timestamp');
  const sign = headerValue(headers, 'sign');
  if (!timestamp || !sign) return verifyFail('缺少 timestamp / sign 请求头');
  const fresh = checkFreshness(timestamp, now);
  if (!fresh.ok) return verifyFail(fresh.reason);
  if (!timingSafeEqualStr(sign, dingtalkSign(timestamp, appSecret))) {
    return verifyFail('sign 与本地计算不一致');
  }
  return verifyOk(fresh.value);
}

/**
 * 钉钉通道。
 *
 * 收：`POST /dingtalk/callback`，验签通过后解析 outgoing 机器人原生消息
 *   `{conversationId, senderStaffId, text:{content}}`（outgoing 只推送 @机器人 的消息）。
 *   安全默认值：**未配置 `DINGTALK_APP_SECRET` 时拒绝一切回调**；本地开发要收明文 JSON
 *   `{chatId,userId,text}`，须显式设 `DINGTALK_INSECURE_PLAINTEXT=1`。
 * 发：POST 自定义机器人 webhook（markdown 消息）；配置 DINGTALK_SECRET 时按「加签」
 *   规则在 URL 上附加 timestamp + sign。与企微同理，webhook 绑定固定群，chatId 不参与寻址。
 */
export class DingTalkAdapter implements ChannelAdapter {
  readonly name = 'dingtalk';
  private server?: SharedHttpServer;
  private appSecret = '';

  constructor(private opts: DingTalkOptions = {}) {}

  async start(onMessage: (msg: InboundMessage) => Promise<void>): Promise<void> {
    const port = this.opts.port ?? Number(process.env.DINGTALK_PORT ?? 3210);
    this.appSecret = (this.opts.appSecret ?? process.env.DINGTALK_APP_SECRET ?? '').trim();
    if (!this.appSecret) {
      console.warn(
        this.insecure()
          ? '[dingtalk] ⚠️ DINGTALK_INSECURE_PLAINTEXT=1 已开启，将接受未验签的明文回调（仅限本地开发）'
          : '[dingtalk] 未配置 DINGTALK_APP_SECRET，所有回调将被拒绝（安全默认值）',
      );
    }
    this.server = sharedServer(port);
    this.server.route('POST', '/dingtalk/callback', (ctx) => this.handleCallback(ctx, onMessage));
    await this.server.acquire();
  }

  private insecure(): boolean {
    return this.opts.insecurePlaintext ?? insecurePlaintextEnabled('DINGTALK_INSECURE_PLAINTEXT');
  }

  private handleCallback(
    ctx: RouteContext,
    onMessage: (msg: InboundMessage) => Promise<void>,
  ): unknown {
    const { body, req, res } = ctx;
    if (this.appSecret) {
      const result = verifyDingtalkInbound(req.headers, this.appSecret);
      if (!result.ok) {
        warnRejected('dingtalk', result.reason, req);
        replyText(res, 401, 'invalid signature');
        return undefined;
      }
    } else if (!this.insecure()) {
      warnRejected('dingtalk', '未配置 DINGTALK_APP_SECRET，安全默认值拒绝回调', req);
      replyText(res, 401, 'callback not configured');
      return undefined;
    }
    const msg = this.parseInbound(body);
    if (!msg) return { errcode: -1, errmsg: '无法解析消息体' };
    // 先应答回调，任务处理异步进行
    void onMessage(msg).catch((e) => console.error('[dingtalk] 消息处理失败：', e));
    return { errcode: 0 };
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
    this.appSecret = '';
  }
}
