#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import { runTask } from './runner.js';
import { CliSink } from './cli-sink.js';
import { CliControl } from './cli-control.js';
import { modelConfigFromEnv } from './model-factory.js';
import type { PermissionMode } from '@apolla/protocol';

/**
 * 本地试跑器（T-009）：
 *   apolla-dev run "<prompt>" --workspace ./demo [--mode auto|ask|plan] [--yes]
 */
function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  if (args[0] !== 'run' || !args[1]) {
    console.error('用法：apolla-dev run "<prompt>" --workspace <dir> [--mode auto|ask|plan] [--yes]');
    process.exit(1);
  }
  const prompt = args[1];
  const get = (flag: string, def?: string) => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1] : def;
  };
  return {
    prompt,
    workspace: path.resolve(get('--workspace', './demo-workspace')!),
    mode: (get('--mode', 'auto') as PermissionMode),
    yes: args.includes('--yes'),
    allowlist: (get('--web', '') || '').split(',').filter(Boolean),
  };
}

async function main() {
  const opts = parseArgs(process.argv);
  fs.mkdirSync(opts.workspace, { recursive: true });
  const sink = new CliSink();
  const control = new CliControl(opts.yes);

  process.on('SIGINT', () => {
    control.cancel();
    console.log('\n(收到中断信号，正在停止…)');
  });

  const res = await runTask(
    {
      prompt: opts.prompt,
      workspaceDir: opts.workspace,
      mode: opts.mode,
      modelConfig: modelConfigFromEnv(),
      skillRoots: [path.resolve(process.cwd(), 'skills'), path.resolve(process.cwd(), '../../skills')],
      webfetchAllowlist: opts.allowlist,
    },
    sink,
    control,
  );
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`状态：${res.status} · token：in ${res.usage.inTokens} / out ${res.usage.outTokens} · 模型：${res.usage.model}`);
  process.exit(res.status === 'completed' ? 0 : 1);
}

main().catch((e) => {
  console.error('运行失败：', e);
  process.exit(1);
});
