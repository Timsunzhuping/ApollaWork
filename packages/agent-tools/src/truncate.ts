import fs from 'node:fs';
import path from 'node:path';
import type { ToolContext } from './context.js';

export const MODEL_OUTPUT_CAP = 30_000; // 返回给模型的最大字符数

export function middleTruncate(s: string, max = MODEL_OUTPUT_CAP): string {
  if (s.length <= max) return s;
  const half = Math.floor(max / 2) - 40;
  return `${s.slice(0, half)}\n…（中间省略 ${s.length - 2 * half} 字符）…\n${s.slice(-half)}`;
}

/** 超长输出完整落盘到工作区 .apolla/outputs，返回相对引用路径 */
export function saveOverflow(ctx: ToolContext, callId: string, content: string): string {
  const dir = path.join(ctx.workspaceDir, '.apolla', 'outputs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${callId}.log`), content, 'utf8');
  return path.posix.join('.apolla', 'outputs', `${callId}.log`);
}

export function preview(s: string, max = 400): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max) + '…' : one;
}
