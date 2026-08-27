import readline from 'node:readline';
import type { ControlSource } from './emitter.js';

/**
 * CLI 控制源：审批/提问走终端交互；--yes 模式全部自动批准。
 * 用于 T-009 本地试跑器与评测。
 */
export class CliControl implements ControlSource {
  private cancelled = false;
  private inputs: string[] = [];
  constructor(private autoApprove: boolean) {}

  async waitApproval(_approvalId: string): Promise<boolean> {
    if (this.autoApprove) return true;
    return this.ask('批准该操作？(y/N) ').then((a) => /^y(es)?$/i.test(a.trim()));
  }

  async waitAnswer(_questionId: string): Promise<string> {
    return this.ask('你的回答：');
  }

  drainUserInputs(): string[] {
    const r = this.inputs;
    this.inputs = [];
    return r;
  }

  isCancelled(): boolean {
    return this.cancelled;
  }

  cancel() {
    this.cancelled = true;
  }

  private ask(q: string): Promise<string> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => rl.question(q, (a) => { rl.close(); resolve(a); }));
  }
}
