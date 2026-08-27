import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron } from 'croner';
import { PrismaService } from '../prisma.service.js';
import { TaskManager } from '../tasks/task-manager.service.js';
import { AuditService } from '../audit/audit.service.js';

/**
 * 自动化调度（PRD T-204）：按 cron 定时触发任务模板。
 * 单机用 croner 进程内调度；集群版换 BullMQ repeatable（保持同一 fire 语义）。
 */
@Injectable()
export class AutomationService implements OnModuleInit {
  private readonly log = new Logger('Automation');
  private jobs = new Map<string, Cron>();

  constructor(
    private prisma: PrismaService,
    private tasks: TaskManager,
    private audit: AuditService,
  ) {}

  async onModuleInit() {
    const list = await this.prisma.automation.findMany({ where: { enabled: true } });
    for (const a of list) this.schedule(a.id, a.cron, a.tz);
    if (list.length) this.log.log(`已加载 ${list.length} 个定时任务`);
  }

  private schedule(id: string, cron: string, tz: string) {
    this.jobs.get(id)?.stop();
    try {
      const job = new Cron(cron, { timezone: tz, name: id }, () => void this.fire(id));
      this.jobs.set(id, job);
    } catch (e) {
      this.log.warn(`定时表达式无效 ${id}: ${(e as Error).message}`);
    }
  }

  /** 触发一次：按模板新建 session+task */
  async fire(id: string) {
    const a = await this.prisma.automation.findUnique({ where: { id } });
    if (!a || !a.enabled) return;
    const session = await this.prisma.session.create({
      data: { workspaceId: a.workspaceId, title: `[定时] ${a.name}` },
    });
    const task = await this.tasks.createTask({
      sessionId: session.id,
      workspaceId: a.workspaceId,
      prompt: a.prompt,
      mode: a.mode as never,
      modelTier: 'auto',
      attachments: [],
      actor: `automation:${id}`,
    });
    await this.prisma.automation.update({
      where: { id },
      data: { lastStatus: 'triggered', lastRunAt: new Date() },
    });
    await this.audit.record(`automation:${id}`, 'automation.fire', task.id, a.name);
    this.log.log(`定时任务触发：${a.name} → task ${task.id}`);
    return task.id;
  }

  async upsert(input: {
    id?: string;
    workspaceId: string;
    name: string;
    cron: string;
    tz?: string;
    prompt: string;
    mode?: string;
  }) {
    const tz = input.tz ?? 'Asia/Shanghai';
    // 校验 cron
    try {
      const probe = new Cron(input.cron, { timezone: tz });
      probe.stop();
    } catch (e) {
      throw new Error(`cron 表达式无效：${(e as Error).message}`);
    }
    const row = input.id
      ? await this.prisma.automation.update({
          where: { id: input.id },
          data: { name: input.name, cron: input.cron, tz, prompt: input.prompt, mode: input.mode ?? 'auto' },
        })
      : await this.prisma.automation.create({
          data: {
            workspaceId: input.workspaceId,
            name: input.name,
            cron: input.cron,
            tz,
            prompt: input.prompt,
            mode: input.mode ?? 'auto',
          },
        });
    this.schedule(row.id, row.cron, row.tz);
    return row;
  }

  async list(workspaceId: string) {
    const rows = await this.prisma.automation.findMany({ where: { workspaceId } });
    return rows.map((r) => ({ ...r, nextRun: this.jobs.get(r.id)?.nextRun()?.toISOString() ?? null }));
  }

  async remove(id: string) {
    this.jobs.get(id)?.stop();
    this.jobs.delete(id);
    await this.prisma.automation.delete({ where: { id } });
  }
}
