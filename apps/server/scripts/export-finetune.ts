/**
 * 评测-微调闭环（PRD T-303）：从事件溯源导出微调/蒸馏数据集。
 *
 * 把历史任务的完整轨迹（用户指令 + Agent 消息 + 工具调用与结果）导出为
 * OpenAI 对话式 JSONL，可直接用于 SFT/蒸馏。支持按结果过滤（只导成功任务）。
 *
 * 用法：
 *   DATABASE_URL_PRISMA=file:./dev.db npx tsx scripts/export-finetune.ts --out ft.jsonl [--only completed] [--min-steps 2]
 */
import fs from 'node:fs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL_PRISMA ?? 'file:./dev.db' } },
});

function arg(name: string, def?: string) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

async function main() {
  const out = arg('--out', 'finetune.jsonl')!;
  const only = arg('--only'); // completed | failed | undefined(all)
  const minSteps = Number(arg('--min-steps', '1'));

  const tasks = await prisma.task.findMany({
    where: only ? { status: only } : {},
    include: { events: { orderBy: { seq: 'asc' } } },
  });

  const lines: string[] = [];
  let kept = 0;
  for (const task of tasks) {
    const messages: { role: string; content: string }[] = [
      { role: 'user', content: task.prompt },
    ];
    let steps = 0;
    for (const row of task.events) {
      const e = JSON.parse(row.payload) as { type: string; [k: string]: any };
      if (e.type === 'message.completed' && e.role === 'assistant' && e.text?.trim()) {
        messages.push({ role: 'assistant', content: e.text });
      } else if (e.type === 'tool.call') {
        steps++;
        messages.push({ role: 'assistant', content: `[调用工具 ${e.name}] ${e.argsPreview ?? ''}` });
      } else if (e.type === 'tool.result') {
        messages.push({ role: 'tool', content: (e.resultPreview ?? '').slice(0, 500) });
      }
    }
    if (steps < minSteps || messages.length < 2) continue;
    lines.push(JSON.stringify({ messages, meta: { taskId: task.id, status: task.status } }));
    kept++;
  }

  fs.writeFileSync(out, lines.join('\n') + (lines.length ? '\n' : ''));
  console.log(`导出 ${kept}/${tasks.length} 个任务轨迹 → ${out}`);
  console.log('下一步：人工/规则筛选高质量样本 → SFT/蒸馏（对接企业训练平台，平台侧零耦合）。');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
