import { Body, Controller, Get, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { TaskEventRecord } from '@apolla/protocol';
import { SseGate } from '../events/sse-gate.js';
import {
  AnswerQuestionDto,
  CreateTaskDto,
  ResolveApprovalDto,
  TaskInputDto,
} from '@apolla/protocol';
import { PrismaService } from '../prisma.service.js';
import { EventBus } from '../events/event-bus.service.js';
import { TaskManager } from '../tasks/task-manager.service.js';
import { AuthGuard, currentUser } from '../auth/auth.js';
import { AccessService } from '../access/access.service.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { ZodBody } from '../common/zod-pipe.js';

@UseGuards(AuthGuard)
@Controller('api/v1')
export class TasksController {
  constructor(
    private prisma: PrismaService,
    private bus: EventBus,
    private tasks: TaskManager,
    private access: AccessService,
    private metrics: MetricsService,
  ) {}

  @Post('sessions/:id/tasks')
  async create(
    @Req() req: FastifyRequest,
    @Param('id') sessionId: string,
    @Body(new ZodBody(CreateTaskDto)) dto: CreateTaskDto,
  ) {
    const u = currentUser(req);
    const session = await this.access.session(u, sessionId, 'edit');
    const task = await this.tasks.createTask({
      sessionId,
      workspaceId: session.workspaceId,
      prompt: dto.prompt,
      mode: dto.mode,
      modelTier: dto.modelTier,
      attachments: dto.attachments,
      actor: u.id,
      orgId: u.orgId,
    });
    return { id: task.id, status: task.status };
  }

  @Get('tasks/:id')
  async get(@Req() req: FastifyRequest, @Param('id') id: string) {
    await this.access.task(currentUser(req), id, 'view');
    const task = await this.prisma.task.findUnique({
      where: { id },
      include: { artifacts: true, approvals: { orderBy: { createdAt: 'desc' } } },
    });
    if (!task) return { error: 'not found' };
    return {
      ...task,
      attachments: JSON.parse(task.attachments),
      usage: task.usageJson ? JSON.parse(task.usageJson) : null,
      running: this.tasks.isRunning(id),
    };
  }

  @Post('tasks/:id/cancel')
  async cancel(@Req() req: FastifyRequest, @Param('id') id: string) {
    const u = currentUser(req);
    await this.access.task(u, id, 'edit');
    return { ok: await this.tasks.cancel(id, u.id) };
  }

  @Post('tasks/:id/input')
  async input(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Body(new ZodBody(TaskInputDto)) dto: TaskInputDto,
  ) {
    await this.access.task(currentUser(req), id, 'edit');
    return { ok: this.tasks.addInput(id, dto.text) };
  }

  @Post('approvals/:id')
  async resolveApproval(
    @Req() req: FastifyRequest,
    @Param('id') approvalId: string,
    @Body(new ZodBody(ResolveApprovalDto)) dto: ResolveApprovalDto,
  ) {
    const u = currentUser(req);
    await this.access.approval(u, approvalId, 'edit');
    return { ok: await this.tasks.resolveApproval(approvalId, dto.decision, dto.scope, u.id) };
  }

  @Post('tasks/:id/questions/:qid')
  async answer(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Param('qid') qid: string,
    @Body(new ZodBody(AnswerQuestionDto)) dto: AnswerQuestionDto,
  ) {
    await this.access.task(currentUser(req), id, 'edit');
    return { ok: this.tasks.answerQuestion(id, qid, dto.answer) };
  }

  /** SSE 事件流（PRD §4.7），支持 Last-Event-ID 断点重放。 */
  @Get('tasks/:id/events')
  async events(@Param('id') id: string, @Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    await this.access.task(currentUser(req), id, 'view');
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    raw.write('retry: 2000\n\n');

    const lastId = Number(req.headers['last-event-id'] ?? (req.query as { lastEventId?: string })?.lastEventId ?? 0);
    const afterSeq = Number.isFinite(lastId) ? lastId : 0;

    const send = (seq: number, event: unknown) => {
      raw.write(`id: ${seq}\n`);
      raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const finish = () => {
      setTimeout(() => {
        raw.write('event: done\ndata: {}\n\n');
        raw.end();
      }, 100);
    };
    const gate = new SseGate(afterSeq);
    const deliver = (rec: TaskEventRecord) => {
      send(rec.seq, rec.event);
      if (['task.completed', 'task.failed', 'task.cancelled'].includes(rec.event.type)) finish();
    };

    // 1) 先订阅：回放期间到达的实时事件先暂存，避免「回放完到订阅前」的丢事件窗口
    const unsub = this.bus.subscribe(id, (rec) => gate.live(rec, deliver));

    // 2) 回放历史（重连续传）
    const history = await this.bus.replay(id, afterSeq);
    for (const rec of history) {
      send(rec.seq, rec.event);
      gate.replayed(rec.seq);
    }

    // 3) 若任务已终结且无更多事件，收尾
    const task = await this.prisma.task.findUnique({ where: { id } });
    const terminal = task && ['completed', 'failed', 'cancelled'].includes(task.status);
    if (terminal && !this.tasks.isRunning(id)) {
      unsub();
      raw.write('event: done\ndata: {}\n\n');
      raw.end();
      return;
    }

    // 4) 放行暂存的实时事件，之后按 seq 去重直投（乱序不丢）
    gate.markReady(deliver);

    const heartbeat = setInterval(() => raw.write(': ping\n\n'), 15000);
    this.metrics.sseConnections.inc();
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      unsub();
      this.metrics.sseConnections.dec();
    });
  }
}
