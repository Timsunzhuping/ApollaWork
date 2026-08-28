import { LoggerService, LogLevel } from '@nestjs/common';
import { currentContext } from './request-context.js';

/**
 * 结构化日志（生产 P2）。
 * 之前用 Nest 默认 Logger：纯文本、无 requestId，线上排查要靠肉眼对时间戳。
 * 现在输出 JSON 行（便于 Loki/ELK 采集），自动带 requestId / userId / taskId 串联一次请求的全部日志。
 * LOG_FORMAT=text 可切回人类可读（本地开发默认）。
 */
export class StructuredLogger implements LoggerService {
  private json = (process.env.LOG_FORMAT ?? (process.env.NODE_ENV === 'production' ? 'json' : 'text')) === 'json';
  private levels: LogLevel[] = (process.env.LOG_LEVEL?.split(',') as LogLevel[]) ?? [
    'log',
    'warn',
    'error',
  ];

  private emit(level: LogLevel, message: unknown, context?: string, extra?: unknown) {
    if (!this.levels.includes(level)) return;
    const ctx = currentContext();
    if (this.json) {
      process.stdout.write(
        JSON.stringify({
          ts: new Date().toISOString(),
          level,
          ctx: context,
          msg: typeof message === 'string' ? message : JSON.stringify(message),
          requestId: ctx?.requestId,
          userId: ctx?.userId,
          taskId: ctx?.taskId,
          ...(extra ? { detail: String(extra).slice(0, 2000) } : {}),
        }) + '\n',
      );
    } else {
      const tag = ctx?.requestId ? ` [${ctx.requestId}]` : '';
      const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)}${tag} [${context ?? '-'}] ${message}`;
      (level === 'error' ? process.stderr : process.stdout).write(line + '\n');
      if (extra) (level === 'error' ? process.stderr : process.stdout).write(String(extra) + '\n');
    }
  }

  log(message: unknown, context?: string) {
    this.emit('log', message, context);
  }
  error(message: unknown, stack?: unknown, context?: string) {
    this.emit('error', message, context, stack);
  }
  warn(message: unknown, context?: string) {
    this.emit('warn', message, context);
  }
  debug(message: unknown, context?: string) {
    this.emit('debug', message, context);
  }
  verbose(message: unknown, context?: string) {
    this.emit('verbose', message, context);
  }
}
