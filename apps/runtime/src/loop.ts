import { randomUUID } from 'node:crypto';
import type { ApprovalKind, PermissionMode, TaskEvent, TodoItem } from '@apolla/protocol';
import type { ToolContext } from '@apolla/agent-tools';
import type { ChatMessage, ChatModel } from './model.js';
import type { EventSink, ControlSource } from './emitter.js';
import { ToolRegistry } from './tool-registry.js';
import type { SkillManifest } from './skills.js';
import type { McpStdioClient, McpTool } from './mcp-client.js';
import { buildSystemPrompt } from './prompt.js';
import { BUILTIN_EXPERTS, type ExpertDef } from './experts.js';

export interface LoopOptions {
  workspaceDir: string;
  mode: PermissionMode;
  model: ChatModel;
  skills: SkillManifest[];
  prompt: string;
  attachments?: string[];
  webEnabled: boolean;
  webfetchAllowlist: string[];
  searxngUrl?: string;
  /** 工具层出网用的 fetch（沙箱内为 server 中继） */
  fetchImpl?: typeof fetch;
  now: string;
  maxSteps?: number;
  contextTokenBudget?: number; // 触发压缩的 token 阈值
  /** 任务总时长上限（毫秒，0=不限）。防止慢模型下单任务跑一小时占住容量 */
  maxDurationMs?: number;
  /** 任务 token 预算（0=不限）。防止失控循环在下次配额检查前烧掉整月预算 */
  maxTokens?: number;
  mcpTools?: McpTool[];
  mcpClients?: Map<string, McpStdioClient>;
  experts?: Record<string, ExpertDef>;
  depth?: number; // 子代理递归深度（防无限派生）
}

const MAX_AGENT_DEPTH = 2;

const MAX_STEPS_DEFAULT = 40;
const MAX_DURATION_DEFAULT = 30 * 60_000; // 30 分钟
const MAX_TOKENS_DEFAULT = 300_000;
const CTX_BUDGET_DEFAULT = 100_000;

/** 一次任务执行的 Agent 循环。 */
export class AgentLoop {
  private messages: ChatMessage[] = [];
  private registry: ToolRegistry;
  private todos: TodoItem[] = [];
  private approvedForTask = new Set<ApprovalKind>();
  private totalUsage = { inTokens: 0, outTokens: 0 };

  constructor(
    private opts: LoopOptions,
    private sink: EventSink,
    private control: ControlSource,
  ) {
    const depth = opts.depth ?? 0;
    // 子代理派生器：深度未超限时提供，超限则不注册 Agent 工具（防无限递归）
    const spawner =
      depth < MAX_AGENT_DEPTH
        ? (prompt: string, expertName?: string) => this.spawnSubAgent(prompt, expertName)
        : undefined;
    this.registry = new ToolRegistry(
      opts.skills,
      opts.mcpTools ?? [],
      opts.mcpClients ?? new Map(),
      spawner,
    );
  }

  /** 派生子代理执行一个子任务（PRD T-208），返回其总结文本回注给父代理。 */
  private async spawnSubAgent(prompt: string, expertName?: string): Promise<string> {
    const experts = { ...BUILTIN_EXPERTS, ...(this.opts.experts ?? {}) };
    const expert = expertName ? experts[expertName] : undefined;
    if (expertName && !expert) {
      return `未找到专家「${expertName}」。可用：${Object.keys(experts).join(', ')}`;
    }
    const childPrompt = expert ? `${expert.systemAddon}\n\n任务：${prompt}` : prompt;
    const child = new AgentLoop(
      {
        ...this.opts,
        prompt: childPrompt,
        attachments: [],
        depth: (this.opts.depth ?? 0) + 1,
        maxSteps: 20,
      },
      this.sink,
      this.control,
    );
    const result = await child.run();
    this.totalUsage.inTokens += child.usage.inTokens;
    this.totalUsage.outTokens += child.usage.outTokens;
    return `【子代理${expert ? `（${expert.displayName}）` : ''}完成】\n${result.summary}`;
  }

  private toolContext(): ToolContext {
    const self = this;
    return {
      workspaceDir: this.opts.workspaceDir,
      mode: this.opts.mode,
      todos: this.todos,
      config: {
        webfetchAllowlist: this.opts.webfetchAllowlist,
        searxngUrl: this.opts.searxngUrl,
        fetchImpl: this.opts.fetchImpl,
      },
      emit: (e) => self.sink.emit(e),
      isCancelled: () => self.control.isCancelled(),
      async requestApproval(req) {
        // auto 模式下的免批项由危险规则决定（工具层已判断需要审批才会调到这里）；
        // 若本任务内该类已「全部允许」，直接放行。
        if (self.approvedForTask.has(req.kind)) return true;
        const approvalId = randomUUID();
        self.sink.emit({
          v: 1,
          type: 'approval.requested',
          approvalId,
          kind: req.kind,
          title: req.title,
          detail: req.detail,
        });
        const approved = await self.control.waitApproval(approvalId);
        return approved;
      },
      async askUser(question, options) {
        const questionId = randomUUID();
        self.sink.emit({ v: 1, type: 'question.asked', questionId, question, options });
        return self.control.waitAnswer(questionId);
      },
    };
  }

  /** 允许 server 在审批解决时标记「本任务全部允许」 */
  markApprovedForTask(kind: ApprovalKind) {
    this.approvedForTask.add(kind);
  }

  async run(): Promise<{ status: 'completed' | 'failed' | 'cancelled'; summary: string }> {
    const system = buildSystemPrompt({
      workspaceDir: this.opts.workspaceDir,
      mode: this.opts.mode,
      skills: this.opts.skills,
      now: this.opts.now,
      webEnabled: this.opts.webEnabled,
    });
    this.messages.push({ role: 'system', content: system });

    let userMsg = this.opts.prompt;
    if (this.opts.attachments?.length) {
      userMsg += `\n\n[附件文件（工作区内）]\n${this.opts.attachments.map((a) => '- ' + a).join('\n')}`;
    }
    this.messages.push({ role: 'user', content: userMsg });

    const maxSteps = this.opts.maxSteps ?? MAX_STEPS_DEFAULT;
    const maxDurationMs = this.opts.maxDurationMs ?? MAX_DURATION_DEFAULT;
    const maxTokens = this.opts.maxTokens ?? MAX_TOKENS_DEFAULT;
    const startedAt = Date.now();
    const ctx = this.toolContext();

    try {
      for (let step = 0; step < maxSteps; step++) {
        // 总时长上限：慢模型下步数上限形同虚设（40 步 × 100 秒 = 一小时），
        // 必须有墙钟兜底，否则单任务会长期占住并发槽位
        if (maxDurationMs > 0 && Date.now() - startedAt > maxDurationMs) {
          const msg = `任务已运行 ${Math.round((Date.now() - startedAt) / 60000)} 分钟，达到时长上限而停止。已产出的内容仍可使用；如需继续请用更聚焦的指令重新发起。`;
          this.sink.emit({ v: 1, type: 'message.completed', messageId: randomUUID(), role: 'assistant', text: msg });
          return { status: 'completed', summary: msg };
        }
        // token 预算：配额只在建任务时检查，单个失控循环可能在下次检查前烧掉整月预算
        const used = this.totalUsage.inTokens + this.totalUsage.outTokens;
        if (maxTokens > 0 && used > maxTokens) {
          const msg = `任务已消耗 ${used} token，达到单任务预算上限而停止。已产出的内容仍可使用。`;
          this.sink.emit({ v: 1, type: 'message.completed', messageId: randomUUID(), role: 'assistant', text: msg });
          return { status: 'completed', summary: msg };
        }
        if (this.control.isCancelled()) {
          this.sink.emit({ v: 1, type: 'task.cancelled' });
          return { status: 'cancelled', summary: '任务已被用户取消。' };
        }

        // 注入用户追加输入（steering）
        for (const text of this.control.drainUserInputs()) {
          this.sink.emit({ v: 1, type: 'user.input', text });
          this.messages.push({ role: 'user', content: `【用户追加指令】${text}` });
        }

        await this.maybeCompact();

        const messageId = randomUUID();
        let emittedDelta = false;
        const result = await this.opts.model.chat(
          this.messages,
          this.registry.specs(),
          (d) => {
            if (d.textDelta) {
              emittedDelta = true;
              this.sink.emit({ v: 1, type: 'message.delta', messageId, delta: d.textDelta });
            }
          },
          this.abortSignal(),
        );

        this.totalUsage.inTokens += result.usage.inTokens;
        this.totalUsage.outTokens += result.usage.outTokens;
        this.sink.emit({
          v: 1,
          type: 'usage.updated',
          usage: { ...this.totalUsage, model: this.opts.model.name },
        });

        if (result.text || emittedDelta) {
          this.sink.emit({
            v: 1,
            type: 'message.completed',
            messageId,
            role: 'assistant',
            text: result.text,
          });
        }

        // 记录 assistant 轮（含工具调用）
        this.messages.push({
          role: 'assistant',
          content: result.text,
          tool_calls: result.toolCalls.length ? result.toolCalls : undefined,
        });

        if (result.toolCalls.length === 0) {
          // 无工具调用 = 收尾
          return { status: 'completed', summary: result.text || '任务完成。' };
        }

        // 顺序执行工具调用
        for (const call of result.toolCalls) {
          if (this.control.isCancelled()) {
            this.sink.emit({ v: 1, type: 'task.cancelled' });
            return { status: 'cancelled', summary: '任务已被用户取消。' };
          }
          const toolResult = await this.execTool(call.id, call.name, call.arguments, ctx);
          this.messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: toolResult,
          });
        }

        // 注入 Skill 加载产生的系统提醒
        for (const reminder of this.registry.drainSkillReminders()) {
          this.messages.push({ role: 'system', content: reminder });
        }
      }
      const msg = `已达到最大步数（${maxSteps}）。请查看已产出的内容，或用更聚焦的指令继续。`;
      this.sink.emit({ v: 1, type: 'message.completed', messageId: randomUUID(), role: 'assistant', text: msg });
      return { status: 'completed', summary: msg };
    } catch (e) {
      if (this.control.isCancelled()) {
        this.sink.emit({ v: 1, type: 'task.cancelled' });
        return { status: 'cancelled', summary: '任务已被用户取消。' };
      }
      const message = (e as Error).message;
      this.sink.emit({ v: 1, type: 'task.failed', error: { code: 'loop_error', message } });
      return { status: 'failed', summary: message };
    }
  }

  private async execTool(
    callId: string,
    name: string,
    argsJson: string,
    ctx: ToolContext,
  ): Promise<string> {
    const tool = this.registry.get(name);
    const t0 = Date.now();
    if (!tool) {
      this.emitCallPair(callId, name, argsJson, false, `未知工具：${name}`);
      return `错误：未知工具 ${name}`;
    }
    let args: unknown;
    try {
      args = argsJson.trim() ? JSON.parse(argsJson) : {};
    } catch {
      const msg = `参数不是合法 JSON：${argsJson.slice(0, 200)}`;
      this.emitCallPair(callId, name, argsJson, false, msg);
      return `错误：${msg}`;
    }
    // schema 校验（Skill 工具用宽松 schema）
    if (name !== 'Skill') {
      const parsed = tool.schema.safeParse(args);
      if (!parsed.success) {
        const msg = `参数校验失败：${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`;
        this.emitCallPair(callId, name, JSON.stringify(args), false, msg);
        return `错误：${msg}`;
      }
      args = parsed.data;
    }

    this.sink.emit({
      v: 1,
      type: 'tool.call',
      callId,
      name,
      argsPreview: this.argsPreview(name, args),
    });
    try {
      const outcome = await tool.execute(args, ctx, callId);
      this.sink.emit({
        v: 1,
        type: 'tool.result',
        callId,
        name,
        ok: outcome.ok,
        resultPreview: outcome.output.slice(0, 400),
        truncatedRef: outcome.truncatedRef,
        durationMs: Date.now() - t0,
      });
      return outcome.output;
    } catch (e) {
      const msg = (e as Error).message;
      this.sink.emit({
        v: 1,
        type: 'tool.result',
        callId,
        name,
        ok: false,
        resultPreview: msg.slice(0, 400),
        durationMs: Date.now() - t0,
      });
      return `工具执行异常：${msg}`;
    }
  }

  private emitCallPair(callId: string, name: string, args: string, ok: boolean, msg: string) {
    this.sink.emit({ v: 1, type: 'tool.call', callId, name, argsPreview: args.slice(0, 200) });
    this.sink.emit({ v: 1, type: 'tool.result', callId, name, ok, resultPreview: msg.slice(0, 400) });
  }

  private argsPreview(name: string, args: unknown): string {
    const a = args as Record<string, unknown>;
    if (name === 'Bash') return String(a.command ?? '').slice(0, 300);
    if (name === 'Write' || name === 'Edit' || name === 'Read') return String(a.path ?? '');
    if (name === 'Skill') return String(a.name ?? '');
    return JSON.stringify(args).slice(0, 200);
  }

  /** 上下文压缩（T-107）：超阈值时摘要化中段，保留系统/计划/最近若干轮。 */
  private async maybeCompact() {
    const approxTokens = this.messages.reduce((n, m) => n + Math.ceil((m.content?.length ?? 0) / 3), 0);
    const budget = this.opts.contextTokenBudget ?? CTX_BUDGET_DEFAULT;
    if (approxTokens < budget) return;

    const system = this.messages[0];
    const firstUser = this.messages[1];
    const tail = this.messages.slice(-8);
    const middle = this.messages.slice(2, -8);
    if (middle.length === 0) return;

    const summaryText = middle
      .map((m) => {
        if (m.role === 'assistant' && m.tool_calls?.length) {
          return `助手调用了：${m.tool_calls.map((t) => t.name).join(', ')}`;
        }
        if (m.role === 'tool') return `工具结果：${(m.content ?? '').slice(0, 200)}`;
        return `${m.role}：${(m.content ?? '').slice(0, 200)}`;
      })
      .join('\n');

    const compacted: ChatMessage = {
      role: 'system',
      content: `【上文已压缩】较早的执行过程摘要（保留关键事实与产出，细节从略）：\n${summaryText.slice(0, 6000)}\n当前计划：\n${this.todos.map((t) => `- [${t.state}] ${t.text}`).join('\n')}`,
    };
    // tool 消息必须紧跟其 assistant 调用；tail 从 assistant 边界起切，避免孤立 tool 消息
    let cut = tail;
    if (cut[0]?.role === 'tool') cut = this.messages.slice(-7);
    this.messages = [system, firstUser, compacted, ...cut].filter(Boolean) as ChatMessage[];
  }

  private abortSignal(): AbortSignal {
    const ac = new AbortController();
    if (this.control.isCancelled()) ac.abort();
    const timer = setInterval(() => {
      if (this.control.isCancelled()) {
        ac.abort();
        clearInterval(timer);
      }
    }, 300);
    timer.unref?.();
    return ac.signal;
  }

  get usage() {
    return { ...this.totalUsage, model: this.opts.model.name };
  }
}
