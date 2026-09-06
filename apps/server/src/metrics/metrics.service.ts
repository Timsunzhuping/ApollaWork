import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Prometheus 指标（T-412）。此前只有结构化日志，生产排障靠 grep。
 * 指标命名遵循 prometheus 约定：apolla_ 前缀、单位后缀、_total 计数。
 * 高基数标签（taskId / userId）一律不上指标 —— 那是日志与追踪的事。
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  /** 任务：按最终状态计数 + 时长分布 */
  readonly tasksTotal = new Counter({
    name: 'apolla_tasks_total',
    help: '任务数（按最终状态）',
    labelNames: ['status'] as const,
    registers: [this.registry],
  });
  readonly taskDuration = new Histogram({
    name: 'apolla_task_duration_seconds',
    help: '任务执行时长',
    buckets: [5, 15, 30, 60, 120, 300, 600, 1200, 1800],
    registers: [this.registry],
  });
  readonly tasksRunning = new Gauge({
    name: 'apolla_tasks_running',
    help: '本副本正在执行的任务数',
    registers: [this.registry],
  });
  readonly queueDepth = new Gauge({
    name: 'apolla_queue_depth',
    help: '排队等待执行的任务数',
    registers: [this.registry],
  });

  /** 模型：token、请求结果、重试/降级 */
  readonly modelTokens = new Counter({
    name: 'apolla_model_tokens_total',
    help: '模型 token 用量',
    labelNames: ['model', 'direction'] as const,
    registers: [this.registry],
  });
  readonly modelRetries = new Counter({
    name: 'apolla_model_retries_total',
    help: '模型调用重试/降级次数',
    labelNames: ['model', 'fallback'] as const,
    registers: [this.registry],
  });

  /** 沙箱与出网 */
  readonly sandboxContainers = new Gauge({
    name: 'apolla_sandbox_containers',
    help: '本副本运行中的沙箱容器数',
    registers: [this.registry],
  });
  readonly egressTotal = new Counter({
    name: 'apolla_sandbox_egress_total',
    help: '沙箱出网中继请求数（按结果）',
    labelNames: ['outcome'] as const, // allowed / denied
    registers: [this.registry],
  });

  /** 连接与审计 */
  readonly sseConnections = new Gauge({
    name: 'apolla_sse_connections',
    help: '打开中的任务事件流连接数',
    registers: [this.registry],
  });
  readonly auditWriteFailures = new Counter({
    name: 'apolla_audit_write_failures_total',
    help: '审计写入失败次数（任何非零都该告警）',
    registers: [this.registry],
  });
  readonly approvalsPending = new Gauge({
    name: 'apolla_approvals_pending',
    help: '等待用户审批的请求数',
    registers: [this.registry],
  });
  readonly preflightOk = new Gauge({
    name: 'apolla_preflight_ok',
    help: '生产就绪检查是否全部通过（1/0）',
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry, prefix: 'apolla_process_' });
  }

  /** 任务结束：一次记完状态、时长、token */
  recordTaskEnd(status: string, durationMs: number, usage?: { inTokens: number; outTokens: number; model: string }) {
    this.tasksTotal.inc({ status });
    this.taskDuration.observe(durationMs / 1000);
    if (usage) {
      this.modelTokens.inc({ model: usage.model, direction: 'in' }, usage.inTokens);
      this.modelTokens.inc({ model: usage.model, direction: 'out' }, usage.outTokens);
    }
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}
