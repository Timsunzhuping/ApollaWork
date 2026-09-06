/**
 * 日志脱敏（T-407）。
 * 日志一旦落到采集系统就很难追回，所以在写出前统一抹掉凭据：
 * 键值形式的密钥/令牌/密码、Bearer 令牌、JWT、URL 查询参数里的令牌、URL 里的 Basic 认证、
 * 常见 API Key 前缀。保留键名与前后文，排障时仍能看出「这里有个密钥」。
 */

const SECRET_KEYS =
  '(?:api[_-]?key|apikey|secret|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|password|passwd|pwd|private[_-]?key|master[_-]?key)';

const RULES: [RegExp, string][] = [
  // 键值对："api_key": "xxx"、apiKey=xxx、authorization: Bearer xxx —— Bearer/Basic 连同令牌整体算作值，
  // 否则会被截成「authorization: ***」+ 一段裸令牌
  [new RegExp(`(["']?${SECRET_KEYS}["']?\\s*[:=]\\s*["']?)((?:Bearer|Basic)\\s+)?([^"',\\s&;]+)`, 'gi'), '$1***'],
  // 无键名的 Authorization 值
  [/\b(Bearer)\s+[A-Za-z0-9\-._~+/]+=*/gi, '$1 ***'],
  [/\b(Basic)\s+[A-Za-z0-9+/]+=*/g, '$1 ***'],
  // JWT（三段 base64url）
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '***jwt***'],
  // URL 查询参数里的令牌：?access_token=xxx&X-Amz-Signature=xxx（允许带前缀的参数名）
  [new RegExp(`([?&][\\w-]*(?:${SECRET_KEYS}|key|sig|signature)=)[^&\\s"'#]+`, 'gi'), '$1***'],
  // URL 里的用户名密码：scheme://user:pass@host（用户名可为空）
  [/(\w+:\/\/)([^/\s:@]*):([^/\s@]+)@/g, '$1***:***@'],
  // 常见 API Key 前缀（OpenAI sk-、GitHub ghp_、Slack xox）
  [/\b(sk|ghp|gho|xox[abps])[-_][A-Za-z0-9\-_]{8,}\b/g, '$1-***'],
];

export function redact(text: string): string {
  let out = text;
  for (const [re, rep] of RULES) out = out.replace(re, rep);
  return out;
}

/** 只处理 URL：给访问日志 / 反代日志格式用 */
export function redactUrl(url: string): string {
  return redact(url);
}

/** 深度脱敏对象（用于把结构化字段写进日志前） */
export function redactObject<T>(value: T, depth = 0): T {
  if (depth > 6) return value;
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactObject(v, depth + 1)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = new RegExp(`^${SECRET_KEYS}$`, 'i').test(k) ? '***' : redactObject(v, depth + 1);
    }
    return out as T;
  }
  return value;
}
