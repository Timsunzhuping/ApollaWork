import fs from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { resolveDatabaseUrl } from '../prisma.service.js';
import { exportOrg, fromJsonl, importOrg, toJsonl, type TransferPrisma } from '../org/org-transfer.js';

/**
 * 组织迁移 CLI（T-418）
 *   node dist/cli/org-transfer.js export <orgId> <out.jsonl>
 *   node dist/cli/org-transfer.js import <in.jsonl>
 * 只搬数据库行。工作区文件（<STORAGE>/workspaces/<wsId>/）与审计归档请用 mc mirror 按前缀同步。
 */
async function main() {
  const [cmd, a, b] = process.argv.slice(2);
  if (!cmd || (cmd === 'export' && (!a || !b)) || (cmd === 'import' && !a) || !['export', 'import'].includes(cmd)) {
    console.error('用法：org-transfer export <orgId> <out.jsonl> | import <in.jsonl>');
    process.exit(2);
  }
  const prisma = new PrismaClient({ datasourceUrl: resolveDatabaseUrl() });
  try {
    if (cmd === 'export') {
      const lines = await exportOrg(prisma as unknown as TransferPrisma, a!);
      fs.writeFileSync(b!, toJsonl(lines));
      const byTable = lines.reduce<Record<string, number>>((m, l) => ((m[l.table] = (m[l.table] ?? 0) + 1), m), {});
      console.log(`已导出组织 ${a} → ${b}：${lines.length} 行`, byTable);
      console.log('提醒：工作区文件与审计归档在对象存储里，请另行按前缀同步。');
    } else {
      const lines = fromJsonl(fs.readFileSync(a!, 'utf8'));
      const counts = await importOrg(prisma as unknown as TransferPrisma, lines);
      console.log(`已导入 ${lines.length} 行`, counts);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error('迁移失败：', e);
  process.exit(1);
});
