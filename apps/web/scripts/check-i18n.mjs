#!/usr/bin/env node
/**
 * i18n 体检脚本（不依赖任何三方库，node 直接跑）：
 *   1. zh-CN 与 en-US 的 key 集合必须完全一致（无缺漏 / 无多余）；
 *   2. 同一 key 的插值占位符 `{x}` 必须一致，避免翻译时漏掉变量；
 *   3. `src/` 下（排除 `src/i18n/`）不得再有引号内的中文字符串字面量。
 *
 * 用法：node apps/web/scripts/check-i18n.mjs
 * 退出码非 0 表示体检未通过。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(WEB_ROOT, 'src');
const I18N_DIR = join(SRC, 'i18n');

let failed = false;
const fail = (msg) => {
  failed = true;
  console.error(`✗ ${msg}`);
};
const ok = (msg) => console.log(`✓ ${msg}`);

// ── 1/2. 语言包对齐 ─────────────────────────────────────────
/** 从语言包源码里抽出 key 与文案（避免为跑脚本引入 TS 运行时）。 */
function parseLocale(file) {
  const src = readFileSync(file, 'utf8');
  const entries = new Map();
  // 匹配 'key': '值' / "key": "值"，值可跨行（模板里没有反引号字符串）
  const re = /^\s*'([^']+)':\s*((?:'(?:[^'\\]|\\.)*'\s*\+?\s*)+),?\s*$/gm;
  for (const m of src.matchAll(re)) {
    const value = m[2]
      .split(/'\s*\+\s*'/)
      .join('')
      .replace(/^'|'$/g, '')
      .replace(/\\'/g, "'");
    entries.set(m[1], value);
  }
  return entries;
}

const zh = parseLocale(join(I18N_DIR, 'locales', 'zh-CN.ts'));
const en = parseLocale(join(I18N_DIR, 'locales', 'en-US.ts'));

if (zh.size === 0 || en.size === 0) {
  fail(`语言包解析为空（zh-CN=${zh.size}, en-US=${en.size}），请检查脚本正则或文件格式`);
}

const missingInEn = [...zh.keys()].filter((k) => !en.has(k));
const extraInEn = [...en.keys()].filter((k) => !zh.has(k));
if (missingInEn.length) fail(`en-US 缺少 ${missingInEn.length} 个 key：\n    ${missingInEn.join('\n    ')}`);
if (extraInEn.length) fail(`en-US 多出 ${extraInEn.length} 个 key：\n    ${extraInEn.join('\n    ')}`);
if (!missingInEn.length && !extraInEn.length) ok(`两个语言包 key 完全一致（${zh.size} 条）`);

const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
for (const [key, zhValue] of zh) {
  const enValue = en.get(key);
  if (enValue === undefined) continue;
  if (placeholders(zhValue) !== placeholders(enValue)) {
    fail(`占位符不一致 [${key}]：zh-CN {${placeholders(zhValue)}} vs en-US {${placeholders(enValue)}}`);
  }
}

// ── 3. 中文字面量残留扫描 ───────────────────────────────────
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (p === I18N_DIR) continue; // 语言包本身允许中文
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(p)) {
      out.push(p);
    }
  }
  return out;
}

// 汉字 + CJK/全角标点（「」、：（）… 这类标点同样是中文文案，不能硬编码）
const CJK = /[一-鿿　-〿＀-￯]/;

/** 逐字符扫描，跳过 // 与 /* *\/ 注释，只在字符串/模板字面量内找中文。 */
function scanChineseLiterals(code) {
  const hits = [];
  let line = 1;
  let i = 0;
  const push = (start, end) => {
    const text = code.slice(start, end);
    if (CJK.test(text)) hits.push({ line, text: text.replace(/\s+/g, ' ').slice(0, 80) });
  };
  while (i < code.length) {
    const c = code[i];
    if (c === '\n') {
      line++;
      i++;
      continue;
    }
    if (c === '/' && code[i + 1] === '/') {
      while (i < code.length && code[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && code[i + 1] === '*') {
      i += 2;
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) {
        if (code[i] === '\n') line++;
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      const startLine = line;
      const start = ++i;
      while (i < code.length && code[i] !== quote) {
        if (code[i] === '\\') i++;
        else if (code[i] === '\n') line++;
        i++;
      }
      const savedLine = line;
      line = startLine;
      push(start, i);
      line = savedLine;
      i++;
      continue;
    }
    i++;
  }
  return hits;
}

/** JSX 文本节点（>中文<）不是字符串字面量，但同样是硬编码文案，一并检查。 */
function scanJsxText(code) {
  const hits = [];
  const lines = code.split('\n');
  lines.forEach((raw, idx) => {
    const line = raw.replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, '');
    // 开头允许 `>`（标签结束）或 `}`（相邻表达式），两者后面都可能跟裸文案
    for (const m of line.matchAll(
      /[>}]([^<>{}'"`]*[一-鿿　-〿＀-￯][^<>{}]*)</g,
    )) {
      const text = m[1].trim();
      if (text) hits.push({ line: idx + 1, text: text.slice(0, 80) });
    }
  });
  return hits;
}

const residues = [];
for (const file of walk(SRC)) {
  const code = readFileSync(file, 'utf8');
  const rel = relative(WEB_ROOT, file).split(sep).join('/');
  for (const h of scanChineseLiterals(code)) residues.push({ file: rel, kind: '字符串', ...h });
  for (const h of scanJsxText(code)) residues.push({ file: rel, kind: 'JSX 文本', ...h });
}

if (residues.length) {
  fail(`src/（排除 i18n/）仍有 ${residues.length} 处中文硬编码：`);
  for (const r of residues) console.error(`    ${r.file}:${r.line} [${r.kind}] ${r.text}`);
} else {
  ok('src/（排除 i18n/）无中文字符串字面量残留');
}

process.exit(failed ? 1 : 0);
