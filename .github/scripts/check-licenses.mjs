#!/usr/bin/env node
/**
 * Apolla Work 开源许可合规检查（CI 硬闸门）。
 *
 * 做什么
 *   1. 取 `pnpm licenses list --json`（或 --input 指定的同格式文件）作为全量依赖许可清单；
 *   2. 从 pnpm workspace 各包的 package.json 解析出**直接依赖**名单；
 *   3. 把每个包的 SPDX 许可表达式分类为 强 copyleft / 弱 copyleft / 宽松 / 未知；
 *   4. **直接依赖**里出现强 copyleft（GPL / AGPL / SSPL 系）→ 退出码 1，闸门不通过；
 *      传递依赖里出现 → 只告警（退出码 0），因为它们通常是构建期工具，需人工判断链接方式。
 *
 * 为什么这样分级
 *   强 copyleft 会传染到与之链接/分发的代码。直接依赖是我们自己引入的、可控的，
 *   必须零容忍；传递依赖需要看它是否真的被打进分发物，机器判不了，交给人。
 *
 *   MinIO 是 AGPL-3.0，但它是**独立进程**、经 S3 HTTP 协议调用、不与本仓库代码链接、
 *   也不打进任何 npm 包 —— 属于「聚合」而非「衍生作品」，不在本检查范围内。
 *   本脚本只看 npm 依赖树；容器镜像里的第三方组件由 infra/airgap-pack.sh 的 manifest.json 记录。
 *
 * 用法
 *   node .github/scripts/check-licenses.mjs
 *   node .github/scripts/check-licenses.mjs --input sbom-licenses.json --md-out report.md
 *
 * 选项
 *   --input FILE        读取已生成的 `pnpm licenses list --json` 输出（默认现场执行 pnpm）
 *   --md-out FILE       写 Markdown 报告
 *   --json-out FILE     写 JSON 报告（供后续处理）
 *   --allow NAME[,...]  豁免包名（已人工核实的例外），只对直接依赖的强 copyleft 生效
 *   --fail-on-unknown   把「许可未知」也视为不通过（默认只告警）
 *   -h, --help
 *
 * 退出码：0 通过 · 1 合规不通过 · 2 脚本自身出错
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ——————————————————————————————————————————————————————————
// 参数解析
// ——————————————————————————————————————————————————————————
function parseArgs(argv) {
  const opts = { input: null, mdOut: null, jsonOut: null, allow: new Set(), failOnUnknown: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`选项 ${a} 缺少取值`);
      return v;
    };
    switch (a) {
      case '--input':
        opts.input = next();
        break;
      case '--md-out':
        opts.mdOut = next();
        break;
      case '--json-out':
        opts.jsonOut = next();
        break;
      case '--allow':
        next()
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .forEach((s) => opts.allow.add(s));
        break;
      case '--fail-on-unknown':
        opts.failOnUnknown = true;
        break;
      case '-h':
      case '--help':
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`未知选项：${a}（用 --help 看用法）`);
    }
  }
  return opts;
}

function printHelp() {
  const header = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
  const end = header.findIndex((l) => l.startsWith(' */'));
  console.log(
    header
      .slice(0, end + 1)
      .join('\n')
      .replace(/^#!.*\n/, ''),
  );
}

// ——————————————————————————————————————————————————————————
// SPDX 许可分类
// ——————————————————————————————————————————————————————————
/** 严重度：数值越大越受限，用于 OR（取最宽松）/ AND（取最严格）合并。 */
const SEVERITY = { permissive: 0, unknown: 1, weak: 2, strong: 3 };
const SEVERITY_NAME = ['permissive', 'unknown', 'weak', 'strong'];

/** 单个 SPDX 标识符 → 类别。注意 LGPL 必须在 GPL 之前判，否则会被 GPL 前缀误吞。 */
function classifyToken(raw) {
  const id = String(raw || '')
    .trim()
    .replace(/^\(+|\)+$/g, '')
    .replace(/\+$/, '')
    .toUpperCase();
  if (!id || id === 'UNKNOWN' || id === 'UNLICENSED' || id === 'SEE LICENSE IN LICENSE' || id === 'NULL') {
    return 'unknown';
  }
  // 弱 copyleft：按文件/库边界传染，链接调用不传染 —— 只提示，不阻断
  if (/^LGPL/.test(id)) return 'weak';
  if (/^(MPL|EPL|CDDL|CPL|MS-RL|EUPL|OSL|APSL|SLEEPYCAT)/.test(id)) return 'weak';
  // 强 copyleft：会传染到与之链接/分发的代码 —— 直接依赖零容忍
  if (/^A?GPL/.test(id)) return 'strong';
  if (/^(SSPL|CPAL|RPL|QPL|BUSL|ELASTIC|SSPL-1\.0)/.test(id)) return 'strong';
  // 常见宽松许可
  if (
    /^(MIT|ISC|APACHE|BSD|0BSD|BSL-1\.0|UNLICENSE|WTFPL|CC0|CC-BY|PYTHON|ZLIB|BLUEOAK|PSF|ARTISTIC|X11|BEERWARE)/.test(
      id,
    )
  ) {
    return 'permissive';
  }
  return 'unknown';
}

/**
 * 解析 SPDX 表达式。
 * 口径：OR = 我们可以选最宽松的那支；AND = 必须同时满足，取最严格的那支。
 * 简化：不处理嵌套括号优先级（依赖清单里几乎不出现），按 AND 顶层切分后各段内按 OR 取最小。
 */
function classifyExpression(expr) {
  const s = String(expr || '').trim();
  if (!s) return 'unknown';
  const andParts = s.split(/\s+AND\s+/i);
  let worst = SEVERITY.permissive;
  for (const part of andParts) {
    const orParts = part.split(/\s+OR\s+/i);
    let best = SEVERITY.strong;
    for (const t of orParts) {
      best = Math.min(best, SEVERITY[classifyToken(t)]);
    }
    worst = Math.max(worst, best);
  }
  return SEVERITY_NAME[worst];
}

// ——————————————————————————————————————————————————————————
// workspace 直接依赖
// ——————————————————————————————————————————————————————————
/** 极简 pnpm-workspace.yaml 解析：只认 `- pattern` 列表项，支持字面路径与结尾 `/*`。 */
function readWorkspacePatterns() {
  const f = path.join(REPO_ROOT, 'pnpm-workspace.yaml');
  if (!fs.existsSync(f)) return [];
  return fs
    .readFileSync(f, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim().replace(/^['"]|['"]$/g, ''))
    .filter((p) => p && !p.startsWith('!'));
}

function expandPattern(pattern) {
  if (!pattern.includes('*')) {
    const p = path.join(REPO_ROOT, pattern);
    return fs.existsSync(path.join(p, 'package.json')) ? [p] : [];
  }
  const [base, tail] = pattern.split('*');
  const dir = path.join(REPO_ROOT, base);
  if (tail && tail !== '' && tail !== '/') return []; // 只支持结尾通配
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== 'node_modules')
    .map((d) => path.join(dir, d.name))
    .filter((p) => fs.existsSync(path.join(p, 'package.json')));
}

/** 返回 Map<依赖名, Set<声明它的 workspace 包名>>；跳过 workspace: 内部包。 */
function collectDirectDeps() {
  const roots = [REPO_ROOT, ...readWorkspacePatterns().flatMap(expandPattern)];
  const direct = new Map();
  const workspacePkgNames = new Set();
  const seen = new Set();
  for (const root of roots) {
    const pj = path.join(root, 'package.json');
    if (seen.has(pj) || !fs.existsSync(pj)) continue;
    seen.add(pj);
    let json;
    try {
      json = JSON.parse(fs.readFileSync(pj, 'utf8'));
    } catch (e) {
      throw new Error(`解析 ${pj} 失败：${e.message}`);
    }
    if (json.name) workspacePkgNames.add(json.name);
    const owner = json.name || path.relative(REPO_ROOT, root) || '<root>';
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [name, range] of Object.entries(json[field] || {})) {
        if (typeof range === 'string' && range.startsWith('workspace:')) continue; // 内部包
        if (!direct.has(name)) direct.set(name, new Set());
        direct.get(name).add(owner);
      }
    }
  }
  for (const n of workspacePkgNames) direct.delete(n); // 本仓库自己的包不参与外部许可判定
  return direct;
}

// ——————————————————————————————————————————————————————————
// 许可清单
// ——————————————————————————————————————————————————————————
function loadLicenseInventory(inputFile) {
  let raw;
  if (inputFile) {
    raw = fs.readFileSync(path.resolve(inputFile), 'utf8');
  } else {
    // pnpm 在 workspace 根执行；--json 输出形如 { "MIT": [ {name, versions, license, ...}, ... ] }
    raw = execFileSync('pnpm', ['licenses', 'list', '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
  }
  const parsed = JSON.parse(raw);
  const pkgs = [];
  for (const [licenseKey, entries] of Object.entries(parsed)) {
    for (const e of entries || []) {
      pkgs.push({
        name: e.name,
        versions: Array.isArray(e.versions) ? e.versions : [],
        license: e.license || licenseKey,
        homepage: e.homepage || '',
      });
    }
  }
  return pkgs;
}

// ——————————————————————————————————————————————————————————
// 主流程
// ——————————————————————————————————————————————————————————
function main() {
  const opts = parseArgs(process.argv.slice(2));

  console.log('==> Apolla Work 开源许可合规检查');
  const directDeps = collectDirectDeps();
  console.log(`    workspace 直接依赖：${directDeps.size} 个（不含内部 workspace: 包）`);

  const inventory = loadLicenseInventory(opts.input);
  console.log(`    依赖清单条目：${inventory.length} 个包`);

  const byCategory = { strong: [], weak: [], unknown: [], permissive: [] };
  const licenseCount = new Map();
  for (const p of inventory) {
    const category = classifyExpression(p.license);
    const isDirect = directDeps.has(p.name);
    const rec = {
      ...p,
      category,
      direct: isDirect,
      requiredBy: isDirect ? [...directDeps.get(p.name)].sort() : [],
    };
    byCategory[category].push(rec);
    licenseCount.set(p.license, (licenseCount.get(p.license) || 0) + 1);
  }

  const violations = byCategory.strong.filter((p) => p.direct && !opts.allow.has(p.name));
  const allowed = byCategory.strong.filter((p) => p.direct && opts.allow.has(p.name));
  const strongTransitive = byCategory.strong.filter((p) => !p.direct);
  const unknownDirect = byCategory.unknown.filter((p) => p.direct);

  // —— 终端输出 ——
  console.log('');
  console.log('    分类统计：');
  console.log(`      宽松（MIT/Apache/BSD/ISC…）：${byCategory.permissive.length}`);
  console.log(`      弱 copyleft（LGPL/MPL/EPL…）：${byCategory.weak.length}`);
  console.log(`      强 copyleft（GPL/AGPL/SSPL…）：${byCategory.strong.length}`);
  console.log(`      未知/未声明：${byCategory.unknown.length}`);
  console.log('');

  if (byCategory.weak.length) {
    console.log('    弱 copyleft（不阻断，确认未静态链接即可）：');
    for (const p of byCategory.weak) {
      console.log(`      - ${p.name}@${p.versions.join(',')} · ${p.license}${p.direct ? ' [直接依赖]' : ''}`);
    }
    console.log('');
  }

  if (strongTransitive.length) {
    console.log('    ⚠️ 强 copyleft（传递依赖，只告警 —— 请人工确认是否进入分发物）：');
    for (const p of strongTransitive) console.log(`      - ${p.name}@${p.versions.join(',')} · ${p.license}`);
    console.log('');
  }

  if (allowed.length) {
    console.log('    ℹ️ 已豁免的强 copyleft 直接依赖（--allow）：');
    for (const p of allowed) console.log(`      - ${p.name}@${p.versions.join(',')} · ${p.license}`);
    console.log('');
  }

  if (unknownDirect.length) {
    console.log(`    ${opts.failOnUnknown ? '❌' : '⚠️'} 许可未知的直接依赖：`);
    for (const p of unknownDirect) console.log(`      - ${p.name}@${p.versions.join(',')} · ${p.license || '(未声明)'}`);
    console.log('');
  }

  const failed = violations.length > 0 || (opts.failOnUnknown && unknownDirect.length > 0);

  if (violations.length) {
    console.log('    ❌ 合规不通过：以下**直接依赖**为强 copyleft，会传染本仓库代码：');
    for (const p of violations) {
      console.log(`      - ${p.name}@${p.versions.join(',')} · ${p.license}`);
      console.log(`        引入方：${p.requiredBy.join(', ')}`);
    }
    console.log('');
    console.log('    处理办法：换成宽松许可的等价库；或确认为独立进程调用（非链接）后用 --allow 豁免并在 docs/ops.md 记录理由。');
  } else {
    console.log('    ✅ 合规通过：直接依赖中未发现 GPL / AGPL / SSPL 系强 copyleft。');
  }

  // —— 报告 ——
  const report = {
    generatedAt: new Date().toISOString(),
    totals: {
      inventory: inventory.length,
      directDeps: directDeps.size,
      permissive: byCategory.permissive.length,
      weak: byCategory.weak.length,
      strong: byCategory.strong.length,
      unknown: byCategory.unknown.length,
    },
    licenseHistogram: Object.fromEntries([...licenseCount.entries()].sort((a, b) => b[1] - a[1])),
    violations,
    allowed,
    strongTransitive,
    weak: byCategory.weak,
    unknownDirect,
    passed: !failed,
  };

  if (opts.jsonOut) {
    fs.mkdirSync(path.dirname(path.resolve(opts.jsonOut)), { recursive: true });
    fs.writeFileSync(path.resolve(opts.jsonOut), JSON.stringify(report, null, 2));
    console.log(`    JSON 报告 → ${opts.jsonOut}`);
  }

  if (opts.mdOut) {
    fs.mkdirSync(path.dirname(path.resolve(opts.mdOut)), { recursive: true });
    fs.writeFileSync(path.resolve(opts.mdOut), renderMarkdown(report));
    console.log(`    Markdown 报告 → ${opts.mdOut}`);
  }

  process.exit(failed ? 1 : 0);
}

function renderMarkdown(r) {
  const L = [];
  L.push('### 开源许可合规');
  L.push('');
  L.push(r.passed ? '**结论：✅ 通过**' : '**结论：❌ 不通过**');
  L.push('');
  L.push(`- 依赖清单条目：${r.totals.inventory}（其中直接依赖 ${r.totals.directDeps}）`);
  L.push(
    `- 宽松 ${r.totals.permissive} · 弱 copyleft ${r.totals.weak} · 强 copyleft ${r.totals.strong} · 未知 ${r.totals.unknown}`,
  );
  L.push('');

  L.push('| 许可 | 包数 |');
  L.push('|---|---:|');
  for (const [lic, n] of Object.entries(r.licenseHistogram)) L.push(`| ${lic} | ${n} |`);
  L.push('');

  if (r.violations.length) {
    L.push('#### ❌ 强 copyleft 直接依赖（阻断）');
    L.push('');
    L.push('| 包 | 版本 | 许可 | 引入方 |');
    L.push('|---|---|---|---|');
    for (const p of r.violations) {
      L.push(`| \`${p.name}\` | ${p.versions.join(', ')} | ${p.license} | ${p.requiredBy.join(', ')} |`);
    }
    L.push('');
  }

  if (r.strongTransitive.length) {
    L.push('#### ⚠️ 强 copyleft 传递依赖（告警，需人工确认）');
    L.push('');
    for (const p of r.strongTransitive) L.push(`- \`${p.name}@${p.versions.join(', ')}\` — ${p.license}`);
    L.push('');
  }

  if (r.weak.length) {
    L.push('#### 弱 copyleft（LGPL / MPL / EPL 等，不阻断）');
    L.push('');
    for (const p of r.weak) {
      L.push(`- \`${p.name}@${p.versions.join(', ')}\` — ${p.license}${p.direct ? ' · 直接依赖' : ''}`);
    }
    L.push('');
  }

  if (r.unknownDirect.length) {
    L.push('#### 许可未知的直接依赖');
    L.push('');
    for (const p of r.unknownDirect) L.push(`- \`${p.name}@${p.versions.join(', ')}\` — ${p.license || '(未声明)'}`);
    L.push('');
  }

  L.push('> 范围：仅 npm 依赖树。MinIO（AGPL-3.0）以独立服务经 S3 协议调用、不与本仓库代码链接，');
  L.push('> 不在此检查内；容器镜像内第三方组件由 `infra/airgap-pack.sh` 的 `manifest.json` 记录。');
  L.push('');
  return L.join('\n');
}

try {
  main();
} catch (e) {
  console.error('许可检查脚本出错：', e?.message || e);
  process.exit(2);
}
