import { describe, expect, it } from 'vitest';
import { MetricsService } from './metrics.service.js';

/** 指标（T-412）：命名、标签、任务结束一次记全 */
describe('MetricsService', () => {
  it('★ 任务结束一次记完状态、时长、token，并能以 Prometheus 文本导出', async () => {
    const m = new MetricsService();
    m.recordTaskEnd('completed', 12_000, { inTokens: 100, outTokens: 40, model: 'qwen' });
    m.recordTaskEnd('failed', 3_000);
    const text = await m.render();
    expect(text).toContain('apolla_tasks_total{status="completed"} 1');
    expect(text).toContain('apolla_tasks_total{status="failed"} 1');
    expect(text).toContain('apolla_model_tokens_total{model="qwen",direction="in"} 100');
    expect(text).toContain('apolla_model_tokens_total{model="qwen",direction="out"} 40');
    expect(text).toMatch(/apolla_task_duration_seconds_bucket\{le="15"\} 2/);
  });

  it('运行态 gauge 可增减；出网/重试/审计失败计数器有标签', async () => {
    const m = new MetricsService();
    m.tasksRunning.inc();
    m.tasksRunning.inc();
    m.tasksRunning.dec();
    m.sseConnections.inc();
    m.sandboxContainers.inc();
    m.egressTotal.inc({ outcome: 'denied' });
    m.modelRetries.inc({ model: 'qwen', fallback: 'true' });
    m.auditWriteFailures.inc();
    m.preflightOk.set(1);
    const text = await m.render();
    expect(text).toContain('apolla_tasks_running 1');
    expect(text).toContain('apolla_sse_connections 1');
    expect(text).toContain('apolla_sandbox_containers 1');
    expect(text).toContain('apolla_sandbox_egress_total{outcome="denied"} 1');
    expect(text).toContain('apolla_model_retries_total{model="qwen",fallback="true"} 1');
    expect(text).toContain('apolla_audit_write_failures_total 1');
    expect(text).toContain('apolla_preflight_ok 1');
  });

  it('带 Node 进程默认指标（前缀 apolla_process_）且不含高基数标签', async () => {
    const text = await new MetricsService().render();
    expect(text).toContain('apolla_process_');
    expect(text).not.toMatch(/taskId=|userId=/);
  });
});
