import { Inject, Injectable, Logger } from '@nestjs/common';
import type { TaskEvent, PermissionMode, ModelTier, ApprovalDecision, ApprovalScope } from '@apolla/protocol';
import { PrismaService } from '../prisma.service.js';
import { EventBus } from '../events/event-bus.service.js';
import { StorageService } from '../storage/storage.service.js';
import { AuditService } from '../audit/audit.service.js';
import { ConnectorService } from '../connectors/connector.service.js';
import { ModelService } from '../models/model.service.js';
import { Span, newTraceId } from '../observability/tracing.js';
import { CONFIG, type AppConfig } from '../config.js';
import { TaskControl } from './task-control.js';
import { LocalExecutor } from '../executor/local-executor.js';
import { DockerExecutor } from '../executor/docker-executor.js';
import type { Executor } from '../executor/executor.js';

interface RunningTask {
  control: TaskControl;
  workspaceId: string;
}

/**
 * 任务管理器（PRD T-102）：创建、编排执行、状态机推进、控制信号路由。
 * inproc 队列 + 并发上限；生产可切 BullMQ（保持同一 create/enqueue 语义）。
 */
@Injectable()
export class TaskManager {
  private readonly log = new Logger('TaskManager');
  private running = new Map<string, RunningTask>();
  private queue: string[] = [];
  private active = 0;
  private executor: Executor;
  private readonly maxConcurrent = 20;

  constructor(
    private prisma: PrismaService,
    private bus: EventBus,
    private storage: StorageService,
    private audit: AuditService,
    private connectors: ConnectorService,
    private models: ModelService,
    @Inject(CONFIG) private config: AppConfig,
  ) {
    this.executor =
      config.executor === 'docker' ? new DockerExecutor(config) : new LocalExecutor();
    this.log.log(`执行器：${config.executor} · 模型：${config.model.name}`);
  }

  async createTask(input: {
    sessionId: string;
    workspaceId: string;
    prompt: string;
    mode: PermissionMode;
    modelTier: ModelTier;
    attachments: string[];
    actor: string;
  }) {
    const task = await this.prisma.task.create({
      data: {
        sessionId: input.sessionId,
        prompt: input.prompt,
        mode: input.mode,
        modelTier: input.modelTier,
        attachments: JSON.stringify(input.attachments),
        status: 'queued',
        modelRoute: this.config.model.name,
      },
    });
    await this.audit.record(input.actor, 'task.create', task.id, input.prompt.slice(0, 120));
    this.queue.push(task.id);
    this.pump();
    return task;
  }

  private pump() {
    while (this.active < this.maxConcurrent && this.queue.length) {
      const taskId = this.queue.shift()!;
      void this.execute(taskId);
    }
  }

  private async execute(taskId: string) {
    this.active++;
    const task = await this.prisma.task.findUnique({ where: { id: taskId }, include: { session: true } });
    if (!task) {
      this.active--;
      return;
    }
    const workspaceId = task.session.workspaceId;
    const workspace = await this.prisma.workspace.findUnique({ where: { id: workspaceId } });
    const mcpServers = workspace
      ? await this.connectors.mcpServersFor(workspace.orgId, workspaceId)
      : [];
    const model = workspace
      ? await this.models.resolve(workspace.orgId, task.modelTier)
      : { name: this.config.model.name, baseUrl: this.config.model.baseUrl, apiKey: this.config.model.apiKey };
    await this.prisma.task.update({ where: { id: taskId }, data: { modelRoute: model.name } });
    const control = new TaskControl();
    this.running.set(taskId, { control, workspaceId });
    await this.bus.primeSeq(taskId);

    const onEvent = (event: TaskEvent) => {
      void this.persistSideEffects(taskId, workspaceId, event);
      void this.bus.publish(taskId, event);
    };

    await this.prisma.task.update({ where: { id: taskId }, data: { status: 'running' } });
    const span = new Span('task.execute', newTraceId(), undefined, {
      'task.id': taskId,
      'task.mode': task.mode,
      'model.name': model.name,
    });

    try {
      const result = await this.executor.run(
        {
          taskId,
          sessionId: task.sessionId,
          prompt: task.prompt,
          workspaceDir: this.storage.workspaceDir(workspaceId),
          mode: task.mode as PermissionMode,
          modelTier: task.modelTier as ModelTier,
          attachments: JSON.parse(task.attachments) as string[],
          model,
          skillRoots: this.config.skillRoots,
          webfetchAllowlist: this.config.webfetchAllowlist,
          searxngUrl: this.config.searxngUrl,
          mcpServers,
        },
        onEvent,
        control,
      );
      await this.prisma.task.update({
        where: { id: taskId },
        data: {
          status: result.status,
          summary: result.summary,
          usageJson: JSON.stringify(result.usage),
        },
      });
      await this.prisma.usageRecord.create({
        data: {
          taskId,
          workspaceId,
          model: result.usage.model,
          inTokens: result.usage.inTokens,
          outTokens: result.usage.outTokens,
        },
      });
      span.setAttr('task.status', result.status).setAttr('usage.total', result.usage.inTokens + result.usage.outTokens);
      span.end(result.status === 'failed' ? 'error' : 'ok');
      // 同步工作区新文件到 FileEntry 索引
      await this.syncFiles(workspaceId);
    } catch (e) {
      span.setAttr('error', (e as Error).message).end('error');
      this.log.error(`任务 ${taskId} 异常：${(e as Error).message}`);
      await this.bus.publish(taskId, {
        v: 1,
        type: 'task.failed',
        error: { code: 'executor_error', message: (e as Error).message },
      });
      await this.prisma.task.update({ where: { id: taskId }, data: { status: 'failed' } });
    } finally {
      this.running.delete(taskId);
      this.active--;
      this.pump();
    }
  }

  /** 事件的 DB 副作用：审批入库、产物入库 */
  private async persistSideEffects(taskId: string, workspaceId: string, event: TaskEvent) {
    if (event.type === 'approval.requested') {
      await this.prisma.approval.create({
        data: {
          id: event.approvalId,
          taskId,
          kind: event.kind,
          title: event.title,
          detail: event.detail,
          status: 'pending',
        },
      });
      await this.prisma.task.update({ where: { id: taskId }, data: { status: 'waiting_approval' } });
    } else if (event.type === 'approval.resolved') {
      await this.prisma.task.update({ where: { id: taskId }, data: { status: 'running' } });
    } else if (event.type === 'artifact.created') {
      await this.prisma.artifact.create({
        data: {
          taskId,
          path: event.path,
          title: event.title,
          mime: event.mime,
          kind: event.kind,
          previewStatus: 'none',
        },
      });
    }
  }

  private async syncFiles(workspaceId: string) {
    const files = this.storage.list(workspaceId);
    for (const f of files) {
      await this.prisma.fileEntry.upsert({
        where: { workspaceId_path: { workspaceId, path: f.path } },
        create: { workspaceId, path: f.path, size: f.size },
        update: { size: f.size, version: { increment: 1 } },
      });
    }
  }

  // ---- 控制信号路由 ----
  async resolveApproval(approvalId: string, decision: ApprovalDecision, scope: ApprovalScope, actor: string) {
    const approval = await this.prisma.approval.findUnique({ where: { id: approvalId } });
    if (!approval) return false;
    const run = this.running.get(approval.taskId);
    await this.prisma.approval.update({
      where: { id: approvalId },
      data: { status: decision, scope, resolverId: actor },
    });
    await this.bus.publish(approval.taskId, {
      v: 1,
      type: 'approval.resolved',
      approvalId,
      decision,
      scope,
      resolvedBy: actor,
    });
    await this.audit.record(actor, 'approval.resolve', approvalId, `${decision}/${scope}`);
    return run ? run.control.resolveApproval(approvalId, decision, scope) : false;
  }

  answerQuestion(taskId: string, questionId: string, answer: string) {
    const run = this.running.get(taskId);
    if (!run) return false;
    void this.bus.publish(taskId, { v: 1, type: 'question.answered', questionId, answer });
    return run.control.resolveAnswer(questionId, answer);
  }

  addInput(taskId: string, text: string) {
    const run = this.running.get(taskId);
    if (!run) return false;
    run.control.addInput(text);
    return true;
  }

  async cancel(taskId: string, actor: string) {
    const run = this.running.get(taskId);
    if (run) run.control.cancel();
    const inQueue = this.queue.indexOf(taskId);
    if (inQueue >= 0) {
      this.queue.splice(inQueue, 1);
      await this.prisma.task.update({ where: { id: taskId }, data: { status: 'cancelled' } });
      await this.bus.publish(taskId, { v: 1, type: 'task.cancelled' });
    }
    await this.audit.record(actor, 'task.cancel', taskId);
    return !!run || inQueue >= 0;
  }

  isRunning(taskId: string) {
    return this.running.has(taskId);
  }
}
