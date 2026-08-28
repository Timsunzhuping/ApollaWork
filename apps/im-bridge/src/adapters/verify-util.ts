import crypto from 'node:crypto';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';

/**
 * 入向回调验签的公共原语（企微 / 钉钉 / 飞书共用）。
 *
 * 安全约定（三通道一致，不得放松）：
 * - **失败关闭**：没配密钥 = 拒绝所有回调，绝不放行（回调端点能触发 Agent 执行 Bash，
 *   放行等于未授权 RCE）。放行只能靠显式的 `*_INSECURE_PLAINTEXT=1` 开发开关。
 * - **防重放**：所有带时间戳的回调都做 ±5 分钟新鲜度检查。
 * - **防时序侧信道**：签名比较一律走 timingSafeEqual，长度不等先返回 false。
 * - **日志不含密钥**：只记通道、原因、来源 IP，绝不记 token / AESKey / 签名原文。
 */

/** 验签结果：失败时 reason 是可直接进告警日志的短语（不含任何密钥或签名原文） */
export type VerifyResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export function verifyOk<T>(value: T): VerifyResult<T> {
  return { ok: true, value };
}

export function verifyFail<T = never>(reason: string): VerifyResult<T> {
  return { ok: false, reason };
}

/** 时间戳新鲜度窗口：|now - ts| 超过 5 分钟即判为重放 */
export const FRESHNESS_WINDOW_MS = 5 * 60 * 1000;

/**
 * 定长安全比较：长度不等直接 false（timingSafeEqual 要求等长，长度本身不算秘密）。
 * 比较统一按 utf8 字节做，调用方不必关心大小写以外的编码问题。
 */
export function timingSafeEqualStr(a: string | undefined, b: string | undefined): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * 各家时间戳单位不一（企微 / 飞书是秒，钉钉是毫秒），统一归一到毫秒。
 * 阈值 1e11 足以区分：1e11 秒 ≈ 公元 5138 年，1e11 毫秒 ≈ 1973 年。
 */
export function toMillis(raw: string | number | undefined): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
}

/** 新鲜度检查：解析失败或超出 ±window 都判失败（防重放） */
export function checkFreshness(
  raw: string | number | undefined,
  now: number = Date.now(),
  windowMs: number = FRESHNESS_WINDOW_MS,
): VerifyResult<number> {
  const ms = toMillis(raw);
  if (ms === null) return verifyFail('timestamp 缺失或非法');
  const skew = Math.abs(now - ms);
  if (skew > windowMs) {
    return verifyFail(
      `timestamp 超出 ±${Math.round(windowMs / 1000)}s 新鲜度窗口（偏差 ${Math.round(skew / 1000)}s）`,
    );
  }
  return verifyOk(ms);
}

/** 取单个请求头（node 会把重复头合成数组，这里只取第一个） */
export function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const v = headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0];
  return typeof v === 'string' ? v : undefined;
}

/** 来源 IP，仅用于告警日志（有反代时取 X-Forwarded-For 第一跳） */
export function clientIp(req?: IncomingMessage): string {
  if (!req) return 'unknown';
  const xff = headerValue(req.headers, 'x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return req.socket?.remoteAddress ?? 'unknown';
}

/** 验签失败告警：通道 + 原因 + 来源 IP，不含密钥与签名原文 */
export function warnRejected(channel: string, reason: string, req?: IncomingMessage): void {
  console.warn(`[${channel}] 拒绝回调：${reason}（来源 ${clientIp(req)}）`);
}

const warnedInsecure = new Set<string>();

/**
 * 明文开发开关：仅当环境变量显式为 1/true/yes 时开启，并打一次醒目警告。
 * 生产环境绝不可开——开启后任何人 POST 回调即可触发 Agent 任务。
 */
export function insecurePlaintextEnabled(
  envName: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const v = (env[envName] ?? '').trim().toLowerCase();
  const on = v === '1' || v === 'true' || v === 'yes';
  if (on && !warnedInsecure.has(envName)) {
    warnedInsecure.add(envName);
    console.warn(
      `[im-bridge] ⚠️  ${envName}=1：该通道回调验签已关闭，任何人 POST 都能触发 Agent 任务（可执行 Bash）。仅限本地开发！`,
    );
  }
  return on;
}

/** 补 PKCS#7 padding（企微按 32 字节分组，飞书按 16） */
export function padPkcs7(buf: Buffer, blockSize = 32): Buffer {
  const pad = blockSize - (buf.length % blockSize);
  return Buffer.concat([buf, Buffer.alloc(pad, pad)]);
}

/** 去 PKCS#7 padding；padding 非法直接抛错（伪造密文解出来的多半是垃圾） */
export function stripPkcs7(buf: Buffer, blockSize = 32): Buffer {
  if (buf.length === 0) return buf;
  const pad = buf[buf.length - 1];
  if (pad < 1 || pad > blockSize || pad > buf.length) throw new Error('PKCS#7 padding 非法');
  return buf.subarray(0, buf.length - pad);
}
