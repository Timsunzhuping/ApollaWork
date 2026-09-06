import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron } from 'croner';
import { PrismaService } from '../prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { CONFIG, type AppConfig } from '../config.js';
import { GENESIS, archiveFileName, buildAuditArchive } from '../audit/audit-archive.js';

/** 审计归档落在这个系统级伪工作空间下（S3 驱动时建议对该前缀开 Object Lock） */
const AUDIT_WS = '_system';
const CHAIN_REL = 'audit-archive/chain.json';

export interface RetentionResult {
  taskEvents: number;
  tasks: number;
  usageRecords: number;
  auditEvents: number;
  dryRun: boolean;
}

/**
 * 数据留存与清理（生产必备）。
 *
 * 此前事件表与审计表**无限增长**：一个任务约 19 条事件，
 * 一个百人团队每天几百个任务，一年就是千万级行 —— 查询变慢、备份变大、
 * 而且违反「个人数据不应无限期保留」的合规要求。
 *
 * 三条独立留存期：
 *   - 任务与事件：业务数据，默认 180 天
 *   - 用量记录：计量数据，默认 400 天（跨年对账）
 *   - 审计日志：合规数据，默认 730 天，且**永不随任务删除而丢失**
 *     （审计是「不可删」的，只在超过法定留存期后才清理）
 *
 * 0 = 永久保留。删除是分批的，避免长事务锁表。
 */
@Injectable()
export class RetentionService implements OnModuleInit {
  private readonly log = new Logger('Retention');
  private job?: Cron;

  constructor(
    private prisma: PrismaService,
    private storage: StorageService,
    @Inject(CONFIG) private config: AppConfig,
  ) {}

  onModuleInit() {
    const { cron, tz } = this.config.retention;
    if (!cron) {
      this.log.log('数据留存清理：未启用（RETENTION_CRON 为空）');
      return;
    }
    try {
      this.job = new Cron(cron, { timezone: tz, name: 'retention' }, () => {
        void this.run(false).catch((e) => this.log.error(`清理失败：${(e as Error).message}`));
      });
      const { taskDays, usageDays, auditDays } = this.config.retention;
      this.log.log(
        `数据留存清理：已启用（${cron}）· 任务 ${taskDays || '∞'}天 · 用量 ${usageDays || '∞'}天 · 审计 ${auditDays || '∞'}天`,
      );
    } catch (e) {
      this.log.warn(`留存 cron 无效，未启用：${(e as Error).message}`);
    }
  }

  /** 把即将删除的审计行归档为哈希链 JSONL，并接上上一批的链头 */
  private async archiveAudit(where: { ts: { lt: Date } }, cutoff: Date) {
    const rows: Parameters<typeof buildAuditArchive>[0] = [];
    for (let skip = 0; ; skip += 5000) {
      const page = await this.prisma.auditEvent.findMany({ where, orderBy: { ts: 'asc' }, take: 5000, skip });
      rows.push(...page);
      if (page.length < 5000) break;
    }
    if (!rows.length) return;
    let prev = GENESIS;
    if (await this.storage.exists(AUDIT_WS, CHAIN_REL)) {
      try {
        const head = JSON.parse((await this.storage.readFile(AUDIT_WS, CHAIN_REL)).toString()) as { lastHash?: string };
        prev = head.lastHash || GENESIS;
      } catch {
        this.log.warn('审计归档链头损坏，本批从 GENESIS 重新起链');
      }
    }
    const archive = buildAuditArchive(rows, prev);
    const rel = archiveFileName(new Date(), cutoff);
    await this.storage.writeFile(AUDIT_WS, rel, archive.body);
    await this.storage.writeFile(
      AUDIT_WS,
      CHAIN_REL,
      JSON.stringify({ lastHash: archive.lastHash, lastFile: rel, updatedAt: new Date().toISOString() }),
    );
    this.log.log(`审计归档：${archive.count} 行 → ${rel}（链头 ${archive.lastHash.slice(0, 12)}）`);
  }

  private cutoff(days: number): Date | null {
    return days > 0 ? new Date(Date.now() - days * 86_400_000) : null;
  }

  /**
   * 执行清理。dryRun=true 只统计不删除（供管理员预览影响面）。
   * 只清理**已终结**的任务，运行中的任务永不动。
   */
  async run(dryRun = false): Promise<RetentionResult> {
    const { taskDays, usageDays, auditDays } = this.config.retention;
    const res: RetentionResult = {
      taskEvents: 0,
      tasks: 0,
      usageRecords: 0,
      auditEvents: 0,
      dryRun,
    };

    const taskCut = this.cutoff(taskDays);
    if (taskCut) {
      const stale = await this.prisma.task.findMany({
        where: {
          createdAt: { lt: taskCut },
          status: { in: ['completed', 'failed', 'cancelled'] },
        },
        select: { id: true },
        take: 5000, // 分批，避免长事务
      });
      const ids = stale.map((t) => t.id);
      res.tasks = ids.length;
      if (ids.length) {
        res.taskEvents = await this.prisma.taskEventRow
          .count({ where: { taskId: { in: ids } } })
          .catch(() => 0);
        if (!dryRun) {
          // 顺序：子表 → 主表（外键约束）
          await this.prisma.taskEventRow.deleteMany({ where: { taskId: { in: ids } } });
          await this.prisma.approval.deleteMany({ where: { taskId: { in: ids } } });
          await this.prisma.artifact.deleteMany({ where: { taskId: { in: ids } } });
          await this.prisma.task.deleteMany({ where: { id: { in: ids } } });
        }
      }
    }

    const usageCut = this.cutoff(usageDays);
    if (usageCut) {
      const where = { ts: { lt: usageCut } };
      res.usageRecords = await this.prisma.usageRecord.count({ where });
      if (!dryRun && res.usageRecords) await this.prisma.usageRecord.deleteMany({ where });
    }

    // 审计最后清理，且留存期最长 —— 即便任务已删，审计仍应可追溯。
    // T-405：删除前先归档为哈希链 JSONL；删除必须在声明 apolla.retention_job 的事务内进行，
    // 否则 DB 触发器会拒绝 —— 审计不可变是 DB 机制，这里是唯一合法的删除路径。
    const auditCut = this.cutoff(auditDays);
    if (auditCut) {
      const where = { ts: { lt: auditCut } };
      res.auditEvents = await this.prisma.auditEvent.count({ where });
      if (!dryRun && res.auditEvents) {
        await this.archiveAudit(where, auditCut);
        await this.prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL apolla.retention_job = 'on'`);
          await tx.auditEvent.deleteMany({ where });
        });
      }
    }

    const verb = dryRun ? '预览' : '清理';
    if (res.tasks || res.usageRecords || res.auditEvents) {
      this.log.log(
        `数据留存${verb}：任务 ${res.tasks}（事件 ${res.taskEvents}）· 用量 ${res.usageRecords} · 审计 ${res.auditEvents}`,
      );
    }
    return res;
  }

  /** 当前留存配置（供管理后台展示）。 */
  policy() {
    return { ...this.config.retention, nextRun: this.job?.nextRun()?.toISOString() ?? null };
  }
}
