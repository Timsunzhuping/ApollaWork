import type { TaskEvent } from '@apolla/protocol';
import type { EventSink } from './emitter.js';

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

/** 终端事件渲染（T-009）。同时可收集事件用于评测断言。 */
export class CliSink implements EventSink {
  events: TaskEvent[] = [];
  private inDelta = false;

  constructor(private quiet = false) {}

  emit(event: TaskEvent): void {
    this.events.push(event);
    if (this.quiet) return;
    if (event.type !== 'message.delta' && this.inDelta) {
      process.stdout.write('\n');
      this.inDelta = false;
    }
    switch (event.type) {
      case 'task.created':
        console.log(C.bold(`\n▶ 任务：${event.prompt}`), C.dim(`[${event.mode}/${event.modelRoute}]`));
        break;
      case 'plan.updated':
        console.log(C.cyan('\n📋 计划：'));
        for (const t of event.items) {
          const mark = t.state === 'done' ? '✓' : t.state === 'in_progress' ? '▸' : '○';
          console.log(`  ${mark} ${t.text}`);
        }
        break;
      case 'message.delta':
        process.stdout.write(event.delta);
        this.inDelta = true;
        break;
      case 'tool.call':
        console.log(C.yellow(`\n🔧 ${event.name}`), C.dim(event.argsPreview));
        break;
      case 'tool.result':
        console.log(event.ok ? C.green('  ✓ ') : C.red('  ✗ '), C.dim(event.resultPreview.slice(0, 160)));
        break;
      case 'bash.output':
        process.stdout.write(C.dim(event.chunk));
        break;
      case 'file.diff':
        console.log(C.dim(`  ± ${event.path}`));
        break;
      case 'approval.requested':
        console.log(C.red(`\n⚠ 需要审批：${event.title}`), C.dim(event.detail.slice(0, 120)));
        break;
      case 'artifact.created':
        console.log(C.green(`\n📎 产物：${event.title}`), C.dim(`(${event.path})`));
        break;
      case 'task.completed':
        console.log(C.bold(C.green('\n✅ 完成')));
        break;
      case 'task.failed':
        console.log(C.bold(C.red(`\n❌ 失败：${event.error.message}`)));
        break;
      case 'task.cancelled':
        console.log(C.bold(C.yellow('\n⏹ 已取消')));
        break;
      default:
        break;
    }
  }
}
