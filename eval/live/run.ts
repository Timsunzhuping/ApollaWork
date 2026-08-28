import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTask, type EventSink, type ControlSource } from '@apolla/runtime';
import type { TaskEvent } from '@apolla/protocol';
import { LIVE_SCENARIOS, type LiveScenario } from './scenarios.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_ROOT = path.resolve(__dirname, '../../skills');

/**
 * 真实模型评测运行器 —— 上线决策的依据。
 *
 * 用法：
 *   MODEL_BASE_URL=http://localhost:11434/v1 MODEL_API_KEY=x MODEL_DEFAULT=qwen2.5:14b \
 *     pnpm --filter @apolla/eval exec tsx live/run.ts
 *
 * 可选：REPEAT=3 每个场景跑 3 次（模型有随机性，单次结果不可靠）
 *      TIMEOUT_MS=300000 单场景超时
 */
const REPEAT = Number(process.env.REPEAT ?? 1);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 300_000);

class Control implements ControlSource {
  // 评测中不接受危险操作审批（与生产 auto 模式一致）
  async waitApproval() {
    return false;
  }
  async waitAnswer() {
    return '请自行决定';
  }
  drainUserInputs() {
    return [];
  }
  isCancelled() {
    return false;
  }
}

class Sink implements EventSink {
  events: TaskEvent[] = [];
  emit(e: TaskEvent) {
    this.events.push(e);
  }
  toolCalls() {
    return this.events.filter((e) => e.type === 'tool.call').length;
  }
  usage() {
    const u = [...this.events].reverse().find((e) => e.type === 'usage.updated');
    return u && 'usage' in u ? u.usage : { inTokens: 0, outTokens: 0, model: '?' };
  }
}

interface Attempt {
  passed: number;
  total: number;
  ok: boolean;
  ms: number;
  toolCalls: number;
  tokens: number;
  status: string;
  failed: string[];
}

async function runOnce(s: LiveScenario): Promise<Attempt> {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), `apolla-live-${s.id}-`));
  s.setup?.(ws);
  const sink = new Sink();
  const t0 = Date.now();
  let status = 'error';
  try {
    const res = await Promise.race([
      runTask(
        {
          prompt: s.prompt,
          workspaceDir: ws,
          mode: 'auto',
          modelConfig: {
            model: process.env.MODEL_DEFAULT ?? 'mock',
            baseUrl: process.env.MODEL_BASE_URL,
            apiKey: process.env.MODEL_API_KEY,
          },
          skillRoots: [SKILLS_ROOT],
        },
        sink,
        new Control(),
      ),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), TIMEOUT_MS)),
    ]);
    status = res.status;
  } catch (e) {
    status = (e as Error).message === 'timeout' ? 'timeout' : `error: ${(e as Error).message.slice(0, 60)}`;
  }
  const failed: string[] = [];
  let passed = 0;
  for (const c of s.checks) {
    let ok = false;
    try {
      ok = c.test(ws);
    } catch {
      ok = false;
    }
    ok ? passed++ : failed.push(c.desc);
  }
  const u = sink.usage();
  return {
    passed,
    total: s.checks.length,
    ok: passed === s.checks.length,
    ms: Date.now() - t0,
    toolCalls: sink.toolCalls(),
    tokens: u.inTokens + u.outTokens,
    status,
    failed,
  };
}

async function main() {
  const model = process.env.MODEL_DEFAULT ?? 'mock';
  if (model === 'mock') {
    console.error(
      '\n❌ 本套件必须用真实模型运行 —— 它测的是「Agent 能不能干成活」，\n' +
        '   用 mock 模型没有意义（那是 eval/run.ts 的职责：测平台管道）。\n\n' +
        '   示例：\n' +
        '     MODEL_BASE_URL=http://localhost:11434/v1 MODEL_API_KEY=x \\\n' +
        '     MODEL_DEFAULT=qwen2.5:14b pnpm --filter @apolla/eval exec tsx live/run.ts\n',
    );
    process.exit(2);
  }

  console.log(`\n真实模型评测 · 模型 ${model} · 每场景跑 ${REPEAT} 次 · 场景 ${LIVE_SCENARIOS.length} 个`);
  console.log(`（本套件测的是产品有效性，不是平台管道；后者见 eval/run.ts）\n`);

  const results: { s: LiveScenario; attempts: Attempt[] }[] = [];
  for (const s of LIVE_SCENARIOS) {
    const attempts: Attempt[] = [];
    for (let i = 0; i < REPEAT; i++) attempts.push(await runOnce(s));
    results.push({ s, attempts });
    const okCount = attempts.filter((a) => a.ok).length;
    const mark = okCount === REPEAT ? '✅' : okCount > 0 ? '🟡' : '❌';
    const avg = Math.round(attempts.reduce((n, a) => n + a.ms, 0) / attempts.length / 1000);
    const tok = Math.round(attempts.reduce((n, a) => n + a.tokens, 0) / attempts.length);
    console.log(
      `${mark} ${s.id.padEnd(18)} ${s.level.padEnd(7)} ${s.name.padEnd(26)} ` +
        `${okCount}/${REPEAT} 次通过 · ${avg}s · ${tok} tok · ${attempts[0].toolCalls} 次工具调用`,
    );
    for (const f of attempts[0].failed) console.log(`      ↳ 未达成：${f}`);
    if (attempts[0].status !== 'completed') console.log(`      ↳ 状态：${attempts[0].status}`);
  }

  // 汇总：按难度分层，这是决定「能不能上线 / 该收窄到哪些场景」的关键
  const byLevel: Record<string, { ok: number; total: number }> = {};
  let fullyOk = 0;
  let totalTokens = 0;
  let totalMs = 0;
  for (const { s, attempts } of results) {
    byLevel[s.level] ??= { ok: 0, total: 0 };
    byLevel[s.level].total += REPEAT;
    byLevel[s.level].ok += attempts.filter((a) => a.ok).length;
    if (attempts.every((a) => a.ok)) fullyOk++;
    totalTokens += attempts.reduce((n, a) => n + a.tokens, 0);
    totalMs += attempts.reduce((n, a) => n + a.ms, 0);
  }
  const runs = LIVE_SCENARIOS.length * REPEAT;
  const allOk = Object.values(byLevel).reduce((n, v) => n + v.ok, 0);
  const rate = ((allOk / runs) * 100).toFixed(0);

  console.log(`\n${'─'.repeat(72)}`);
  console.log(`总成功率：${allOk}/${runs}（${rate}%） · 稳定通过的场景：${fullyOk}/${LIVE_SCENARIOS.length}`);
  for (const [lv, v] of Object.entries(byLevel)) {
    console.log(`  ${lv.padEnd(7)} ${v.ok}/${v.total}（${((v.ok / v.total) * 100).toFixed(0)}%）`);
  }
  console.log(`平均单任务：${Math.round(totalMs / runs / 1000)}s · ${Math.round(totalTokens / runs)} token`);

  // 上线判据
  console.log(`\n上线判据（PRD §1.6：M1 ≥70% / M2 ≥85%）：`);
  const n = Number(rate);
  if (n >= 85) console.log(`  ✅ ${rate}% —— 达到 M2 标准，可进入 POC。`);
  else if (n >= 70) console.log(`  🟡 ${rate}% —— 达到 M1 标准，可小范围内测；上线前建议换更强模型或收窄场景。`);
  else console.log(`  ❌ ${rate}% —— 未达标。不要上线：先换更强的模型，或把产品范围收窄到通过率高的场景。`);

  const md = [
    `# 真实模型评测报告`,
    ``,
    `- 模型：\`${model}\``,
    `- 场景：${LIVE_SCENARIOS.length} 个 × ${REPEAT} 次 = ${runs} 次运行`,
    `- **总成功率：${allOk}/${runs}（${rate}%）**`,
    `- 稳定通过（全部重复均成功）：${fullyOk}/${LIVE_SCENARIOS.length}`,
    `- 平均：${Math.round(totalMs / runs / 1000)}s · ${Math.round(totalTokens / runs)} token/任务`,
    ``,
    `## 分难度`,
    ``,
    `| 难度 | 通过 | 成功率 |`,
    `|---|---|---|`,
    ...Object.entries(byLevel).map(
      ([lv, v]) => `| ${lv} | ${v.ok}/${v.total} | ${((v.ok / v.total) * 100).toFixed(0)}% |`,
    ),
    ``,
    `## 逐场景`,
    ``,
    `| 场景 | 难度 | 通过 | 平均耗时 | 平均 token |`,
    `|---|---|---|---|---|`,
    ...results.map(({ s, attempts }) => {
      const ok = attempts.filter((a) => a.ok).length;
      const avg = Math.round(attempts.reduce((n2, a) => n2 + a.ms, 0) / attempts.length / 1000);
      const tok = Math.round(attempts.reduce((n2, a) => n2 + a.tokens, 0) / attempts.length);
      return `| ${s.id} ${s.name} | ${s.level} | ${ok}/${REPEAT} | ${avg}s | ${tok} |`;
    }),
    ``,
    `> 本套件测的是**产品有效性**（Agent 能否用自然语言指令干成活），`,
    `> 与 \`eval/run.ts\`（mock 模型测平台管道）互补。上线决策以本报告为准。`,
    ``,
  ].join('\n');
  fs.writeFileSync(path.join(__dirname, 'report.md'), md);
  console.log(`\n报告已写入 eval/live/report.md\n`);

  process.exit(n >= 70 ? 0 : 1);
}

main();
