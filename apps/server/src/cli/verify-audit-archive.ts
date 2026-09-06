import fs from 'node:fs';
import path from 'node:path';
import { GENESIS, verifyAuditArchive } from '../audit/audit-archive.js';

/**
 * 校验审计归档（T-405）：单个 .jsonl 或整个目录（按文件名排序，逐文件接链）。
 *   node dist/cli/verify-audit-archive.js <文件或目录> [--prev <链头>]
 * 退出码：0 全部通过；1 有文件被篡改/断链；2 参数错误。
 */
function main() {
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith('--'));
  const prevIdx = args.indexOf('--prev');
  let prev = prevIdx >= 0 ? (args[prevIdx + 1] ?? GENESIS) : GENESIS;
  if (!target) {
    console.error('用法：verify-audit-archive <文件或目录> [--prev <链头>]');
    process.exit(2);
  }
  const files = fs.statSync(target).isDirectory()
    ? fs
        .readdirSync(target, { recursive: true, withFileTypes: true })
        .filter((d) => d.isFile() && d.name.endsWith('.jsonl'))
        .map((d) => path.join(d.parentPath ?? (d as unknown as { path: string }).path, d.name))
        .sort()
    : [target];

  let bad = 0;
  for (const f of files) {
    const v = verifyAuditArchive(fs.readFileSync(f, 'utf8'), prev);
    if (v.ok) {
      console.log(`✅ ${f}  ${v.count} 行  链头 ${v.lastHash.slice(0, 12)}`);
      prev = v.lastHash;
    } else {
      bad++;
      console.error(`❌ ${f}  第 ${v.brokenAt} 行起哈希链断裂（该行或之前某行被篡改/删除/插入）`);
      break; // 断链后后续文件无法再接
    }
  }
  console.log(bad ? `校验失败：${bad} 个文件` : `全部 ${files.length} 个文件通过，最终链头 ${prev}`);
  process.exit(bad ? 1 : 0);
}

main();
