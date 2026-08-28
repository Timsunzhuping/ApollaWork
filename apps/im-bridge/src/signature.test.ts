import { describe, expect, it } from 'vitest';
import type { IncomingHttpHeaders } from 'node:http';
import type { InboundMessage } from './channel.js';
import {
  WecomAdapter,
  decodeWecomAesKey,
  loadWecomCrypto,
  parseWecomMessage,
  verifyWecomCallback,
  verifyWecomEcho,
  wecomEncrypt,
  wecomSignature,
  xmlField,
  type WecomCrypto,
} from './adapters/wecom.js';
import { DingTalkAdapter, dingtalkSign, verifyDingtalkInbound } from './adapters/dingtalk.js';
import {
  FeishuAdapter,
  feishuEncrypt,
  feishuSignature,
  loadFeishuVerifyConfig,
  verifyFeishuRequest,
} from './adapters/feishu.js';
import { timingSafeEqualStr, toMillis } from './adapters/verify-util.js';

/**
 * 入向回调验签测试（P0 安全项）。全部离线：自己按各家规范构造合法请求，
 * 再逐项篡改（签名 / 密钥 / 时间戳 / body）断言被拒绝，最后跑一遍真实 HTTP 端点。
 */

// ——— 测试用固定凭据（非真实密钥） ———
const WECOM_TOKEN = 'apollaWecomToken';
const WECOM_AES_RAW = Buffer.alloc(32, 7); // 确定性 32 字节，便于断言 decode 结果
const WECOM_AES_KEY = WECOM_AES_RAW.toString('base64').replace(/=+$/, ''); // 43 位 EncodingAESKey
const WECOM_CORP_ID = 'wwapolla0001';
const WECOM_CFG: WecomCrypto = {
  token: WECOM_TOKEN,
  aesKey: WECOM_AES_RAW,
  receiveId: WECOM_CORP_ID,
};

const DINGTALK_APP_SECRET = 'dingtalkAppSecretForTest';
const FEISHU_ENCRYPT_KEY = 'feishuEncryptKeyForTest';
const FEISHU_VERIFY_TOKEN = 'feishuVerificationToken';

/** 企微明文消息 XML（群聊文本消息） */
function wecomPlainXml(content: string, chatId = 'chat_wecom_1'): string {
  return (
    '<xml><ToUserName><![CDATA[wwapolla0001]]></ToUserName>' +
    '<FromUserName><![CDATA[zhangsan]]></FromUserName>' +
    '<CreateTime>1348831860</CreateTime>' +
    '<MsgType><![CDATA[text]]></MsgType>' +
    `<Content><![CDATA[${content}]]></Content>` +
    '<MsgId>1234567890123456</MsgId><AgentID>1000002</AgentID>' +
    `<ChatId><![CDATA[${chatId}]]></ChatId></xml>`
  );
}

/** 按企微规范造一次合法回调：密文 XML body + 带 msg_signature 的 query */
function buildWecomCallback(
  plain: string,
  opts: { token?: string; aesKey?: Buffer; receiveId?: string; timestampSec?: number } = {},
) {
  const token = opts.token ?? WECOM_TOKEN;
  const aesKey = opts.aesKey ?? WECOM_AES_RAW;
  const receiveId = opts.receiveId ?? WECOM_CORP_ID;
  const timestamp = String(opts.timestampSec ?? Math.floor(Date.now() / 1000));
  const nonce = '1372623149';
  const encrypt = wecomEncrypt(plain, aesKey, receiveId, Buffer.alloc(16, 3));
  const query = new URLSearchParams({
    msg_signature: wecomSignature(token, timestamp, nonce, encrypt),
    timestamp,
    nonce,
  });
  const body = `<xml><ToUserName><![CDATA[${receiveId}]]></ToUserName><Encrypt><![CDATA[${encrypt}]]></Encrypt><AgentID><![CDATA[1000002]]></AgentID></xml>`;
  return { query, body, encrypt, timestamp, nonce };
}

/** 按飞书规范造一次合法事件请求（可选加密） */
function buildFeishuRequest(
  payload: unknown,
  opts: { encryptKey?: string; timestampSec?: number; encrypted?: boolean } = {},
) {
  const encryptKey = opts.encryptKey ?? FEISHU_ENCRYPT_KEY;
  const timestamp = String(opts.timestampSec ?? Math.floor(Date.now() / 1000));
  const nonce = 'nonce-abc-123';
  const raw = opts.encrypted
    ? JSON.stringify({
        encrypt: feishuEncrypt(JSON.stringify(payload), encryptKey, Buffer.alloc(16, 9)),
      })
    : JSON.stringify(payload);
  const headers: IncomingHttpHeaders = {
    'x-lark-request-timestamp': timestamp,
    'x-lark-request-nonce': nonce,
    'x-lark-signature': feishuSignature(timestamp, nonce, encryptKey, raw),
  };
  return { headers, raw, timestamp, nonce };
}

const FEISHU_MESSAGE_EVENT = {
  schema: '2.0',
  header: { event_type: 'im.message.receive_v1', token: FEISHU_VERIFY_TOKEN },
  event: {
    sender: { sender_id: { open_id: 'ou_apolla_1' } },
    message: {
      chat_id: 'oc_feishu_1',
      message_type: 'text',
      content: JSON.stringify({ text: '@_user_1 帮我调研竞品' }),
    },
  },
};

describe('公共验签原语', () => {
  it('timingSafeEqualStr：等值 true，长度不等/空串安全返回 false', () => {
    expect(timingSafeEqualStr('abcdef', 'abcdef')).toBe(true);
    expect(timingSafeEqualStr('abcdef', 'abcdeg')).toBe(false);
    expect(timingSafeEqualStr('abc', 'abcdef')).toBe(false); // 长度不等不能丢给 timingSafeEqual
    expect(timingSafeEqualStr(undefined, 'abc')).toBe(false);
    expect(timingSafeEqualStr('', '')).toBe(false);
  });

  it('toMillis：秒/毫秒自动归一，非法值返回 null', () => {
    expect(toMillis('1756339200')).toBe(1756339200000);
    expect(toMillis('1756339200000')).toBe(1756339200000);
    expect(toMillis('not-a-number')).toBeNull();
    expect(toMillis('-1')).toBeNull();
    expect(toMillis(undefined)).toBeNull();
  });
});

describe('企业微信回调验签与解密', () => {
  it('EncodingAESKey（43 位）解出 32 字节 AES key；长度不对直接报错', () => {
    expect(decodeWecomAesKey(WECOM_AES_KEY)).toEqual(WECOM_AES_RAW);
    expect(() => decodeWecomAesKey('tooshort')).toThrow(/43 位/);
  });

  it('GET URL 校验：合法 msg_signature → 解密 echostr 得明文', () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = '1372623149';
    const echostr = wecomEncrypt('apolla-echo-plain', WECOM_AES_RAW, WECOM_CORP_ID);
    const query = new URLSearchParams({
      msg_signature: wecomSignature(WECOM_TOKEN, timestamp, nonce, echostr),
      timestamp,
      nonce,
      echostr,
    });
    const result = verifyWecomEcho(query, WECOM_CFG);
    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toBe('apolla-echo-plain');
  });

  it('GET URL 校验：篡改 msg_signature → 拒绝', () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const echostr = wecomEncrypt('apolla-echo-plain', WECOM_AES_RAW, WECOM_CORP_ID);
    const query = new URLSearchParams({
      msg_signature: 'f'.repeat(40),
      timestamp,
      nonce: '1372623149',
      echostr,
    });
    const result = verifyWecomEcho(query, WECOM_CFG);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('msg_signature');
  });

  it('POST 消息回调：合法签名 → 解出明文 XML 并解析出 chatId/userId/text', () => {
    const { query, body } = buildWecomCallback(wecomPlainXml('帮我调研竞品'));
    const result = verifyWecomCallback(query, body, WECOM_CFG);
    expect(result.ok).toBe(true);
    const msg = parseWecomMessage(result.ok ? result.value : '');
    expect(msg).toEqual<InboundMessage>({
      channel: 'wecom',
      chatId: 'chat_wecom_1',
      userId: 'zhangsan',
      text: '帮我调研竞品',
    });
  });

  it('POST 消息回调：篡改密文（签名对不上）→ 拒绝', () => {
    const { query } = buildWecomCallback(wecomPlainXml('帮我调研竞品'));
    const forged = wecomEncrypt(
      wecomPlainXml('rm -rf /'),
      WECOM_AES_RAW,
      WECOM_CORP_ID,
      Buffer.alloc(16, 4),
    );
    const body = `<xml><Encrypt><![CDATA[${forged}]]></Encrypt></xml>`;
    const result = verifyWecomCallback(query, body, WECOM_CFG);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('msg_signature');
  });

  /**
   * 腾讯官方 WXBizMsgCrypt 示例向量：这条是「跟真实企微互通」的证据——
   * 签名必须逐字节等于官方公布的 msg_signature，密文必须能解出官方示例明文。
   * 时间戳是 2014 年，用固定 now 绕过新鲜度检查（新鲜度另有专门用例覆盖）。
   */
  it('官方示例向量：签名与官方公布值逐字节一致，且能解出官方明文', () => {
    const cfg: WecomCrypto = {
      token: 'QDG6eK',
      aesKey: decodeWecomAesKey('jWmYm7qr5nMoAUwZRjGtBxmz3KA1tkAj3ykkR6q2B2C'),
      receiveId: 'wx5823bf96d3bd56c7',
    };
    const timestamp = '1409659813';
    const nonce = '1372623149';
    const encrypt =
      'RypEvHKD8QQKFhvQ6QleEB4J58tiPdvo+rtK1I9qca6aM/wvqnLSV5zEPeusUiX5L5X/0lWfrf0QADHHhGd3QczcdCUpj911L3vg3W/sYYvuJTs3TUUkSUXxaccAS0qhxchrRYt66wiSpGLYL42aM6A8dTT+6k4aSknmPj48kzJs8qLjvd4Xgpue06DOdnLxAUHzM6+kDZ+HMZfJYuR+LtwGc2hgf5gsijff0ekUNXZiqATP7PF5mZxZ3Izoun1s4zG4LUMnvw2r+KqCKIw+3IQH03v+BCA9nMELNqbSf6tiWSrXJB3LAVGUcallcrw8V2t9EL4EhzJWrQUax5wLVMNS0+rUPA3k22Ncx4XXZS9o0MBH27Bo6BpNelZpS+/uh9KsNlY6bHCmJU9p8g7m3fVKn28H3KDYA5Pl/T8Z1ptDAVe0lXdQ2YoyyH2uyPIGHBZZIs2pDBS8R07+qN+E7Q==';
    expect(wecomSignature(cfg.token, timestamp, nonce, encrypt)).toBe(
      '477715d11cdb4164915debcba66cb864d751f3e6',
    );
    const query = new URLSearchParams({
      msg_signature: '477715d11cdb4164915debcba66cb864d751f3e6',
      timestamp,
      nonce,
    });
    const body = `<xml><Encrypt><![CDATA[${encrypt}]]></Encrypt></xml>`;
    const result = verifyWecomCallback(query, body, cfg, Number(timestamp) * 1000);
    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toContain('<Content><![CDATA[hello]]></Content>');
    // 单聊没有 ChatId，chatId 回落到 FromUserName
    expect(parseWecomMessage(result.ok ? result.value : '')).toEqual<InboundMessage>({
      channel: 'wecom',
      chatId: 'mycreate',
      userId: 'mycreate',
      text: 'hello',
    });
  });

  it('POST 消息回调：时间戳过期（10 分钟前）→ 拒绝重放', () => {
    const stale = Math.floor(Date.now() / 1000) - 600;
    const { query, body } = buildWecomCallback(wecomPlainXml('重放攻击'), { timestampSec: stale });
    const result = verifyWecomCallback(query, body, WECOM_CFG);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('新鲜度');
  });

  it('攻击者用自己的 token 签名（不知道我们的 token）→ 拒绝', () => {
    const { query, body } = buildWecomCallback(wecomPlainXml('攻击载荷'), {
      token: 'attackerToken',
    });
    const result = verifyWecomCallback(query, body, WECOM_CFG);
    expect(result.ok).toBe(false);
  });

  it('密文由别的 AESKey 加密（签名却合法）→ 解密失败被拒', () => {
    const otherKey = Buffer.alloc(32, 9);
    const { query, body } = buildWecomCallback(wecomPlainXml('攻击载荷'), { aesKey: otherKey });
    const result = verifyWecomCallback(query, body, WECOM_CFG);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('解密失败');
  });

  it('receiveid 与 WECOM_CORP_ID 不一致 → 拒绝（防跨企业投递）', () => {
    const { query, body } = buildWecomCallback(wecomPlainXml('别家企业'), {
      receiveId: 'ww_other_corp',
    });
    const result = verifyWecomCallback(query, body, WECOM_CFG);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('receiveid');
  });

  it('缺少 msg_signature/timestamp/nonce → 拒绝', () => {
    const { body } = buildWecomCallback(wecomPlainXml('无签名'));
    const result = verifyWecomCallback(new URLSearchParams(), body, WECOM_CFG);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('缺少');
  });

  it('安全默认值：未配置 WECOM_TOKEN / WECOM_AES_KEY 时 loadWecomCrypto 返回 null', () => {
    expect(loadWecomCrypto({}, {})).toBeNull();
    expect(loadWecomCrypto({}, { WECOM_TOKEN: 'only-token' })).toBeNull();
    const cfg = loadWecomCrypto(
      {},
      { WECOM_TOKEN: WECOM_TOKEN, WECOM_AES_KEY: WECOM_AES_KEY, WECOM_CORP_ID },
    );
    expect(cfg?.aesKey).toEqual(WECOM_AES_RAW);
    expect(cfg?.receiveId).toBe(WECOM_CORP_ID);
  });

  it('XML 字段提取：CDATA 与裸文本都能取到，非文本消息不转成任务', () => {
    expect(xmlField('<Content><![CDATA[你好]]></Content>', 'Content')).toBe('你好');
    expect(xmlField('<AgentID>1000002</AgentID>', 'AgentID')).toBe('1000002');
    expect(xmlField('<xml></xml>', 'Content')).toBeUndefined();
    const imageXml = wecomPlainXml('x').replace('<![CDATA[text]]>', '<![CDATA[image]]>');
    expect(parseWecomMessage(imageXml)).toBeNull();
  });
});

describe('钉钉 outgoing 入向验签', () => {
  const headersFor = (ts: number | string, secret = DINGTALK_APP_SECRET): IncomingHttpHeaders => ({
    timestamp: String(ts),
    sign: dingtalkSign(String(ts), secret),
  });

  it('合法 sign → 通过', () => {
    const result = verifyDingtalkInbound(headersFor(Date.now()), DINGTALK_APP_SECRET);
    expect(result.ok).toBe(true);
  });

  it('错误 appSecret 签出来的 sign → 拒绝', () => {
    const result = verifyDingtalkInbound(
      headersFor(Date.now(), 'wrongSecret'),
      DINGTALK_APP_SECRET,
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('sign');
  });

  it('时间戳过期（10 分钟前，签名本身合法）→ 拒绝重放', () => {
    const stale = Date.now() - 600_000;
    const result = verifyDingtalkInbound(headersFor(stale), DINGTALK_APP_SECRET);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('新鲜度');
  });

  it('缺少 timestamp / sign 请求头 → 拒绝', () => {
    expect(verifyDingtalkInbound({}, DINGTALK_APP_SECRET).ok).toBe(false);
    expect(verifyDingtalkInbound({ timestamp: String(Date.now()) }, DINGTALK_APP_SECRET).ok).toBe(
      false,
    );
  });
});

describe('飞书事件订阅验签与解密', () => {
  it('合法签名（明文 body）→ 通过并返回原 body', () => {
    const { headers, raw } = buildFeishuRequest(FEISHU_MESSAGE_EVENT);
    const result = verifyFeishuRequest(headers, raw, { encryptKey: FEISHU_ENCRYPT_KEY });
    expect(result.ok).toBe(true);
    expect(result.ok && (result.value.header as { event_type: string }).event_type).toBe(
      'im.message.receive_v1',
    );
  });

  it('签名合法但 body 被篡改（签名对不上原文）→ 拒绝', () => {
    const { headers, raw } = buildFeishuRequest(FEISHU_MESSAGE_EVENT);
    const tampered = raw.replace('帮我调研竞品', '执行 rm -rf /');
    expect(tampered).not.toBe(raw);
    const result = verifyFeishuRequest(headers, tampered, { encryptKey: FEISHU_ENCRYPT_KEY });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('X-Lark-Signature');
  });

  it('加密 body（encrypt 字段）→ 解密还原事件', () => {
    const { headers, raw } = buildFeishuRequest(FEISHU_MESSAGE_EVENT, { encrypted: true });
    expect(JSON.parse(raw)).toHaveProperty('encrypt');
    const result = verifyFeishuRequest(headers, raw, { encryptKey: FEISHU_ENCRYPT_KEY });
    expect(result.ok).toBe(true);
    expect(result.ok && (result.value.header as { event_type: string }).event_type).toBe(
      'im.message.receive_v1',
    );
  });

  it('url_verification 挑战：明文与加密两条路径都能拿到 challenge', () => {
    const challenge = {
      type: 'url_verification',
      challenge: 'ajls384kdjx98XX',
      token: FEISHU_VERIFY_TOKEN,
    };
    const plain = buildFeishuRequest(challenge);
    const plainResult = verifyFeishuRequest(plain.headers, plain.raw, {
      encryptKey: FEISHU_ENCRYPT_KEY,
      verificationToken: FEISHU_VERIFY_TOKEN,
    });
    expect(plainResult.ok && plainResult.value.challenge).toBe('ajls384kdjx98XX');

    const enc = buildFeishuRequest(challenge, { encrypted: true });
    const encResult = verifyFeishuRequest(enc.headers, enc.raw, {
      encryptKey: FEISHU_ENCRYPT_KEY,
      verificationToken: FEISHU_VERIFY_TOKEN,
    });
    expect(encResult.ok && encResult.value.challenge).toBe('ajls384kdjx98XX');
  });

  it('攻击者用别的 encrypt key 加密 → 解密失败被拒', () => {
    const { headers, raw } = buildFeishuRequest(FEISHU_MESSAGE_EVENT, {
      encryptKey: 'attackerKey',
      encrypted: true,
    });
    const result = verifyFeishuRequest(headers, raw, { encryptKey: FEISHU_ENCRYPT_KEY });
    expect(result.ok).toBe(false);
  });

  it('时间戳过期 → 拒绝重放', () => {
    const stale = Math.floor(Date.now() / 1000) - 600;
    const { headers, raw } = buildFeishuRequest(FEISHU_MESSAGE_EVENT, { timestampSec: stale });
    const result = verifyFeishuRequest(headers, raw, { encryptKey: FEISHU_ENCRYPT_KEY });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('新鲜度');
  });

  it('配了 Encrypt Key 却无签名头且 body 未加密 → 拒绝', () => {
    const raw = JSON.stringify(FEISHU_MESSAGE_EVENT);
    const result = verifyFeishuRequest({}, raw, { encryptKey: FEISHU_ENCRYPT_KEY });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('未加密');
  });

  it('Verification Token 校验：不匹配 → 拒绝', () => {
    const { headers, raw } = buildFeishuRequest(FEISHU_MESSAGE_EVENT);
    const result = verifyFeishuRequest(headers, raw, {
      encryptKey: FEISHU_ENCRYPT_KEY,
      verificationToken: 'another-token',
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('token');
  });

  it('安全默认值：两个密钥都没配 → 直接拒绝（不放行）', () => {
    const raw = JSON.stringify(FEISHU_MESSAGE_EVENT);
    const result = verifyFeishuRequest({}, raw, {});
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('未配置');
    expect(loadFeishuVerifyConfig({}, {})).toEqual({
      encryptKey: undefined,
      verificationToken: undefined,
    });
  });
});

// ——— 端到端：真实起 HTTP 端点，证明未验签请求触发不了 Agent 任务 ———

/** 起一个适配器并收集它派发出的消息 */
async function withAdapter<
  T extends {
    start: (cb: (m: InboundMessage) => Promise<void>) => Promise<void>;
    stop: () => Promise<void>;
  },
>(adapter: T, fn: (received: InboundMessage[]) => Promise<void>): Promise<void> {
  const received: InboundMessage[] = [];
  await adapter.start(async (m) => {
    received.push(m);
  });
  try {
    await fn(received);
  } finally {
    await adapter.stop();
  }
}

describe('回调端点（真实 HTTP，验证未验签请求进不来）', () => {
  it('企微：未签名的明文 JSON → 401，且不触发任务；合法密文回调 → 200 success 并派发消息', async () => {
    const port = 39211;
    const adapter = new WecomAdapter({
      port,
      token: WECOM_TOKEN,
      encodingAesKey: WECOM_AES_KEY,
      corpId: WECOM_CORP_ID,
    });
    await withAdapter(adapter, async (received) => {
      const attack = await fetch(`http://127.0.0.1:${port}/wecom/callback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId: 'g1', userId: 'u1', text: '执行 rm -rf /' }),
      });
      expect(attack.status).toBe(401);
      expect(received).toHaveLength(0);

      const { query, body } = buildWecomCallback(wecomPlainXml('帮我调研竞品'));
      const ok = await fetch(`http://127.0.0.1:${port}/wecom/callback?${query}`, {
        method: 'POST',
        headers: { 'content-type': 'text/xml' },
        body,
      });
      expect(ok.status).toBe(200);
      expect(await ok.text()).toBe('success');
      expect(received).toHaveLength(1);
      expect(received[0].text).toBe('帮我调研竞品');

      // GET URL 校验：签名合法时回显解密后的 echostr 明文
      const ts = String(Math.floor(Date.now() / 1000));
      const echostr = wecomEncrypt('echo-ok', WECOM_AES_RAW, WECOM_CORP_ID);
      const q = new URLSearchParams({
        msg_signature: wecomSignature(WECOM_TOKEN, ts, 'n1', echostr),
        timestamp: ts,
        nonce: 'n1',
        echostr,
      });
      const echo = await fetch(`http://127.0.0.1:${port}/wecom/callback?${q}`);
      expect(echo.status).toBe(200);
      expect(await echo.text()).toBe('echo-ok');
    });
  });

  it('企微：未配置密钥且未开开发开关 → 一律 401（安全默认值，不再放行）', async () => {
    const port = 39212;
    const adapter = new WecomAdapter({ port, insecurePlaintext: false });
    await withAdapter(adapter, async (received) => {
      const res = await fetch(`http://127.0.0.1:${port}/wecom/callback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId: 'g1', userId: 'u1', text: '任意人都能触发？' }),
      });
      expect(res.status).toBe(401);
      expect(received).toHaveLength(0);
    });
  });

  it('企微：显式开 WECOM_INSECURE_PLAINTEXT 后才接受明文 JSON（开发用）', async () => {
    const port = 39213;
    const adapter = new WecomAdapter({ port, insecurePlaintext: true });
    await withAdapter(adapter, async (received) => {
      const res = await fetch(`http://127.0.0.1:${port}/wecom/callback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId: 'g1', userId: 'u1', text: '本地冒烟' }),
      });
      expect(res.status).toBe(200);
      expect(received).toHaveLength(1);
      expect(received[0].chatId).toBe('g1');
    });
  });

  it('钉钉：无 sign 头 → 401；带合法 sign → 200 并派发消息', async () => {
    const port = 39214;
    const adapter = new DingTalkAdapter({ port, appSecret: DINGTALK_APP_SECRET });
    await withAdapter(adapter, async (received) => {
      const url = `http://127.0.0.1:${port}/dingtalk/callback`;
      const payload = JSON.stringify({
        conversationId: 'cid_1',
        senderStaffId: 'staff_1',
        text: { content: ' 帮我写周报 ' },
      });
      const attack = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
      });
      expect(attack.status).toBe(401);
      expect(received).toHaveLength(0);

      const ts = String(Date.now());
      const ok = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          timestamp: ts,
          sign: dingtalkSign(ts, DINGTALK_APP_SECRET),
        },
        body: payload,
      });
      expect(ok.status).toBe(200);
      expect(received).toHaveLength(1);
      expect(received[0]).toEqual<InboundMessage>({
        channel: 'dingtalk',
        chatId: 'cid_1',
        userId: 'staff_1',
        text: '帮我写周报',
      });
    });
  });

  it('钉钉：未配置 DINGTALK_APP_SECRET → 一律 401（安全默认值）', async () => {
    const port = 39215;
    const adapter = new DingTalkAdapter({ port, insecurePlaintext: false });
    await withAdapter(adapter, async (received) => {
      const res = await fetch(`http://127.0.0.1:${port}/dingtalk/callback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId: 'g1', text: 'hi' }),
      });
      expect(res.status).toBe(401);
      expect(received).toHaveLength(0);
    });
  });

  it('飞书：无签名 → 401；合法签名的加密事件 → 200 并派发消息；challenge 正常回显', async () => {
    const port = 39216;
    const adapter = new FeishuAdapter({
      port,
      encryptKey: FEISHU_ENCRYPT_KEY,
      verificationToken: FEISHU_VERIFY_TOKEN,
    });
    await withAdapter(adapter, async (received) => {
      const url = `http://127.0.0.1:${port}/feishu/callback`;
      const attack = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(FEISHU_MESSAGE_EVENT),
      });
      expect(attack.status).toBe(401);
      expect(received).toHaveLength(0);

      const { headers, raw } = buildFeishuRequest(FEISHU_MESSAGE_EVENT, { encrypted: true });
      const ok = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(headers as Record<string, string>) },
        body: raw,
      });
      expect(ok.status).toBe(200);
      expect(received).toHaveLength(1);
      expect(received[0]).toEqual<InboundMessage>({
        channel: 'feishu',
        chatId: 'oc_feishu_1',
        userId: 'ou_apolla_1',
        text: '帮我调研竞品',
      });

      const challenge = buildFeishuRequest({
        type: 'url_verification',
        challenge: 'c-123',
        token: FEISHU_VERIFY_TOKEN,
      });
      const echo = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(challenge.headers as Record<string, string>),
        },
        body: challenge.raw,
      });
      expect(await echo.json()).toEqual({ challenge: 'c-123' });
    });
  });

  it('飞书：未配置任何密钥 → 一律 401（安全默认值）', async () => {
    const port = 39217;
    const adapter = new FeishuAdapter({ port, insecurePlaintext: false });
    await withAdapter(adapter, async (received) => {
      const res = await fetch(`http://127.0.0.1:${port}/feishu/callback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId: 'g1', text: 'hi' }),
      });
      expect(res.status).toBe(401);
      expect(received).toHaveLength(0);
    });
  });
});
