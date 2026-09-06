import { PrismaClient } from '@prisma/client';
import { resolveDatabaseUrl } from '../prisma.service.js';
import { currentKeyId, keyIdOf, needsRotation, rotateSecret } from '../common/crypto.js';

/**
 * 主密钥轮换（T-406）：把库里所有用旧主钥（或旧格式 v1）加密的密文重加密为当前主钥。
 *   APOLLA_MASTER_KEY=<新> APOLLA_MASTER_KEY_PREVIOUS=<旧,...> node dist/cli/rotate-key.js [--dry-run]
 * 解不开的密文逐条报出并以非零退出 —— 绝不静默跳过，否则删了旧钥那条配置就永久丢了。
 */
async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const prisma = new PrismaClient({ datasourceUrl: resolveDatabaseUrl() });
  const stat = { rotated: 0, upToDate: 0, failed: 0 };
  const failures: string[] = [];

  const handle = async (label: string, blob: string | null | undefined, save: (enc: string) => Promise<unknown>) => {
    if (!blob) return;
    if (!needsRotation(blob)) {
      stat.upToDate++;
      return;
    }
    try {
      const enc = rotateSecret(blob);
      if (!dryRun) await save(enc);
      stat.rotated++;
      console.log(`${dryRun ? '[预演] ' : ''}已轮换 ${label}（${keyIdOf(blob) ?? 'v1'} → ${currentKeyId()}）`);
    } catch (e) {
      stat.failed++;
      failures.push(`${label}: ${(e as Error).message}`);
    }
  };

  try {
    for (const p of await prisma.modelProvider.findMany()) {
      await handle(`模型接入 ${p.name}(${p.id})`, p.keyEnc, (enc) =>
        prisma.modelProvider.update({ where: { id: p.id }, data: { keyEnc: enc } }),
      );
    }
    for (const c of await prisma.connector.findMany()) {
      await handle(`连接器 ${c.name}(${c.id})`, c.configEnc, (enc) =>
        prisma.connector.update({ where: { id: c.id }, data: { configEnc: enc } }),
      );
    }
    if (!dryRun && stat.rotated) {
      await prisma.auditEvent.create({
        data: {
          actor: 'system:rotate-key',
          action: 'secret.rotate',
          detail: JSON.stringify({ ...stat, kid: currentKeyId() }),
        },
      });
    }
  } finally {
    await prisma.$disconnect();
  }

  for (const f of failures) console.error(`❌ ${f}`);
  console.log(
    `${dryRun ? '预演' : '轮换'}完成：已轮换 ${stat.rotated} · 已是当前钥 ${stat.upToDate} · 失败 ${stat.failed} · 当前 kid ${currentKeyId()}`,
  );
  if (stat.failed) {
    console.error('有密文无法解密：请把对应旧钥加入 APOLLA_MASTER_KEY_PREVIOUS 后重跑；在此之前不要删除旧钥。');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('轮换失败：', e);
  process.exit(1);
});
