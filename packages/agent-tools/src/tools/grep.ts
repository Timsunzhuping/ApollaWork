import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import fg from 'fast-glob';
import { GrepInput } from '@apolla/protocol';
import type { z } from 'zod';
import { ok, fail, type ToolDef } from '../context.js';
import { resolveSafe } from '../paths.js';
import { looksBinaryByExt } from '../paths.js';

let rgPath: string | null | undefined;

async function findRg(): Promise<string | null> {
  if (rgPath !== undefined) return rgPath;
  rgPath = await new Promise<string | null>((resolve) => {
    execFile('/bin/sh', ['-c', 'command -v rg'], (err, stdout) => {
      const p = stdout?.trim();
      resolve(!err && p && fs.existsSync(p) ? p : null);
    });
  });
  return rgPath;
}

async function rgSearch(
  rg: string,
  pattern: string,
  dir: string,
  ignoreCase: boolean,
  max: number,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const args = ['-n', '--no-heading', '--color', 'never', '-m', String(max)];
    if (ignoreCase) args.push('-i');
    args.push('-e', pattern, '.');
    execFile(rg, args, { cwd: dir, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      // rg 无匹配时退出码 1，不是错误
      if (err && (err as NodeJS.ErrnoException & { code?: number }).code === 1 && !stdout) {
        return resolve([]);
      }
      if (err && !stdout) return reject(err);
      resolve(stdout.split('\n').filter(Boolean));
    });
  });
}

async function jsSearch(
  pattern: string,
  dir: string,
  ignoreCase: boolean,
  max: number,
): Promise<string[]> {
  const re = new RegExp(pattern, ignoreCase ? 'i' : '');
  const files = await fg('**/*', {
    cwd: dir,
    dot: false,
    onlyFiles: true,
    ignore: ['**/node_modules/**', '**/.git/**', '.apolla/**'],
  });
  const out: string[] = [];
  for (const f of files) {
    if (looksBinaryByExt(f)) continue;
    const abs = path.join(dir, f);
    let text: string;
    try {
      if (fs.statSync(abs).size > 2 * 1024 * 1024) continue;
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        out.push(`${f}:${i + 1}:${lines[i].slice(0, 400)}`);
        if (out.length >= max) return out;
      }
    }
  }
  return out;
}

export const grepTool: ToolDef<z.infer<typeof GrepInput>> = {
  name: 'Grep',
  description: '在工作区文件内容中按正则搜索，返回 文件:行号:内容。',
  schema: GrepInput,
  async execute(input, ctx) {
    const dir = input.path ? resolveSafe(ctx.workspaceDir, input.path) : ctx.workspaceDir;
    const max = input.maxResults ?? 100;
    try {
      const rg = await findRg();
      const lines = rg
        ? await rgSearch(rg, input.pattern, dir, !!input.ignoreCase, max)
        : await jsSearch(input.pattern, dir, !!input.ignoreCase, max);
      if (lines.length === 0) return ok('（无匹配）');
      return ok(lines.slice(0, max).join('\n'));
    } catch (e) {
      return fail(`搜索失败：${(e as Error).message}`);
    }
  },
};
