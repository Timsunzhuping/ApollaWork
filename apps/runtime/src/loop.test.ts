import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TaskEvent } from '@apolla/protocol';
import { runTask } from './runner.js';
import type { EventSink, ControlSource } from './emitter.js';

class CaptureSink implements EventSink {
  events: TaskEvent[] = [];
  emit(e: TaskEvent) {
    this.events.push(e);
  }
  types() {
    return this.events.map((e) => e.type);
  }
}

class AutoControl implements ControlSource {
  private inputs: string[] = [];
  private cancelled = false;
  constructor(private approve = true) {}
  async waitApproval() {
    return this.approve;
  }
  async waitAnswer() {
    return '选项A';
  }
  drainUserInputs() {
    const r = this.inputs;
    this.inputs = [];
    return r;
  }
  queueInput(s: string) {
    this.inputs.push(s);
  }
  cancel() {
    this.cancelled = true;
  }
  isCancelled() {
    return this.cancelled;
  }
}

function script(steps: unknown[]): string {
  return `任务。[[ACTIONS]]${JSON.stringify(steps)}[[/ACTIONS]]`;
}

let dir: string;
function ws() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apolla-loop-'));
  return dir;
}

describe('Agent Loop（mock 模型驱动真实工具）', () => {
  it('完整跑通：计划→写文件→执行→产物→完成', async () => {
    const w = ws();
    const sink = new CaptureSink();
    const res = await runTask(
      {
        prompt: script([
          { tool: 'Write', args: { path: 'hello.py', content: 'print("hi")' } },
          { tool: 'Bash', args: { command: 'python3 hello.py' } },
          { tool: 'Artifact', args: { path: 'hello.py', title: '脚本', kind: 'data' } },
          { say: '完成' },
        ]),
        workspaceDir: w,
        modelConfig: { model: 'mock' },
        skillRoots: [],
      },
      sink,
      new AutoControl(),
    );
    expect(res.status).toBe('completed');
    expect(fs.existsSync(path.join(w, 'hello.py'))).toBe(true);
    const types = sink.types();
    expect(types).toContain('task.created');
    expect(types).toContain('tool.call');
    expect(types).toContain('artifact.created');
    expect(types).toContain('task.completed');
    // 事件顺序：created 在 completed 之前
    expect(types.indexOf('task.created')).toBeLessThan(types.indexOf('task.completed'));
  });

  it('取消后返回 cancelled', async () => {
    const w = ws();
    const sink = new CaptureSink();
    const control = new AutoControl();
    control.cancel();
    const res = await runTask(
      { prompt: script([{ tool: 'Bash', args: { command: 'echo x' } }]), workspaceDir: w, modelConfig: { model: 'mock' }, skillRoots: [] },
      sink,
      control,
    );
    expect(res.status).toBe('cancelled');
  });

  it('工具参数非法时回错误给模型而非崩溃', async () => {
    const w = ws();
    const sink = new CaptureSink();
    const res = await runTask(
      {
        prompt: script([{ tool: 'Read', args: {} }, { say: '结束' }]),
        workspaceDir: w,
        modelConfig: { model: 'mock' },
        skillRoots: [],
      },
      sink,
      new AutoControl(),
    );
    expect(res.status).toBe('completed');
    const toolResult = sink.events.find((e) => e.type === 'tool.result');
    expect(toolResult && 'ok' in toolResult && toolResult.ok).toBe(false);
  });

  it('emit 的事件全部符合 protocol schema', async () => {
    const { TaskEvent } = await import('@apolla/protocol');
    const w = ws();
    const sink = new CaptureSink();
    await runTask(
      { prompt: script([{ tool: 'Write', args: { path: 'a.txt', content: 'x' } }, { say: 'ok' }]), workspaceDir: w, modelConfig: { model: 'mock' }, skillRoots: [] },
      sink,
      new AutoControl(),
    );
    for (const e of sink.events) {
      expect(TaskEvent.safeParse(e).success, `事件 ${e.type} 不合规`).toBe(true);
    }
  });
});
