import fs from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import { createTwoFilesPatch } from 'diff';
import { EditInput, GlobInput, ReadInput, WriteInput } from '@apolla/protocol';
import type { z } from 'zod';
import { fail, ok, type ToolContext, type ToolDef } from '../context.js';
import { looksBinaryByExt, resolveSafe, toRel } from '../paths.js';
import { middleTruncate } from '../truncate.js';

const DEFAULT_READ_LINES = 500;
const MAX_LINE_CHARS = 2000;

export const readTool: ToolDef<z.infer<typeof ReadInput>> = {
  name: 'Read',
  description:
    '读取工作区内文件。文本文件返回带行号内容（默认前 500 行，可用 offset/limit 翻页）；二进制文件返回元信息。',
  schema: ReadInput,
  async execute(input, ctx) {
    const abs = resolveSafe(ctx.workspaceDir, input.path);
    if (!fs.existsSync(abs)) return fail(`文件不存在：${input.path}`);
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(abs).slice(0, 200);
      return ok(`（目录）${input.path}，共 ${entries.length} 项：\n${entries.join('\n')}`);
    }
    if (looksBinaryByExt(abs)) {
      return ok(
        `（二进制文件）${input.path}\n大小：${stat.size} 字节。请用 Bash 调用相应的解析命令/脚本处理（如 python 处理 xlsx/docx/pdf）。`,
      );
    }
    const raw = fs.readFileSync(abs, 'utf8');
    const lines = raw.split('\n');
    const offset = input.offset ?? 0;
    const limit = input.limit ?? DEFAULT_READ_LINES;
    const slice = lines.slice(offset, offset + limit);
    const body = slice
      .map((l, i) => {
        const line = l.length > MAX_LINE_CHARS ? l.slice(0, MAX_LINE_CHARS) + '…' : l;
        return `${String(offset + i + 1).padStart(5)}\t${line}`;
      })
      .join('\n');
    const more =
      offset + limit < lines.length
        ? `\n…（共 ${lines.length} 行，还有 ${lines.length - offset - limit} 行未显示，用 offset=${offset + limit} 继续读）`
        : '';
    return ok(body + more);
  },
};

export const writeTool: ToolDef<z.infer<typeof WriteInput>> = {
  name: 'Write',
  description: '写入（新建或覆盖）工作区内文件。覆盖已有文件前请先 Read 确认。',
  schema: WriteInput,
  async execute(input, ctx) {
    const abs = resolveSafe(ctx.workspaceDir, input.path);
    const exists = fs.existsSync(abs);
    const before = exists ? fs.readFileSync(abs, 'utf8') : '';
    if (exists && ctx.mode === 'ask') {
      const approved = await ctx.requestApproval({
        kind: 'file_overwrite',
        title: `覆盖文件 ${toRel(ctx.workspaceDir, abs)}`,
        detail: `原文件 ${before.length} 字符 → 新内容 ${input.content.length} 字符`,
      });
      if (!approved) return fail('用户拒绝了覆盖操作。请改用其他文件名或询问用户。');
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, input.content, 'utf8');
    if (!looksBinaryByExt(abs)) {
      const rel = toRel(ctx.workspaceDir, abs);
      const patch = createTwoFilesPatch(rel, rel, before, input.content, '', '', { context: 3 });
      ctx.emit({ v: 1, type: 'file.diff', path: rel, patch: middleTruncate(patch, 20_000) });
    }
    return ok(`已写入 ${toRel(ctx.workspaceDir, abs)}（${input.content.length} 字符）`);
  },
};

export const editTool: ToolDef<z.infer<typeof EditInput>> = {
  name: 'Edit',
  description:
    '对文件做精确字符串替换。old 必须与文件内容完全一致且（默认）唯一，否则报错——不要猜测缩进。',
  schema: EditInput,
  async execute(input, ctx) {
    const abs = resolveSafe(ctx.workspaceDir, input.path);
    if (!fs.existsSync(abs)) return fail(`文件不存在：${input.path}`);
    const before = fs.readFileSync(abs, 'utf8');
    const count = before.split(input.old).length - 1;
    if (count === 0) return fail('old 未在文件中找到（必须精确匹配，含空白/缩进）。先 Read 再试。');
    if (count > 1 && !input.all) return fail(`old 出现了 ${count} 次，不唯一。加大上下文或设 all=true。`);
    if (ctx.mode === 'ask') {
      const approved = await ctx.requestApproval({
        kind: 'file_overwrite',
        title: `编辑文件 ${toRel(ctx.workspaceDir, abs)}`,
        detail: `替换 ${input.all ? count : 1} 处，共 ${input.old.length}→${input.new.length} 字符`,
      });
      if (!approved) return fail('用户拒绝了本次编辑。');
    }
    const after = input.all
      ? before.split(input.old).join(input.new)
      : before.replace(input.old, input.new);
    fs.writeFileSync(abs, after, 'utf8');
    const rel = toRel(ctx.workspaceDir, abs);
    const patch = createTwoFilesPatch(rel, rel, before, after, '', '', { context: 3 });
    ctx.emit({ v: 1, type: 'file.diff', path: rel, patch: middleTruncate(patch, 20_000) });
    return ok(`已替换 ${input.all ? count : 1} 处。`);
  },
};

export const globTool: ToolDef<z.infer<typeof GlobInput>> = {
  name: 'Glob',
  description: '按通配符列出工作区文件（如 **/*.xlsx），按修改时间倒序，最多 200 条。',
  schema: GlobInput,
  async execute(input, ctx) {
    const files = await fg(input.pattern, {
      cwd: ctx.workspaceDir,
      dot: false,
      ignore: ['**/node_modules/**', '**/.git/**', '.apolla/**'],
      onlyFiles: true,
      stats: true,
    });
    const sorted = files
      .sort((a, b) => (b.stats?.mtimeMs ?? 0) - (a.stats?.mtimeMs ?? 0))
      .slice(0, 200)
      .map((f) => f.path);
    if (sorted.length === 0) return ok('（无匹配文件）');
    return ok(sorted.join('\n'));
  },
};
