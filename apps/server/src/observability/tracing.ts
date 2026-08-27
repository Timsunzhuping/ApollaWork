import { randomBytes } from 'node:crypto';

/**
 * 轻量可观测（PRD T-121）。
 * 说明：Apolla 的每个任务已由事件溯源（task_events）完整记录，本身即「可回放的链路」；
 * 这里再补一层 OTLP 导出——配置了 OTEL_EXPORTER_OTLP_ENDPOINT 才发送，否则完全 no-op
 * （满足「无强制外呼、可离线」）。不引重型 SDK，直接发 OTLP/HTTP JSON。
 */
const ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const SERVICE = process.env.OTEL_SERVICE_NAME ?? 'apolla-server';
const DEBUG = process.env.OTEL_DEBUG === '1';

interface SpanData {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startNs: bigint;
  endNs?: bigint;
  attrs: Record<string, string | number | boolean>;
  status: 'ok' | 'error';
}

function hex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}
function nowNs(): bigint {
  return BigInt(Date.now()) * 1_000_000n;
}

export function newTraceId(): string {
  return hex(16);
}

export class Span {
  private data: SpanData;
  constructor(name: string, traceId: string, parentSpanId?: string, attrs: Record<string, any> = {}) {
    this.data = { traceId, spanId: hex(8), parentSpanId, name, startNs: nowNs(), attrs, status: 'ok' };
  }
  setAttr(k: string, v: string | number | boolean) {
    this.data.attrs[k] = v;
    return this;
  }
  get spanId() {
    return this.data.spanId;
  }
  get traceId() {
    return this.data.traceId;
  }
  end(status: 'ok' | 'error' = 'ok') {
    this.data.endNs = nowNs();
    this.data.status = status;
    exportSpan(this.data);
  }
}

function exportSpan(s: SpanData) {
  if (DEBUG) {
    const ms = s.endNs ? Number(s.endNs - s.startNs) / 1e6 : 0;
    // eslint-disable-next-line no-console
    console.log(`[trace] ${s.name} ${ms.toFixed(1)}ms ${s.status} ${JSON.stringify(s.attrs)}`);
  }
  if (!ENDPOINT) return;
  const payload = {
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: SERVICE } }] },
        scopeSpans: [
          {
            scope: { name: 'apolla' },
            spans: [
              {
                traceId: s.traceId,
                spanId: s.spanId,
                parentSpanId: s.parentSpanId ?? '',
                name: s.name,
                startTimeUnixNano: s.startNs.toString(),
                endTimeUnixNano: (s.endNs ?? s.startNs).toString(),
                kind: 1,
                status: { code: s.status === 'ok' ? 1 : 2 },
                attributes: Object.entries(s.attrs).map(([k, v]) => ({
                  key: k,
                  value: typeof v === 'number' ? { intValue: Math.round(v) } : typeof v === 'boolean' ? { boolValue: v } : { stringValue: String(v) },
                })),
              },
            ],
          },
        ],
      },
    ],
  };
  fetch(`${ENDPOINT.replace(/\/$/, '')}/v1/traces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {
    /* 可观测导出失败不影响主流程 */
  });
}

export const tracingEnabled = !!ENDPOINT || DEBUG;
