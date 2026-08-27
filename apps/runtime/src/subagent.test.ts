import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TaskEvent } from '@apolla/protocol';
import { runTask } from './runner.js';
import type { EventSink, ControlSource } from './emitter.js';

class Sink implements EventSink {
  events: TaskEvent[] = [];
  emit(e: TaskEvent) {
    this.events.push(e);
  }
}
class Ctl implements ControlSource {
  async waitApproval() {
    return true;
  }
  async waitAnswer() {
    return 'x';
  }
  drainUserInputs() {
    return [];
  }
  isCancelled() {
    return false;
  }
}

/**
 * 父代理调用 Agent 工具派生子代理；子代理的 prompt 自带 mock 脚本写文件。
 * 验证：子代理真实执行、产物落地、结论回注父代理。
 */
describe('子代理 / 专家（T-208）', () => {
  it('父代理派生子代理完成子任务', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'apolla-sub-'));
    const childScript =
      '[[ACTIONS]]' +
      JSON.stringify([
        { tool: 'Write', args: { path: 'child-output.txt', content: 'done by sub-agent' } },
        { say: '子任务完成：已写入 child-output.txt' },
      ]) +
      '[[/ACTIONS]]';
    const parentScript =
      '委托子代理。[[ACTIONS]]' +
      JSON.stringify([
        { tool: 'Agent', args: { prompt: `写一个文件 ${childScript}`, expert: 'doc-writer' } },
        { say: '子代理已完成，父代理收尾。' },
      ]) +
      '[[/ACTIONS]]';

    const sink = new Sink();
    const res = await runTask(
      { prompt: parentScript, workspaceDir: ws, modelConfig: { model: 'mock' }, skillRoots: [] },
      sink,
      new Ctl(),
    );
    expect(res.status).toBe('completed');
    // 子代理真实写了文件
    expect(fs.existsSync(path.join(ws, 'child-output.txt'))).toBe(true);
    // Agent 工具结果回注，且带专家标记
    const agentResult = sink.events.find((e) => e.type === 'tool.result' && e.name === 'Agent');
    expect(agentResult && 'ok' in agentResult && agentResult.ok).toBe(true);
    expect(agentResult && 'resultPreview' in agentResult && agentResult.resultPreview).toContain('公文写手');
  });

  it('未知专家名返回可用列表', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'apolla-sub2-'));
    const sink = new Sink();
    await runTask(
      {
        prompt:
          '委托。[[ACTIONS]]' +
          JSON.stringify([{ tool: 'Agent', args: { prompt: '做事', expert: '不存在' } }, { say: '完成' }]) +
          '[[/ACTIONS]]',
        workspaceDir: ws,
        modelConfig: { model: 'mock' },
        skillRoots: [],
      },
      sink,
      new Ctl(),
    );
    const agentResult = sink.events.find((e) => e.type === 'tool.result' && e.name === 'Agent');
    expect(agentResult && 'resultPreview' in agentResult && agentResult.resultPreview).toContain('finance-analyst');
  });
});
