import { spawn } from 'node:child_process';
import { BashInput } from '@apolla/protocol';
import type { z } from 'zod';
import { fail, ok, type ToolDef } from '../context.js';
import { checkDanger, isNetworkCommand } from '../dangerous.js';
import { middleTruncate, preview, saveOverflow, MODEL_OUTPUT_CAP } from '../truncate.js';

const DEFAULT_TIMEOUT = 120_000;
const EMIT_CAP = 200_000; // 事件流转发的输出上限（字符）

export const bashTool: ToolDef<z.infer<typeof BashInput>> = {
  name: 'Bash',
  description:
    '在工作区目录内执行 shell 命令（沙箱内）。适合运行数据处理脚本、python、格式转换等。输出会实时回传。',
  schema: BashInput,
  async execute(input, ctx, callId) {
    // 1) 危险命令强制审批（与模式无关）
    const danger = checkDanger(input.command);
    if (danger) {
      const approved = await ctx.requestApproval({
        kind: danger.kind,
        title: `危险命令：${danger.reason}`,
        detail: input.command,
      });
      if (!approved) return fail(`用户拒绝执行该命令（${danger.reason}）。请改用更安全的方式。`);
    } else if (ctx.mode === 'ask') {
      // 2) ask 模式：所有命令审批
      const approved = await ctx.requestApproval({
        kind: 'bash_command',
        title: input.description || '执行命令',
        detail: input.command,
      });
      if (!approved) return fail('用户拒绝执行该命令。');
    } else if (isNetworkCommand(input.command) && ctx.config.webfetchAllowlist.length === 0) {
      // 3) 出网命令且未配置白名单：审批
      const approved = await ctx.requestApproval({
        kind: 'network_egress',
        title: '命令包含网络访问',
        detail: input.command,
      });
      if (!approved) return fail('用户拒绝了网络访问。');
    }

    const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT;
    return new Promise((resolve) => {
      const child = spawn('/bin/bash', ['-lc', input.command], {
        cwd: ctx.workspaceDir,
        detached: true,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          // 用 C.UTF-8：沙箱镜像未生成 en_US.UTF-8，否则每条命令都会刷 locale 警告
          LANG: process.env.LANG ?? 'C.UTF-8',
          LC_ALL: process.env.LC_ALL ?? 'C.UTF-8',
          WORKSPACE: ctx.workspaceDir,
          PYTHONIOENCODING: 'utf-8',
          NO_COLOR: '1',
          // 沙箱内的回环代理：curl / python-requests 的白名单出网经它上送 server 判定
          ...Object.fromEntries(
            ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy']
              .filter((k) => process.env[k])
              .map((k) => [k, process.env[k]!]),
          ),
        },
      });
      let out = '';
      let emitted = 0;
      let settled = false;

      const onChunk = (stream: 'stdout' | 'stderr') => (buf: Buffer) => {
        const s = buf.toString('utf8');
        out += s;
        if (emitted < EMIT_CAP) {
          ctx.emit({ v: 1, type: 'bash.output', callId, chunk: s.slice(0, EMIT_CAP - emitted), stream });
          emitted += s.length;
        }
        if (out.length > 5_000_000) child.kill('SIGKILL'); // 输出爆炸保护
      };
      child.stdout.on('data', onChunk('stdout'));
      child.stderr.on('data', onChunk('stderr'));

      const timer = setTimeout(() => {
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
        finish(null, true);
      }, timeout);

      const cancelPoll = setInterval(() => {
        if (ctx.isCancelled()) {
          try {
            process.kill(-child.pid!, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        }
      }, 500);

      const finish = (code: number | null, timedOut = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(cancelPoll);
        let ref: string | undefined;
        let body = out;
        if (out.length > MODEL_OUTPUT_CAP) {
          ref = saveOverflow(ctx, callId, out);
          body = middleTruncate(out);
        }
        if (timedOut) {
          resolve(fail(`命令超时（${timeout}ms）被终止。已输出：\n${body}`));
        } else if (code === 0) {
          resolve(ok(body || '（无输出，退出码 0）', ref));
        } else {
          resolve(fail(`退出码 ${code}。输出：\n${body || '（无输出）'}`));
        }
      };

      child.on('error', (e) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          clearInterval(cancelPoll);
          resolve(fail(`启动失败：${e.message}`));
        }
      });
      child.on('close', (code) => finish(code));
    });
  },
};

export function bashPreview(command: string): string {
  return preview(command, 200);
}
