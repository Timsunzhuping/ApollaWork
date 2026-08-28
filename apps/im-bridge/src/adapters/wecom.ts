import crypto from 'node:crypto';
import type { ChannelAdapter, InboundMessage } from '../channel.js';
import { replyText, sharedServer, type RouteContext, type SharedHttpServer } from './http-util.js';
import {
  checkFreshness,
  insecurePlaintextEnabled,
  padPkcs7,
  stripPkcs7,
  timingSafeEqualStr,
  verifyFail,
  verifyOk,
  warnRejected,
  type VerifyResult,
} from './verify-util.js';

export interface WecomOptions {
  /** 回调监听端口（env WECOM_PORT，默认 3210，可与钉钉/飞书共享同一端口） */
  port?: number;
  /** 群机器人 webhook（回推用，env WECOM_WEBHOOK_URL）；未配置则只打日志 */
  webhookUrl?: string;
  /** 回调 Token（env WECOM_TOKEN） */
  token?: string;
  /** 43 位 EncodingAESKey（env WECOM_AES_KEY） */
  encodingAesKey?: string;
  /** 企业 CorpID，即密文尾部的 receiveid（env WECOM_CORP_ID）；配置后强制校验 */
  corpId?: string;
  /** 明文开发开关（env WECOM_INSECURE_PLAINTEXT=1）；生产绝不可开 */
  insecurePlaintext?: boolean;
}

/** 验签 + 解密所需的一组凭据 */
export interface WecomCrypto {
  token: string;
  /** base64decode(EncodingAESKey + '=')，32 字节 */
  aesKey: Buffer;
  /** 期望的 receiveid（CorpID）；空串表示不校验 */
  receiveId: string;
}

/** EncodingAESKey（43 位 base64）→ 32 字节 AES key */
export function decodeWecomAesKey(encodingAesKey: string): Buffer {
  const key = Buffer.from(`${encodingAesKey.trim()}=`, 'base64');
  if (key.length !== 32) {
    throw new Error('WECOM_AES_KEY 必须是 43 位 EncodingAESKey（base64 解出 32 字节）');
  }
  return key;
}

/**
 * 从环境变量/选项装载企微凭据。缺 Token 或 AESKey 返回 null（调用方据此拒绝所有回调）；
 * AESKey 格式错误抛错（配置错误要让运维看见，而不是静默降级）。
 */
export function loadWecomCrypto(
  opts: WecomOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): WecomCrypto | null {
  const token = (opts.token ?? env.WECOM_TOKEN ?? '').trim();
  const aesKeyRaw = (opts.encodingAesKey ?? env.WECOM_AES_KEY ?? '').trim();
  if (!token || !aesKeyRaw) return null;
  return {
    token,
    aesKey: decodeWecomAesKey(aesKeyRaw),
    receiveId: (opts.corpId ?? env.WECOM_CORP_ID ?? '').trim(),
  };
}

/** 企微签名：sha1( sort([token, timestamp, nonce, encrypt]).join('') ) */
export function wecomSignature(
  token: string,
  timestamp: string,
  nonce: string,
  encrypt: string,
): string {
  return crypto
    .createHash('sha1')
    .update([token, timestamp, nonce, encrypt].sort().join(''), 'utf8')
    .digest('hex');
}

/**
 * 企微 AES-256-CBC 加密（iv = key 前 16 字节）。
 * 明文结构：random(16) || msgLen(4, 网络序) || msg || receiveid，再按 32 字节补 PKCS#7。
 * 主要给测试与联调构造合法密文用（真实回推走 webhook，不需要加密）。
 */
export function wecomEncrypt(
  plain: string,
  aesKey: Buffer,
  receiveId: string,
  random?: Buffer,
): string {
  const rand = random ?? crypto.randomBytes(16);
  if (rand.length !== 16) throw new Error('随机前缀必须是 16 字节');
  const msg = Buffer.from(plain, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(msg.length, 0);
  const raw = padPkcs7(Buffer.concat([rand, len, msg, Buffer.from(receiveId, 'utf8')]), 32);
  const cipher = crypto.createCipheriv('aes-256-cbc', aesKey, aesKey.subarray(0, 16));
  cipher.setAutoPadding(false); // 企微按 32 字节分组补位，不能用 node 的 16 字节自动补位
  return Buffer.concat([cipher.update(raw), cipher.final()]).toString('base64');
}

/**
 * 企微 AES-256-CBC 解密：去 16 字节随机前缀、读 4 字节网络序长度、校验尾部 receiveid。
 * 任何一步不合法都抛错（伪造密文解出来的是随机字节，基本必定在这里失败）。
 */
export function wecomDecrypt(encrypted: string, aesKey: Buffer, expectReceiveId = ''): string {
  const cipherText = Buffer.from(encrypted, 'base64');
  if (cipherText.length === 0 || cipherText.length % 16 !== 0) throw new Error('密文长度非法');
  const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, aesKey.subarray(0, 16));
  decipher.setAutoPadding(false);
  const raw = stripPkcs7(Buffer.concat([decipher.update(cipherText), decipher.final()]), 32);
  if (raw.length < 20) throw new Error('明文长度不足 20 字节');
  const msgLen = raw.readUInt32BE(16);
  if (msgLen < 0 || 20 + msgLen > raw.length) throw new Error('明文长度字段越界');
  const message = raw.subarray(20, 20 + msgLen).toString('utf8');
  const receiveId = raw.subarray(20 + msgLen).toString('utf8');
  if (expectReceiveId && !timingSafeEqualStr(receiveId, expectReceiveId)) {
    throw new Error('receiveid 与 WECOM_CORP_ID 不一致');
  }
  return message;
}

/** 取 <Tag><![CDATA[..]]></Tag> 或 <Tag>..</Tag> 的文本（回调 XML 结构固定，正则足够，不引 xml 库） */
export function xmlField(xml: string, tag: string): string | undefined {
  const re = new RegExp(
    `<${tag}>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))\\s*</${tag}>`,
  );
  const m = re.exec(xml);
  if (!m) return undefined;
  return m[1] !== undefined ? m[1] : m[2];
}

/** 通用的「签名 + 新鲜度」校验：GET 校验用 echostr，POST 用 <Encrypt> 密文 */
function verifyWecomEnvelope(
  query: URLSearchParams,
  encrypt: string | undefined,
  crypto_: WecomCrypto,
  now: number,
): VerifyResult<string> {
  const signature = query.get('msg_signature') ?? undefined;
  const timestamp = query.get('timestamp') ?? undefined;
  const nonce = query.get('nonce') ?? undefined;
  if (!signature || !timestamp || !nonce) return verifyFail('缺少 msg_signature/timestamp/nonce');
  if (!encrypt) return verifyFail('缺少密文（echostr 或 <Encrypt>）');
  const fresh = checkFreshness(timestamp, now);
  if (!fresh.ok) return verifyFail(fresh.reason);
  const expected = wecomSignature(crypto_.token, timestamp, nonce, encrypt);
  if (!timingSafeEqualStr(signature, expected)) return verifyFail('msg_signature 与本地计算不一致');
  return verifyOk(encrypt);
}

/** GET URL 校验：验签后解密 echostr，返回应原样回显的明文 */
export function verifyWecomEcho(
  query: URLSearchParams,
  cfg: WecomCrypto,
  now: number = Date.now(),
): VerifyResult<string> {
  const env = verifyWecomEnvelope(query, query.get('echostr') ?? undefined, cfg, now);
  if (!env.ok) return env;
  try {
    return verifyOk(wecomDecrypt(env.value, cfg.aesKey, cfg.receiveId));
  } catch (e) {
    return verifyFail(`echostr 解密失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

/** POST 消息回调：验签后解密 <Encrypt>，返回明文 XML */
export function verifyWecomCallback(
  query: URLSearchParams,
  rawXmlBody: string,
  cfg: WecomCrypto,
  now: number = Date.now(),
): VerifyResult<string> {
  const encrypt = xmlField(rawXmlBody, 'Encrypt');
  const env = verifyWecomEnvelope(query, encrypt, cfg, now);
  if (!env.ok) return env;
  try {
    return verifyOk(wecomDecrypt(env.value, cfg.aesKey, cfg.receiveId));
  } catch (e) {
    return verifyFail(`消息解密失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 明文 XML → InboundMessage；非文本消息返回 null（照常回 200，避免企微重试） */
export function parseWecomMessage(xml: string): InboundMessage | null {
  const msgType = xmlField(xml, 'MsgType');
  if (msgType && msgType !== 'text') return null;
  const from = xmlField(xml, 'FromUserName');
  const content = xmlField(xml, 'Content');
  // 群聊有 ChatId，单聊回落到发送者
  const chatId = xmlField(xml, 'ChatId') || from;
  if (!content || !chatId) return null;
  const text = content.trim();
  if (!text) return null;
  return { channel: 'wecom', chatId, userId: from || 'unknown', text };
}

/**
 * 企业微信通道。
 *
 * 收：
 *   - `GET /wecom/callback`：企微后台保存回调 URL 时的校验。校验
 *     `msg_signature == sha1(sort(token, timestamp, nonce, echostr))` 后 AES 解密 echostr 明文回显。
 *   - `POST /wecom/callback`：XML body 含 `<Encrypt>`，同样验签后 AES-256-CBC 解密
 *     （key = base64decode(EncodingAESKey+'=')，iv = key 前 16 字节），得明文 XML 再解字段。
 *
 * 安全默认值：**未配置 `WECOM_TOKEN` + `WECOM_AES_KEY` 时拒绝一切回调**。
 * 本地开发要走明文 JSON `{chatId,userId,text}`，须显式设 `WECOM_INSECURE_PLAINTEXT=1`。
 *
 * 发：POST 群机器人 webhook（markdown 消息）。注意群机器人 webhook 绑定在固定群上，
 *   chatId 实际不参与寻址；要按 chatId 精确回到任意会话需换成企业应用消息 API
 *  （access_token + appchat/send），留作后续任务。
 */
export class WecomAdapter implements ChannelAdapter {
  readonly name = 'wecom';
  private server?: SharedHttpServer;
  private cryptoCfg: WecomCrypto | null = null;

  constructor(private opts: WecomOptions = {}) {}

  async start(onMessage: (msg: InboundMessage) => Promise<void>): Promise<void> {
    const port = this.opts.port ?? Number(process.env.WECOM_PORT ?? 3210);
    try {
      this.cryptoCfg = loadWecomCrypto(this.opts);
    } catch (e) {
      // 配置错误按「未配置」处理（失败关闭），但要吼出来
      console.error(`[wecom] 凭据配置错误，回调将全部拒绝：${e instanceof Error ? e.message : e}`);
      this.cryptoCfg = null;
    }
    if (!this.cryptoCfg) {
      const hint = this.insecure()
        ? '⚠️ WECOM_INSECURE_PLAINTEXT=1 已开启，将接受未验签的明文 JSON（仅限本地开发）'
        : '未配置 WECOM_TOKEN / WECOM_AES_KEY，所有回调将被拒绝（安全默认值）';
      console.warn(`[wecom] ${hint}`);
    }
    this.server = sharedServer(port);
    this.server.route('GET', '/wecom/callback', (ctx) => this.handleEcho(ctx));
    this.server.route('POST', '/wecom/callback', (ctx) => this.handleCallback(ctx, onMessage));
    await this.server.acquire();
  }

  private insecure(): boolean {
    return this.opts.insecurePlaintext ?? insecurePlaintextEnabled('WECOM_INSECURE_PLAINTEXT');
  }

  /** GET：企微后台「保存」时的 URL 校验，必须回明文 echostr（纯文本，不能包 JSON） */
  private handleEcho(ctx: RouteContext): void {
    const { query, req, res } = ctx;
    if (!this.cryptoCfg) {
      warnRejected('wecom', '未配置 WECOM_TOKEN / WECOM_AES_KEY，无法完成 URL 校验', req);
      return replyText(res, 401, 'callback not configured');
    }
    const result = verifyWecomEcho(query, this.cryptoCfg);
    if (!result.ok) {
      warnRejected('wecom', `URL 校验失败：${result.reason}`, req);
      return replyText(res, 401, 'invalid signature');
    }
    console.log('[wecom] URL 校验通过');
    replyText(res, 200, result.value);
  }

  /** POST：真实回调（验签 + 解密）；仅在显式开发开关下退回明文 JSON */
  private handleCallback(
    ctx: RouteContext,
    onMessage: (msg: InboundMessage) => Promise<void>,
  ): unknown {
    const { body, raw, query, req, res } = ctx;
    const dispatch = (msg: InboundMessage) => {
      // 企微要求 5 秒内应答：先应答，任务处理异步进行
      void onMessage(msg).catch((e) => console.error('[wecom] 消息处理失败：', e));
    };

    if (this.cryptoCfg) {
      const result = verifyWecomCallback(query, raw, this.cryptoCfg);
      if (!result.ok) {
        warnRejected('wecom', result.reason, req);
        replyText(res, 401, 'invalid signature');
        return undefined;
      }
      const msg = parseWecomMessage(result.value);
      if (msg) dispatch(msg);
      else console.log('[wecom] 回调已验签，但不是可处理的文本消息，忽略');
      replyText(res, 200, 'success'); // 企微期望空串或 success
      return undefined;
    }

    if (!this.insecure()) {
      warnRejected('wecom', '未配置 WECOM_TOKEN / WECOM_AES_KEY，安全默认值拒绝回调', req);
      replyText(res, 401, 'callback not configured');
      return undefined;
    }

    // —— 仅开发：未验签的明文 JSON ——
    const msg = body as Partial<InboundMessage> | undefined;
    if (!msg || typeof msg.chatId !== 'string' || typeof msg.text !== 'string') {
      return { errcode: -1, errmsg: '期望 JSON { chatId, userId, text }' };
    }
    dispatch({
      channel: this.name,
      chatId: msg.chatId,
      userId: msg.userId ?? 'unknown',
      text: msg.text,
    });
    return { errcode: 0 };
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
    this.cryptoCfg = null;
  }
}
