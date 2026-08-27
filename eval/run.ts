import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTask, type EventSink, type ControlSource } from '@apolla/runtime';
import type { TaskEvent } from '@apolla/protocol';
import { SCENARIOS } from './golden/scenarios.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_ROOT = path.resolve(__dirname, '../skills');

/** 评测控制源：危险操作默认拒绝（验证安全闸门），不追加输入。 */
class EvalControl implements ControlSource {
  async waitApproval() {
    return false; // 默认拒绝 → 验证危险命令确实被拦截
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

class SilentSink implements EventSink {
  events: TaskEvent[] = [];
  emit(e: TaskEvent) {
    this.events.push(e);
  }
}

interface Result {
  id: string;
  name: string;
  passed: number;
  total: number;
  ok: boolean;
  status: string;
  ms: number;
  failedChecks: string[];
}

async function runOne(s: (typeof SCENARIOS)[number]): Promise<Result> {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), `apolla-eval-${s.id}-`));
  s.setup?.(ws);
  const sink = new SilentSink();
  const t0 = Date.now();
  let status = 'error';
  try {
    const res = await runTask(
      {
        prompt: s.prompt,
        workspaceDir: ws,
        mode: 'auto',
        modelConfig: { model: 'mock' },
        skillRoots: [SKILLS_ROOT],
      },
      sink,
      new EvalControl(),
    );
    status = res.status;
  } catch (e) {
    status = `error: ${(e as Error).message}`;
  }
  const failedChecks: string[] = [];
  let passed = 0;
  for (const c of s.checks) {
    let ok = false;
    try {
      ok = c.test(ws);
    } catch {
      ok = false;
    }
    if (ok) passed++;
    else failedChecks.push(c.desc);
  }
  return {
    id: s.id,
    name: s.name,
    passed,
    total: s.checks.length,
    ok: passed === s.checks.length,
    status,
    ms: Date.now() - t0,
    failedChecks,
  };
}

async function main() {
  console.log(`\n运行黄金场景评测（${SCENARIOS.length} 项）· 模型 mock · 技能 ${SKILLS_ROOT}\n`);
  const results: Result[] = [];
  for (const s of SCENARIOS) {
    const r = await runOne(s);
    results.push(r);
    const mark = r.ok ? '✅' : '❌';
    console.log(`${mark} ${r.id.padEnd(20)} ${r.name.padEnd(24)} ${r.passed}/${r.total}  ${r.ms}ms`);
    if (!r.ok) r.failedChecks.forEach((f) => console.log(`     ↳ 未通过：${f} (status=${r.status})`));
  }

  const scenariosPassed = results.filter((r) => r.ok).length;
  const rate = ((scenariosPassed / results.length) * 100).toFixed(0);
  const checksPassed = results.reduce((n, r) => n + r.passed, 0);
  const checksTotal = results.reduce((n, r) => n + r.total, 0);
  const avgMs = Math.round(results.reduce((n, r) => n + r.ms, 0) / results.length);

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`场景通过：${scenariosPassed}/${results.length}（${rate}%）· 校验点：${checksPassed}/${checksTotal} · 平均 ${avgMs}ms`);

  // markdown 报告
  const md = [
    '# Apolla Work 黄金场景评测报告',
    '',
    `- 日期：${process.env.EVAL_DATE ?? '(运行时)'}`,
    `- 模型：mock（确定性）`,
    `- 场景通过率：**${scenariosPassed}/${results.length}（${rate}%）**`,
    `- 校验点通过：${checksPassed}/${checksTotal}`,
    `- 平均耗时：${avgMs}ms`,
    '',
    '| 场景 | 名称 | 校验点 | 耗时 | 结果 |',
    '|---|---|---|---|---|',
    ...results.map(
      (r) => `| ${r.id} | ${r.name} | ${r.passed}/${r.total} | ${r.ms}ms | ${r.ok ? '✅' : '❌'} |`,
    ),
    '',
    '> mock 模型驱动的确定性评测：脚本经真实工具/Python 执行，校验点针对真实产物断言。',
    '> 生产替换为工具调用型 LLM 后，脚本改为自然语言 prompt，校验点复用。',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(__dirname, 'report.md'), md);
  console.log(`报告已写入 eval/report.md\n`);

  // 发布闸门：全绿才 exit 0
  process.exit(scenariosPassed === results.length ? 0 : 1);
}

main();
