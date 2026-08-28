import crypto from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { ChannelAdapter, InboundMessage } from '../channel.js';
import { replyText, sharedServer, type RouteContext, type SharedHttpServer } from './http-util.js';
import {
  checkFreshness,
  headerValue,
  insecurePlaintextEnabled,
  padPkcs7,
  stripPkcs7,
  timingSafeEqualStr,
  verifyFail,
  verifyOk,
  warnRejected,
  type VerifyResult,
} from './verify-util.js';

export interface FeishuOptions {
  /** 回调监听端口（env FEISHU_PORT，默认 3210，可与企微/钉钉共享） */
  port?: number;
  /** 自定义机器人 webhook（env FEISHU_WEBHOOK_URL）；未配置则只打日志 */
  webhookUrl?: string;
  /** 事件订阅 Encrypt Key（env FEISHU_ENCRYPT_KEY）：既用于验签也用于解密 */
  encryptKey?: string;
  /** 事件订阅 Verification Token（env FEISHU_VERIFICATION_TOKEN） */
  verificationToken?: string;
  /** 明文开发开关（env FEISHU_INSECURE_PLAINTEXT=1）；生产绝不可开 */
  insecurePlaintext?: boolean;
}

/** 飞书事件订阅 v2 的消息事件（只声明用到的字段） */
interface FeishuEventBody {
  type?: string;
  challenge?: string;
  token?: string;
  header?: { event_type?: string; token?: string };
  event?: {
    sender?: { sender_id?: { open_id?: string } };
    message?: { chat_id?: string; message_type?: string; content?: string };
  };
}

/** 验签/解密所需凭据；两个都空 = 未配置（拒绝一切回调） */
export interface FeishuVerifyConfig {
  encryptKey?: string;
  verificationToken?: string;
}

export function loadFeishuVerifyConfig(
  opts: FeishuOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): FeishuVerifyConfig {
  return {
    encryptKey: (opts.encryptKey ?? env.FEISHU_ENCRYPT_KEY ?? '').trim() || undefined,
    verificationToken:
      (opts.verificationToken ?? env.FEISHU_VERIFICATION_TOKEN ?? '').trim() || undefined,
  };
}

/** 飞书事件签名：sha256(timestamp + nonce + encryptKey + rawBody)，十六进制 */
export function feishuSignature(
  timestamp: string,
  nonce: string,
  encryptKey: string,
  rawBody: string,
): string {
  return crypto
    .createHash('sha256')
    .update(`${timestamp}${nonce}${encryptKey}${rawBody}`, 'utf8')
    .digest('hex');
}

/** 飞书 AES-256-CBC 解密：key = sha256(encryptKey)，密文 base64，前 16 字节是 iv */
export function feishuDecrypt(encrypt: string, encryptKey: string): string {
  const key = crypto.createHash('sha256').update(encryptKey, 'utf8').digest();
  const buf = Buffer.from(encrypt, 'base64');
  if (buf.length < 32 || buf.length % 16 !== 0) throw new Error('密文长度非法');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, buf.subarray(0, 16));
  decipher.setAutoPadding(false);
  const raw = Buffer.concat([decipher.update(buf.subarray(16)), decipher.final()]);
  return stripPkcs7(raw, 16).toString('utf8');
}

/** 飞书 AES-256-CBC 加密（测试与联调构造密文用） */
export function feishuEncrypt(plain: string, encryptKey: string, iv?: Buffer): string {
  const key = crypto.createHash('sha256').update(encryptKey, 'utf8').digest();
  const vector = iv ?? crypto.randomBytes(16);
  if (vector.length !== 16) throw new Error('iv 必须是 16 字节');
  const cipher = crypto.createCipheriv('aes-256-cbc', key, vector);
  cipher.setAutoPadding(false);
  const padded = padPkcs7(Buffer.from(plain, 'utf8'), 16);
  return Buffer.concat([vector, cipher.update(padded), cipher.final()]).toString('base64');
}

/**
 * 飞书入向验签，返回**已解密**的事件 body。
 *
 * 顺序：① 凭据是否配置 ② body 是否 JSON ③ 有 Encrypt Key 时校验
 * `X-Lark-Signature = sha256(timestamp+nonce+encryptKey+rawBody)` 并做新鲜度检查；
 * 没有签名头则要求 body 是 `{"encrypt": "..."}`（能解开即证明持有密钥）
 * ④ 解密 ⑤ 配了 Verification Token 时校验 body 里的 token（v1 顶层 / v2 在 header 内）。
 */
export function verifyFeishuRequest(
  headers: IncomingHttpHeaders,
  rawBody: string,
  cfg: FeishuVerifyConfig,
  now: number = Date.now(),
): VerifyResult<Record<string, unknown>> {
  if (!cfg.encryptKey && !cfg.verificationToken) {
    return verifyFail('未配置 FEISHU_ENCRYPT_KEY / FEISHU_VERIFICATION_TOKEN');
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody || '') as Record<string, unknown>;
  } catch {
    return verifyFail('body 不是合法 JSON');
  }
  if (!body || typeof body !== 'object') return verifyFail('body 不是 JSON 对象');

  if (cfg.encryptKey) {
    const signature = headerValue(headers, 'x-lark-signature');
    const timestamp = headerValue(headers, 'x-lark-request-timestamp');
    const nonce = headerValue(headers, 'x-lark-request-nonce');
    const encrypted = typeof body.encrypt === 'string' ? body.encrypt : undefined;
    if (signature) {
      if (!timestamp || !nonce) return verifyFail('缺少 X-Lark-Request-Timestamp / Nonce');
      const fresh = checkFreshness(timestamp, now);
      if (!fresh.ok) return verifyFail(fresh.reason);
      if (
        !timingSafeEqualStr(signature, feishuSignature(timestamp, nonce, cfg.encryptKey, rawBody))
      ) {
        return verifyFail('X-Lark-Signature 与本地计算不一致');
      }
    } else if (!encrypted) {
      // 配了 Encrypt Key 却既无签名头又非密文 body：只可能是伪造请求
      return verifyFail('缺少 X-Lark-Signature 且 body 未加密');
    }
    if (encrypted) {
      try {
        const plain = JSON.parse(feishuDecrypt(encrypted, cfg.encryptKey)) as Record<
          string,
          unknown
        >;
        if (!plain || typeof plain !== 'object') return verifyFail('解密结果不是 JSON 对象');
        body = plain;
      } catch (e) {
        return verifyFail(`body 解密失败：${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  if (cfg.verificationToken) {
    const header = body.header as { token?: string } | undefined;
    const token = typeof body.token === 'string' ? body.token : header?.token;
    if (!timingSafeEqualStr(token, cfg.verificationToken)) {
      return verifyFail('verification token 不匹配');
    }
  }
  return verifyOk(body);
}

/**
 * 飞书通道。
 *
 * 收：`POST /feishu/callback`（先验签再解析）：
 *   - `url_verification` 握手：配了 Encrypt Key 时 body 是 `{"encrypt":"..."}`，
 *     解密后回显 challenge；明文形态直接回显。
 *   - `im.message.receive_v1`：解析 chat_id / open_id / content.text（content 是 JSON
 *     字符串），并去掉 `@_user_N` 占位。
 *   安全默认值：**未配置 `FEISHU_ENCRYPT_KEY` 或 `FEISHU_VERIFICATION_TOKEN` 时拒绝一切回调**；
 *   本地开发要收明文 JSON `{chatId,userId,text}`，须显式设 `FEISHU_INSECURE_PLAINTEXT=1`。
 * 发：POST 自定义机器人 webhook：{ msg_type: 'text', content: { text } }。
 */
export class FeishuAdapter implements ChannelAdapter {
  readonly name = 'feishu';
  private server?: SharedHttpServer;
  private verifyCfg: FeishuVerifyConfig = {};

  constructor(private opts: FeishuOptions = {}) {}

  async start(onMessage: (msg: InboundMessage) => Promise<void>): Promise<void> {
    const port = this.opts.port ?? Number(process.env.FEISHU_PORT ?? 3210);
    this.verifyCfg = loadFeishuVerifyConfig(this.opts);
    if (!this.configured()) {
      console.warn(
        this.insecure()
          ? '[feishu] ⚠️ FEISHU_INSECURE_PLAINTEXT=1 已开启，将接受未验签的明文回调（仅限本地开发）'
          : '[feishu] 未配置 FEISHU_ENCRYPT_KEY / FEISHU_VERIFICATION_TOKEN，所有回调将被拒绝（安全默认值）',
      );
    } else if (!this.verifyCfg.encryptKey) {
      console.warn(
        '[feishu] 只配置了 Verification Token（弱校验），建议同时配置 Encrypt Key 启用签名',
      );
    }
    this.server = sharedServer(port);
    this.server.route('POST', '/feishu/callback', (ctx) => this.handleCallback(ctx, onMessage));
    await this.server.acquire();
  }

  private configured(): boolean {
    return Boolean(this.verifyCfg.encryptKey || this.verifyCfg.verificationToken);
  }

  private insecure(): boolean {
    return this.opts.insecurePlaintext ?? insecurePlaintextEnabled('FEISHU_INSECURE_PLAINTEXT');
  }

  private handleCallback(
    ctx: RouteContext,
    onMessage: (msg: InboundMessage) => Promise<void>,
  ): unknown {
    const { body, raw, req, res } = ctx;
    let effective: FeishuEventBody & Partial<InboundMessage>;
    if (this.configured()) {
      const result = verifyFeishuRequest(req.headers, raw, this.verifyCfg);
      if (!result.ok) {
        warnRejected('feishu', result.reason, req);
        replyText(res, 401, 'invalid signature');
        return undefined;
      }
      effective = result.value as FeishuEventBody & Partial<InboundMessage>;
    } else {
      if (!this.insecure()) {
        warnRejected(
          'feishu',
          '未配置 FEISHU_ENCRYPT_KEY / FEISHU_VERIFICATION_TOKEN，安全默认值拒绝回调',
          req,
        );
        replyText(res, 401, 'callback not configured');
        return undefined;
      }
      effective = (body ?? {}) as FeishuEventBody & Partial<InboundMessage>;
    }

    // 1) URL 校验握手：回显 challenge
    if (effective.type === 'url_verification' && typeof effective.challenge === 'string') {
      return { challenge: effective.challenge };
    }
    const msg = this.parseInbound(effective);
    if (!msg) return { code: -1, msg: '无法解析消息体' };
    // 先应答回调（飞书要求 3s 内），任务处理异步进行
    void onMessage(msg).catch((e) => console.error('[feishu] 消息处理失败：', e));
    return { code: 0 };
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
    this.verifyCfg = {};
  }
}
