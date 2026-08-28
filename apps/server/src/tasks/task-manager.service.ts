import { BadRequestException, Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { TaskEvent, PermissionMode, ModelTier, ApprovalDecision, ApprovalScope } from '@apolla/protocol';
import { PrismaService } from '../prisma.service.js';
import { EventBus } from '../events/event-bus.service.js';
import { StorageService } from '../storage/storage.service.js';
import { AuditService } from '../audit/audit.service.js';
import { ConnectorService } from '../connectors/connector.service.js';
import { ModelService } from '../models/model.service.js';
import { QuotaService } from '../quota/quota.service.js';
import { Span, newTraceId } from '../observability/tracing.js';
import { CONFIG, type AppConfig } from '../config.js';
import { TaskControl } from './task-control.js';
import { LocalExecutor } from '../executor/local-executor.js';
import { DockerExecutor } from '../executor/docker-executor.js';
import type { Executor } from '../executor/executor.js';
import type { TaskQueue } from '../queue/queue.port.js';
import { InprocQueue } from '../queue/inproc-queue.js';
import { BullQueue } from '../queue/bull-queue.js';

interface RunningTask {
  control: TaskControl;
  workspaceId: string;
}

/**
 * 任务管理器（PRD T-102）：创建、编排执行、状态机推进、控制信号路由。
 * inproc 队列 + 并发上限；生产可切 BullMQ（保持同一 create/enqueue 语义）。
 */
@Injectable()
export class TaskManager implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('TaskManager');
  private running = new Map<string, RunningTask>();
  private queue: TaskQueue;
  private executor: Executor;

  constructor(
    private prisma: PrismaService,
    private bus: EventBus,
    private storage: StorageService,
    private audit: AuditService,
    private connectors: ConnectorService,
    private models: ModelService,
    private quota: QuotaService,
    @Inject(CONFIG) private config: AppConfig,
  ) {
    this.executor =
      config.executor === 'docker' ? new DockerExecutor(config) : new LocalExecutor();
    this.queue =
      config.queueDriver === 'bullmq'
        ? new BullQueue(config.redisUrl, config.maxConcurrent)
        : new InprocQueue(config.maxConcurrent);
    this.queue.consume((taskId) => this.execute(taskId));
    this.log.log(
      `执行器：${config.executor} · 队列：${this.queue.kind} · 并发上限：${config.maxConcurrent} · 模型：${config.model.name}`,
    );
  }

  /**
   * 启动恢复（生产 P1）：上一个进程若崩溃/重启，DB 里会留下永远不会推进的
   * running / waiting_* / queued 任务。这里统一收尾为 failed 并补一条事件，
   * 让前端能看到明确结局，而不是永远转圈。
   */
  async onModuleInit() {
    const stale = await this.prisma.task.findMany({
      where: { status: { in: ['running', 'queued', 'waiting_approval', 'waiting_input'] } },
      select: { id: true, status: true },
    });
    for (const t of stale) {
      await this.bus.primeSeq(t.id);
      await this.bus.publish(t.id, {
        v: 1,
        type: 'task.failed',
        error: { code: 'server_restart', message: '服务重启，任务已中断。请重新发起。' },
      });
      await this.prisma.task.update({ where: { id: t.id }, data: { status: 'failed' } });
    }
    if (stale.length) this.log.warn(`启动恢复：${stale.length} 个中断任务已标记为失败`);
  }

  async createTask(input: {
    sessionId: string;
    workspaceId: string;
    prompt: string;
    mode: PermissionMode;
    modelTier: ModelTier;
    attachments: string[];
    actor: string;
    orgId?: string;
  }) {
    if (input.orgId) {
      const q = await this.quota.check(input.orgId, input.actor);
      if (!q.allowed) {
        await this.audit.record(input.actor, 'quota.blocked', input.workspaceId, q.reason);
        throw new BadRequestException(q.reason);
      }
    }
    const task = await this.prisma.task.create({
      data: {
        sessionId: input.sessionId,
        prompt: input.prompt,
        mode: input.mode,
        modelTier: input.modelTier,
        attachments: JSON.stringify(input.attachments),
        creatorId: input.actor,
        status: 'queued',
        modelRoute: this.config.model.name,
      },
    });
    await this.audit.record(input.actor, 'task.create', task.id, input.prompt.slice(0, 120));
    await this.queue.enqueue(task.id);
    return task;
  }

  private async execute(taskId: string) {
    const task = await this.prisma.task.findUnique({ where: { id: taskId }, include: { session: true } });
    if (!task) return;
    // 幂等保护：BullMQ 重投递或重复入队时，同一任务不并发跑两次
    if (this.running.has(taskId)) {
      this.log.warn(`任务 ${taskId} 已在执行，跳过重复投递`);
      return;
    }
    if (['cancelled', 'completed', 'failed'].includes(task.status)) {
      this.log.log(`任务 ${taskId} 已是终态（${task.status}），跳过执行`);
      return;
    }
    const workspaceId = task.session.workspaceId;
    const creatorId = task.creatorId ?? undefined;
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
    // 取得可供 Agent 直接读写的本地工作目录（S3 驱动下会先把工作区下载到临时目录）
    const workDir = await this.storage.materialize(workspaceId);
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
          workspaceDir: workDir,
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
          userId: creatorId,
          model: result.usage.model,
          inTokens: result.usage.inTokens,
          outTokens: result.usage.outTokens,
        },
      });
      span.setAttr('task.status', result.status).setAttr('usage.total', result.usage.inTokens + result.usage.outTokens);
      span.end(result.status === 'failed' ? 'error' : 'ok');
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
      // 无论成功失败都把本地变更写回持久层，并刷新文件索引（否则 S3 部署下产物会丢）
      try {
        await this.storage.persist(workspaceId, workDir);
        await this.syncFiles(workspaceId);
      } catch (e) {
        this.log.error(`工作区回写失败 ${workspaceId}：${(e as Error).message}`);
      }
      this.running.delete(taskId);
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
    const files = await this.storage.list(workspaceId);
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
    if (run) {
      run.control.cancel();
    } else {
      // 尚未开始执行（排队中）：直接落终态，消费时会因状态不符跳过
      const t = await this.prisma.task.findUnique({ where: { id: taskId } });
      if (t && ['queued'].includes(t.status)) {
        await this.prisma.task.update({ where: { id: taskId }, data: { status: 'cancelled' } });
        await this.bus.primeSeq(taskId);
        await this.bus.publish(taskId, { v: 1, type: 'task.cancelled' });
      }
    }
    await this.audit.record(actor, 'task.cancel', taskId);
    return true;
  }

  isRunning(taskId: string) {
    return this.running.has(taskId);
  }

  /** 队列深度（可观测指标）。 */
  queueDepth() {
    return this.queue.size();
  }

  async onModuleDestroy() {
    await this.queue.close().catch(() => undefined);
  }
}
