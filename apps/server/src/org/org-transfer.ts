/**
 * 组织数据导出 / 导入（T-418 多租户迁移工具）。
 * 场景：把一个组织从共享实例迁到专属实例、或在环境间搬迁。
 * 导出为 JSONL：每行 { table, row }，按依赖顺序排列，导入时同序 upsert（保留 id，可重复导入）。
 * 只导数据库行；工作区文件与审计归档在对象存储里，用 mc mirror / rclone 按前缀同步（见 docs/ops.md）。
 * 审计事件不导出（不可变，且属于源实例的合规记录）。
 */

/** 与 Prisma 模型名一致（小写首字母即 prisma client 的委托名） */
export const ORG_TABLES = [
  'Org',
  'User',
  'Membership',
  'Workspace',
  'WorkspaceMember',
  'Session',
  'Task',
  'TaskEventRow',
  'Approval',
  'Artifact',
  'FileEntry',
  'UsageRecord',
  'Automation',
  'Connector',
  'ModelProvider',
  'Skill',
  'Policy',
  'ApiKey',
] as const;
export type OrgTable = (typeof ORG_TABLES)[number];

export interface TransferLine {
  table: OrgTable;
  row: Record<string, unknown>;
}

/** 最小 Prisma 形状：每个模型有 findMany / upsert */
type Delegate = {
  findMany(args: { where?: Record<string, unknown> }): Promise<Record<string, unknown>[]>;
  upsert(args: { where: { id: string }; create: Record<string, unknown>; update: Record<string, unknown> }): Promise<unknown>;
};
export type TransferPrisma = Record<string, Delegate>;

const delegate = (prisma: TransferPrisma, table: OrgTable): Delegate => {
  const d = prisma[table[0]!.toLowerCase() + table.slice(1)];
  if (!d) throw new Error(`Prisma 客户端缺少模型 ${table}`);
  return d;
};

/** 按依赖顺序收集一个组织的全部行 */
export async function exportOrg(prisma: TransferPrisma, orgId: string): Promise<TransferLine[]> {
  const out: TransferLine[] = [];
  const push = (table: OrgTable, rows: Record<string, unknown>[]) => rows.forEach((row) => out.push({ table, row }));

  const orgs = await delegate(prisma, 'Org').findMany({ where: { id: orgId } });
  if (!orgs.length) throw new Error(`组织不存在：${orgId}`);
  push('Org', orgs);

  const memberships = await delegate(prisma, 'Membership').findMany({ where: { orgId } });
  const userIds = memberships.map((m) => m.userId as string);
  push('User', await delegate(prisma, 'User').findMany({ where: { id: { in: userIds } } }));
  push('Membership', memberships);

  const workspaces = await delegate(prisma, 'Workspace').findMany({ where: { orgId } });
  push('Workspace', workspaces);
  const wsIds = workspaces.map((w) => w.id as string);
  push('WorkspaceMember', await delegate(prisma, 'WorkspaceMember').findMany({ where: { workspaceId: { in: wsIds } } }));

  const sessions = await delegate(prisma, 'Session').findMany({ where: { workspaceId: { in: wsIds } } });
  push('Session', sessions);
  const sessionIds = sessions.map((s) => s.id as string);
  const tasks = await delegate(prisma, 'Task').findMany({ where: { sessionId: { in: sessionIds } } });
  push('Task', tasks);
  const taskIds = tasks.map((t) => t.id as string);
  for (const table of ['TaskEventRow', 'Approval', 'Artifact'] as const) {
    push(table, await delegate(prisma, table).findMany({ where: { taskId: { in: taskIds } } }));
  }
  for (const table of ['FileEntry', 'UsageRecord', 'Automation'] as const) {
    push(table, await delegate(prisma, table).findMany({ where: { workspaceId: { in: wsIds } } }));
  }
  for (const table of ['Connector', 'ModelProvider', 'Skill', 'Policy', 'ApiKey'] as const) {
    push(table, await delegate(prisma, table).findMany({ where: { orgId } }));
  }
  return out;
}

export function toJsonl(lines: TransferLine[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + (lines.length ? '\n' : '');
}

export function fromJsonl(text: string): TransferLine[] {
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l, i) => {
      const parsed = JSON.parse(l) as TransferLine;
      if (!ORG_TABLES.includes(parsed.table)) throw new Error(`第 ${i + 1} 行：未知表 ${String(parsed.table)}`);
      return parsed;
    });
}

/** 把日期字段从 JSON 字符串还原为 Date（Prisma 需要） */
function revive(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v) && /(At|ts)$/.test(k) ? new Date(v) : v;
  }
  return out;
}

/** 导入：按导出顺序 upsert（幂等，可重复跑）。返回各表行数。 */
export async function importOrg(prisma: TransferPrisma, lines: TransferLine[]): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  // 关系字段（如 Org.users）不会出现在 findMany 结果里，直接 upsert 标量字段即可
  for (const { table, row } of lines) {
    const data = revive(row);
    const id = data.id as string;
    if (!id) throw new Error(`${table} 行缺少 id`);
    const { id: _omit, ...rest } = data;
    void _omit;
    await delegate(prisma, table).upsert({ where: { id }, create: data, update: rest });
    counts[table] = (counts[table] ?? 0) + 1;
  }
  return counts;
}
