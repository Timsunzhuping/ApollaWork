import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { runTask, type EventSink, type ControlSource } from '@apolla/runtime';
import type { TaskEvent } from '@apolla/protocol';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 性能基准（PRD §8「性能基准：并发 20/50 任务压测脚本入库」· §1.6 单执行节点并发 ≥20/≥50）。
 *
 * 用 mock 模型（零模型延迟）压测 —— 度量的是「平台自身开销」（循环调度、工具执行、
 * 事件下沉、进程创建），排除 LLM 推理时延。因此这里的数字是平台吞吐的下界/上界基线，
 * 真实生产吞吐会被模型 TTFT/生成速度主导。
 *
 * 说明：本基准运行在 runtime 层（LocalExecutor 语义，非容器）。PRD T-102 的「容器泄漏为零」
 * 属基础设施执行器（dockerode/K8s Job）范畴，不在本进程内基准覆盖范围。
 */

/** 计数型 sink：只累加计数，避免高事件量下内存膨胀，并模拟每事件的最小处理开销。 */
class CountingSink implements EventSink {
  count = 0;
  firstEventAt = 0;
  firstDeltaAt = 0;
  private t0 = performance.now();
  emit(e: TaskEvent) {
    this.count++;
    if (this.firstEventAt === 0) this.firstEventAt = performance.now() - this.t0;
    if (this.firstDeltaAt === 0 && e.type === 'message.delta') this.firstDeltaAt = performance.now() - this.t0;
  }
}

class AutoApproveControl implements ControlSource {
  async waitApproval() {
    return true;
  }
  async waitAnswer() {
    return '默认';
  }
  drainUserInputs() {
    return [];
  }
  isCancelled() {
    return false;
  }
}

function scripted(steps: unknown[]): string {
  return `压测任务。[[ACTIONS]]${JSON.stringify(steps)}[[/ACTIONS]]`;
}

/** 典型多步任务：写文件 + bash（真实子进程）+ 登记产物。 */
function taskScript(i: number): string {
  return scripted([
    { say: '开始处理任务…', tool: 'Write', args: { path: 'input.txt', content: `perf task ${i}\n`.repeat(4) } },
    { tool: 'Bash', args: { command: 'echo perf-$$ > out.txt && wc -c out.txt' } },
    { tool: 'Write', args: { path: 'result.md', content: `# 结果 ${i}\n处理完成。\n` } },
    { tool: 'Artifact', args: { path: 'result.md', title: `产物 ${i}`, kind: 'document' } },
    { say: '完成' },
  ]);
}

interface ConcResult {
  n: number;
  wallMs: number;
  throughput: number; // 任务/秒
  avgTaskMs: number;
  p95TaskMs: number;
  minTaskMs: number;
  maxTaskMs: number;
  failures: number;
  avgFirstEventMs: number;
  avgFirstDeltaMs: number;
  totalEvents: number;
}

async function benchConcurrency(n: number): Promise<ConcResult> {
  const workspaces: string[] = [];
  const makeTask = (i: number) => async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), `apolla-perf-${n}-${i}-`));
    workspaces.push(ws);
    const sink = new CountingSink();
    const s0 = performance.now();
    const res = await runTask(
      { prompt: taskScript(i), workspaceDir: ws, mode: 'auto', modelConfig: { model: 'mock' }, skillRoots: [] },
      sink,
      new AutoApproveControl(),
    );
    return {
      ok: res.status === 'completed',
      ms: performance.now() - s0,
      events: sink.count,
      firstEventMs: sink.firstEventAt,
      firstDeltaMs: sink.firstDeltaAt,
    };
  };

  const t0 = performance.now();
  const results = await Promise.all(Array.from({ length: n }, (_, i) => makeTask(i)()));
  const wallMs = performance.now() - t0;

  // 清理
  for (const ws of workspaces) {
    try {
      fs.rmSync(ws, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  const times = results.map((r) => r.ms).sort((a, b) => a - b);
  const sum = times.reduce((a, b) => a + b, 0);
  const p95 = times[Math.min(times.length - 1, Math.floor(times.length * 0.95))] ?? 0;
  return {
    n,
    wallMs,
    throughput: n / (wallMs / 1000),
    avgTaskMs: sum / n,
    p95TaskMs: p95,
    minTaskMs: times[0] ?? 0,
    maxTaskMs: times[times.length - 1] ?? 0,
    failures: results.filter((r) => !r.ok).length,
    avgFirstEventMs: results.reduce((a, r) => a + r.firstEventMs, 0) / n,
    avgFirstDeltaMs: results.reduce((a, r) => a + r.firstDeltaMs, 0) / n,
    totalEvents: results.reduce((a, r) => a + r.events, 0),
  };
}

interface EventThroughput {
  taskEvents: number;
  taskWallMs: number;
  taskEventsPerSec: number;
  synthN: number;
  synthWallMs: number;
  synthEventsPerSec: number;
}

async function benchEventThroughput(): Promise<EventThroughput> {
  // (a) 真实单任务事件率：多步脚本 → 大量 tool.call/tool.result/file.diff 等事件
  const STEPS = Number(process.env.PERF_EVENT_STEPS ?? 30);
  const steps: unknown[] = [];
  for (let i = 0; i < STEPS; i++) {
    steps.push({ tool: 'Write', args: { path: `f${i}.txt`, content: `line ${i}\n` } });
  }
  steps.push({ say: '完成' });
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'apolla-perf-ev-'));
  const sink = new CountingSink();
  const t0 = performance.now();
  await runTask(
    { prompt: scripted(steps), workspaceDir: ws, mode: 'auto', modelConfig: { model: 'mock' }, skillRoots: [] },
    sink,
    new AutoApproveControl(),
  );
  const taskWallMs = performance.now() - t0;
  fs.rmSync(ws, { recursive: true, force: true });

  // (b) 纯 sink 吞吐：向 sink 灌入 N 个合法事件，度量下沉分发上限
  const synthN = Number(process.env.PERF_SYNTH_EVENTS ?? 200_000);
  const csink = new CountingSink();
  const ev: TaskEvent = { v: 1, type: 'bash.output', callId: 'perf', chunk: 'x', stream: 'stdout' };
  const s0 = performance.now();
  for (let i = 0; i < synthN; i++) csink.emit(ev);
  const synthWallMs = performance.now() - s0;

  return {
    taskEvents: sink.count,
    taskWallMs,
    taskEventsPerSec: sink.count / (taskWallMs / 1000),
    synthN,
    synthWallMs,
    synthEventsPerSec: synthN / (synthWallMs / 1000),
  };
}

function fmt(n: number, d = 1): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

async function main() {
  const levels = (process.env.PERF_LEVELS ?? '20,50').split(',').map((s) => parseInt(s.trim(), 10));
  console.log(`\n运行性能基准 · 模型 mock（零模型延迟，纯平台开销）· 并发档位 ${levels.join(' / ')}\n`);

  // 预热一次（排除首个任务的模块/JIT 冷启动影响）
  await benchConcurrency(2);

  const conc: ConcResult[] = [];
  for (const n of levels) {
    const r = await benchConcurrency(n);
    conc.push(r);
    console.log(
      `并发 ${String(n).padStart(3)}：总耗时 ${fmt(r.wallMs)}ms · 吞吐 ${fmt(r.throughput)} 任务/秒 · ` +
        `单任务均 ${fmt(r.avgTaskMs)}ms (p95 ${fmt(r.p95TaskMs)}ms) · 失败 ${r.failures} · 事件 ${r.totalEvents}`,
    );
  }

  const evt = await benchEventThroughput();
  console.log(
    `\n事件吞吐：单任务 ${evt.taskEvents} 事件 / ${fmt(evt.taskWallMs)}ms = ${fmt(evt.taskEventsPerSec, 0)} 事件/秒；` +
      `\n          纯 sink ${evt.synthN.toLocaleString()} 事件 / ${fmt(evt.synthWallMs)}ms = ${fmt(evt.synthEventsPerSec, 0)} 事件/秒`,
  );

  // §1.6 达标判断：某并发档 N 全部完成（0 失败）即视为满足「单执行节点并发 ≥N」
  const meets = (n: number) => {
    const r = conc.find((c) => c.n === n);
    return r ? r.failures === 0 : false;
  };
  const m1 = meets(20); // M1 目标 ≥20
  const m2 = meets(50); // M2 目标 ≥50

  console.log('\n对照 PRD §1.6「单执行节点并发任务」：');
  console.log(`  M1 目标 ≥20：${conc.find((c) => c.n === 20) ? (m1 ? '✅ 达标' : '❌ 未达标') : '（未测该档）'}`);
  console.log(`  M2 目标 ≥50：${conc.find((c) => c.n === 50) ? (m2 ? '✅ 达标' : '❌ 未达标') : '（未测该档）'}`);

  writeReport(conc, evt, { m1, m2 });
  console.log('\n报告已写入 eval/perf/report.md\n');

  // 压测脚本以「全部任务完成、无失败」为通过条件
  const anyFailure = conc.some((c) => c.failures > 0);
  process.exit(anyFailure ? 1 : 0);
}

function writeReport(conc: ConcResult[], evt: EventThroughput, verdict: { m1: boolean; m2: boolean }) {
  const lines: string[] = [];
  lines.push('# Apolla Work 性能基准报告');
  lines.push('');
  lines.push(`- 日期：${process.env.EVAL_DATE ?? new Date().toISOString().slice(0, 10)}`);
  lines.push(`- 模型：mock（零模型延迟）—— 度量平台自身开销，排除 LLM 推理时延`);
  lines.push(`- 运行环境：${os.type()} ${os.release()} · ${os.cpus().length} vCPU · Node ${process.version}`);
  lines.push(`- 任务形态：每任务多步（Write → Bash 真实子进程 → Write → Artifact），auto 模式自动放行`);
  lines.push('');
  lines.push('> 口径：mock 模型无网络/推理延迟，因此下列数字反映的是**平台调度 + 工具执行 + 事件下沉 + 进程创建**的开销基线；');
  lines.push('> 生产环境单任务时延与吞吐主要由模型 TTFT 与生成速度决定。容器执行器层面的隔离/泄漏指标（PRD T-102）不在本进程内基准范围。');
  lines.push('');

  lines.push('## 并发压测');
  lines.push('');
  lines.push('| 并发数 | 总耗时 | 吞吐(任务/秒) | 单任务均值 | p95 | min | max | 失败 | 总事件 |');
  lines.push('|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of conc) {
    lines.push(
      `| ${r.n} | ${fmt(r.wallMs)}ms | ${fmt(r.throughput)} | ${fmt(r.avgTaskMs)}ms | ${fmt(r.p95TaskMs)}ms | ${fmt(r.minTaskMs)}ms | ${fmt(r.maxTaskMs)}ms | ${r.failures} | ${r.totalEvents} |`,
    );
  }
  lines.push('');
  lines.push('说明：**总耗时** = 一批 N 个任务并发（Promise.all）的墙钟；**吞吐** = N / 总耗时；**单任务均值/p95** = 各任务自身端到端耗时（含并发争用）。');
  lines.push('');

  lines.push('## 首个流式响应（平台开销下界）');
  lines.push('');
  const c20 = conc.find((c) => c.n === 20);
  if (c20) {
    lines.push(`- 20 并发下，平均「首个事件」到达：${fmt(c20.avgFirstEventMs, 2)}ms；平均「首个流式增量(message.delta)」：${fmt(c20.avgFirstDeltaMs, 2)}ms。`);
  }
  lines.push('- 对照 PRD §1.6「任务首个流式响应」目标 M1 < 3s / M2 < 2s：mock 下平台侧开销为毫秒级，余量充足（真实值由模型 TTFT 决定）。');
  lines.push('');

  lines.push('## 事件吞吐');
  lines.push('');
  lines.push('| 场景 | 事件数 | 耗时 | 速率(事件/秒) |');
  lines.push('|---|---:|---:|---:|');
  lines.push(`| 真实单任务（${evt.taskEvents} 事件流水线） | ${evt.taskEvents} | ${fmt(evt.taskWallMs)}ms | ${fmt(evt.taskEventsPerSec, 0)} |`);
  lines.push(`| 纯 sink 分发 | ${evt.synthN.toLocaleString()} | ${fmt(evt.synthWallMs)}ms | ${fmt(evt.synthEventsPerSec, 0)} |`);
  lines.push('');

  lines.push('## 对照 PRD §1.6 达标判断');
  lines.push('');
  lines.push('| 指标 | 目标 | 实测 | 结论 |');
  lines.push('|---|---|---|---|');
  const r20 = conc.find((c) => c.n === 20);
  const r50 = conc.find((c) => c.n === 50);
  if (r20)
    lines.push(`| 单执行节点并发（M1） | ≥ 20 | 20 并发 ${r20.failures === 0 ? '全部成功' : `${r20.failures} 失败`}，${fmt(r20.throughput)} 任务/秒 | ${verdict.m1 ? '✅ 达标' : '❌ 未达标'} |`);
  if (r50)
    lines.push(`| 单执行节点并发（M2） | ≥ 50 | 50 并发 ${r50.failures === 0 ? '全部成功' : `${r50.failures} 失败`}，${fmt(r50.throughput)} 任务/秒 | ${verdict.m2 ? '✅ 达标' : '❌ 未达标'} |`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('运行：`pnpm --filter @apolla/eval exec tsx perf/run.ts`（可用 `PERF_LEVELS=20,50,100` 调整并发档位）。');
  lines.push('');

  fs.writeFileSync(path.join(__dirname, 'report.md'), lines.join('\n'));
}

main().catch((e) => {
  console.error('性能基准运行器异常：', e);
  process.exit(2);
});
