// 从 schema.prisma 派生 SQLite 版 schema（开发/e2e 零依赖起步，ADR-002）。
// schema 只用可移植类型，两者仅 provider 不同；生成文件不入库。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 路径含空格时 URL 会被编码成 %20，必须用 fileURLToPath 还原
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../prisma');
const src = fs.readFileSync(path.join(dir, 'schema.prisma'), 'utf8');
const out = src.replace(/provider\s*=\s*"postgresql"/, 'provider = "sqlite"');
if (out === src) throw new Error('schema.prisma 里没有 provider = "postgresql"，请检查');
fs.writeFileSync(path.join(dir, 'schema.sqlite.prisma'), '// 由 scripts/schema-sqlite.mjs 生成，勿手改\n' + out);
console.log('已生成 prisma/schema.sqlite.prisma');
