import { hostAllowed } from '@apolla/runtime';
import type { ExecRequest } from './executor.js';

export interface EgressDecision {
  ok: boolean;
  reason?: string;
  /** 放行时由 server 侧追加/覆盖的请求头（如模型密钥） */
  headers?: Record<string, string>;
}

/** 出网策略：沙箱一切出网请求都由 server 按此判定（T-402） */
export interface EgressPolicy {
  fetch(url: URL): EgressDecision;
  tcp(host: string, port: number): EgressDecision;
}

/**
 * 无论白名单怎么配都禁止的目标：server 自己、容器宿主、云元数据端点。
 * 沙箱里的 Agent（或被注入的提示词）拿这些能打到管理 API 与凭据。
 */
const FORBIDDEN_HOST =
  /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|0\.0\.0\.0|::1|::|169\.254\.\d{1,3}\.\d{1,3}|fe80:.*|metadata\.google\.internal|host\.docker\.internal)$/i;

const deny = (reason: string): EgressDecision => ({ ok: false, reason });

function safeOrigin(u?: string): string | undefined {
  if (!u) return undefined;
  try {
    return new URL(u).origin;
  } catch {
    return undefined;
  }
}

/**
 * 按任务构造出网策略：
 * - 模型网关源：放行并在 server 侧注入 Authorization（容器不持有密钥）；
 * - 搜索服务源：放行；
 * - 任务白名单域（含子域）：放行 fetch 与任意端口的 TCP 隧道（内网 REST 常用 8080 等）；
 * - 其余一律拒绝。本机 / 链路本地 / 云元数据地址无条件拒绝。
 * DNS 解析在 server 侧完成，容器无法用 DNS 重绑定绕过主机名匹配。
 */
export function buildEgressPolicy(
  req: Pick<ExecRequest, 'model' | 'webfetchAllowlist' | 'searxngUrl'>,
): EgressPolicy {
  const modelOrigin = safeOrigin(req.model.baseUrl);
  const searxOrigin = safeOrigin(req.searxngUrl);
  const allowlist = req.webfetchAllowlist ?? [];

  return {
    fetch(url) {
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return deny('仅允许 http/https');
      const host = url.hostname.replace(/^\[|\]$/g, '');
      if (FORBIDDEN_HOST.test(host)) return deny(`禁止访问本机/链路本地地址 ${host}`);
      if (modelOrigin && url.origin === modelOrigin) {
        return {
          ok: true,
          headers: req.model.apiKey ? { authorization: `Bearer ${req.model.apiKey}` } : {},
        };
      }
      if (searxOrigin && url.origin === searxOrigin) return { ok: true };
      if (hostAllowed(url.toString(), allowlist)) return { ok: true };
      return deny(`${host} 不在出网白名单`);
    },
    tcp(host, port) {
      const h = host.replace(/^\[|\]$/g, '');
      if (FORBIDDEN_HOST.test(h)) return deny(`禁止访问本机/链路本地地址 ${h}`);
      if (!Number.isInteger(port) || port <= 0 || port >= 65536) return deny('端口非法');
      if (hostAllowed(`http://${h.includes(':') ? `[${h}]` : h}/`, allowlist)) return { ok: true };
      return deny(`${h}:${port} 不在出网白名单`);
    },
  };
}
