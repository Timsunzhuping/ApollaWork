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
// 推理型模型（qwen3、deepseek-r1 等）会先输出大段 <think>，单次调用可能上百秒。
// 多步任务需要多次调用，默认给足 10 分钟；CPU 推理请再放大。
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 600_000);

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

/**
 * 结果分类 —— 这是本报告最重要的设计。
 * 把「超时」和「做错」混成一个成功率会得出完全错误的结论：
 *   timeout 说明模型太慢 / 超时设太短 → 换更快的模型或加大超时，与能力无关
 *   wrong   说明模型做不对 → 这才是真正的能力问题
 * 两者的处置方式南辕北辙，必须分开报。
 */
type Outcome = 'pass' | 'wrong' | 'timeout' | 'error';

interface Attempt {
  outcome: Outcome;
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
          // PROMPT_SUFFIX 用于给推理型模型关掉 <think>（如 qwen3 的 /no_think），
          // 场景文本本身保持纯净、与模型无关
          prompt: s.prompt + (process.env.PROMPT_SUFFIX ?? ''),
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
  const ok = passed === s.checks.length;
  const outcome: Outcome = ok
    ? 'pass'
    : status === 'timeout'
      ? 'timeout'
      : status.startsWith('error')
        ? 'error'
        : 'wrong';
  return {
    outcome,
    passed,
    total: s.checks.length,
    ok,
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
    const worst = attempts[0].outcome;
    const mark =
      okCount === REPEAT ? '✅' : okCount > 0 ? '🟡' : worst === 'timeout' ? '⏱' : worst === 'error' ? '💥' : '❌';
    const avg = Math.round(attempts.reduce((n, a) => n + a.ms, 0) / attempts.length / 1000);
    const tok = Math.round(attempts.reduce((n, a) => n + a.tokens, 0) / attempts.length);
    console.log(
      `${mark} ${s.id.padEnd(18)} ${s.level.padEnd(7)} ${s.name.padEnd(26)} ` +
        `${okCount}/${REPEAT} 次通过 · ${avg}s · ${tok} tok · ${attempts[0].toolCalls} 次工具调用`,
    );
    for (const f of attempts[0].failed) console.log(`      ↳ 未达成：${f}`);
    if (attempts[0].status !== 'completed') console.log(`      ↳ 状态：${attempts[0].status}`);
  }

  // 汇总：按难度分层 + 按结果分类
  const byLevel: Record<string, { ok: number; total: number }> = {};
  const byOutcome: Record<Outcome, number> = { pass: 0, wrong: 0, timeout: 0, error: 0 };
  let fullyOk = 0;
  let totalTokens = 0;
  let totalMs = 0;
  for (const { s: sc, attempts } of results) {
    byLevel[sc.level] ??= { ok: 0, total: 0 };
    byLevel[sc.level].total += REPEAT;
    byLevel[sc.level].ok += attempts.filter((a) => a.ok).length;
    for (const a of attempts) byOutcome[a.outcome]++;
    if (attempts.every((a) => a.ok)) fullyOk++;
    totalTokens += attempts.reduce((n, a) => n + a.tokens, 0);
    totalMs += attempts.reduce((n, a) => n + a.ms, 0);
  }
  const runs = LIVE_SCENARIOS.length * REPEAT;
  const allOk = byOutcome.pass;
  const rate = ((allOk / runs) * 100).toFixed(0);
  // 排除超时/异常后的「能力成功率」—— 真正反映模型会不会做
  const decided = byOutcome.pass + byOutcome.wrong;
  const capability = decided > 0 ? ((byOutcome.pass / decided) * 100).toFixed(0) : null;
  const avgTokPerSec = totalMs > 0 ? (totalTokens / (totalMs / 1000)).toFixed(1) : '0';

  console.log(`\n${'─'.repeat(72)}`);
  console.log(`结果分布：✅ 通过 ${byOutcome.pass} · ❌ 做错 ${byOutcome.wrong} · ⏱ 超时 ${byOutcome.timeout} · 💥 异常 ${byOutcome.error}`);
  console.log(`稳定通过的场景：${fullyOk}/${LIVE_SCENARIOS.length} · 平均 ${Math.round(totalMs / runs / 1000)}s · ${Math.round(totalTokens / runs)} token/任务 · 约 ${avgTokPerSec} token/秒`);
  for (const [lv, v] of Object.entries(byLevel)) {
    console.log(`  ${lv.padEnd(7)} ${v.ok}/${v.total}（${((v.ok / v.total) * 100).toFixed(0)}%）`);
  }

  // 判据：超时占比过高时，本次结果不能作为能力结论
  const timeoutShare = byOutcome.timeout / runs;
  console.log(`\n结论：`);
  if (timeoutShare >= 0.3) {
    console.log(`  ⚠️  ${byOutcome.timeout}/${runs} 次超时（${(timeoutShare * 100).toFixed(0)}%）—— **本次结果不能作为产品能力结论**。`);
    console.log(`     超时说明模型太慢或超时设置过短，与「会不会做」无关。处置：`);
    console.log(`       · 推理型模型（qwen3 / deepseek-r1）会先输出大段 <think>，请在 prompt 末尾加 /no_think，`);
    console.log(`         或换非推理模型；CPU 推理请务必上 GPU`);
    console.log(`       · 加大超时：TIMEOUT_MS=1800000`);
    console.log(`     当前吞吐约 ${avgTokPerSec} token/秒，单任务平均 ${Math.round(totalTokens / runs)} token。`);
    if (capability !== null) {
      console.log(`     已跑完的 ${decided} 次里，能力成功率 ${capability}%（样本太小，仅供参考）。`);
    }
  } else {
    console.log(`  总成功率 ${allOk}/${runs}（${rate}%）· 能力成功率 ${capability ?? '—'}%（排除超时/异常）`);
    const n = Number(rate);
    if (n >= 85) console.log(`  ✅ 达到 M2 标准（≥85%），可进入 POC。`);
    else if (n >= 70) console.log(`  🟡 达到 M1 标准（≥70%），可小范围内测；上线前建议换更强模型或收窄场景。`);
    else console.log(`  ❌ 未达标（PRD §1.6 要求 ≥70%）。不要上线：换更强的模型，或把范围收窄到通过率高的场景。`);
  }

  const md = [
    `# 真实模型评测报告`,
    ``,
    `- 模型：\`${model}\``,
    `- 场景：${LIVE_SCENARIOS.length} 个 × ${REPEAT} 次 = ${runs} 次运行`,
    `- **总成功率：${allOk}/${runs}（${rate}%）**`,
    `- 结果分布：通过 ${byOutcome.pass} · 做错 ${byOutcome.wrong} · **超时 ${byOutcome.timeout}** · 异常 ${byOutcome.error}`,
    `- 能力成功率（排除超时/异常）：${capability ?? '—'}%`,
    `- 吞吐：约 ${avgTokPerSec} token/秒`,
    ...(byOutcome.timeout / runs >= 0.3
      ? [
          ``,
          `> ⚠️ **超时占比 ${((byOutcome.timeout / runs) * 100).toFixed(0)}%，本次结果不能作为产品能力结论。**`,
          `> 超时反映的是模型速度或超时设置，与「会不会做」无关。推理型模型请加 \`/no_think\` 或换非推理模型，CPU 推理请上 GPU。`,
        ]
      : []),
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

  // 超时主导时退出 2（区别于「能力不达标」的 1），避免把环境问题误判为产品问题
  if (timeoutShare >= 0.3) process.exit(2);
  process.exit(Number(rate) >= 70 ? 0 : 1);
}

main();
