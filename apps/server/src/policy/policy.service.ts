import { BadRequestException, Injectable } from '@nestjs/common';
import { DANGER_RULES, type SerializedRule } from '@apolla/runtime';
import { PrismaService } from '../prisma.service.js';

/**
 * 审批规则表 / 策略中心（T-413）。
 * 此前 15 条危险命令规则硬编码在 agent-tools/dangerous.ts，管理员不可配置。
 * 现在：内置规则可按组织**禁用**（不可删、不可改正文），并可追加组织级或工作空间级自定义规则；
 * 任务启动时由 effectiveRules() 算出生效集合下发给 runtime（本地进程内传参、容器经环境变量）。
 */

export interface PolicyRow {
  id: string;
  orgId: string;
  workspaceId: string | null;
  builtinKey: string | null;
  kind: string;
  pattern: string;
  flags: string;
  reason: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface PolicyView {
  id: string | null; // 内置且未被覆盖时为 null
  builtinKey: string | null;
  builtin: boolean;
  workspaceId: string | null;
  kind: string;
  pattern: string;
  flags: string;
  reason: string;
  enabled: boolean;
}

const MAX_PATTERN = 400;
const VALID_KINDS = new Set(['bash_command', 'file_delete', 'file_overwrite', 'network_egress']);

/** 正则必须能编译；顺带拦住明显的灾难性回溯写法 */
export function validatePattern(pattern: string, flags = ''): RegExp {
  if (!pattern.trim()) throw new BadRequestException('规则正文不能为空');
  if (pattern.length > MAX_PATTERN) throw new BadRequestException(`规则正文超过 ${MAX_PATTERN} 字符`);
  if (!/^[gimsuy]*$/.test(flags)) throw new BadRequestException('正则标志只能是 gimsuy');
  if (/\([^)]*[+*]\)[+*]/.test(pattern)) throw new BadRequestException('规则含嵌套量词（如 (a+)+），存在灾难性回溯风险');
  try {
    return new RegExp(pattern, flags);
  } catch (e) {
    throw new BadRequestException(`正则无法编译：${(e as Error).message}`);
  }
}

@Injectable()
export class PolicyService {
  constructor(private prisma: PrismaService) {}

  /** 管理后台视图：内置规则（带禁用状态）+ 自定义规则 */
  async list(orgId: string): Promise<PolicyView[]> {
    const rows = (await this.prisma.policy.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } })) as PolicyRow[];
    const overrides = new Map(rows.filter((r) => r.builtinKey).map((r) => [r.builtinKey!, r]));
    const builtins: PolicyView[] = DANGER_RULES.map((r) => {
      const o = overrides.get(r.key);
      return {
        id: o?.id ?? null,
        builtinKey: r.key,
        builtin: true,
        workspaceId: null,
        kind: r.kind,
        pattern: r.pattern.source,
        flags: r.pattern.flags,
        reason: r.reason,
        enabled: o ? o.enabled : true,
      };
    });
    const customs: PolicyView[] = rows
      .filter((r) => !r.builtinKey)
      .map((r) => ({
        id: r.id,
        builtinKey: null,
        builtin: false,
        workspaceId: r.workspaceId,
        kind: r.kind,
        pattern: r.pattern,
        flags: r.flags,
        reason: r.reason,
        enabled: r.enabled,
      }));
    return [...builtins, ...customs];
  }

  /** 任务启动时下发给 runtime 的生效规则：内置（去掉被禁用的）+ 组织级与该工作空间级的自定义启用规则 */
  async effectiveRules(orgId: string, workspaceId?: string): Promise<SerializedRule[]> {
    const rows = (await this.prisma.policy.findMany({
      where: { orgId, OR: [{ workspaceId: null }, ...(workspaceId ? [{ workspaceId }] : [])] },
    })) as PolicyRow[];
    const disabled = new Set(rows.filter((r) => r.builtinKey && !r.enabled).map((r) => r.builtinKey!));
    const builtins: SerializedRule[] = DANGER_RULES.filter((r) => !disabled.has(r.key)).map((r) => ({
      key: r.key,
      pattern: r.pattern.source,
      flags: r.pattern.flags,
      kind: r.kind,
      reason: r.reason,
    }));
    const customs: SerializedRule[] = rows
      .filter((r) => !r.builtinKey && r.enabled)
      .map((r) => ({ key: `custom:${r.id}`, pattern: r.pattern, flags: r.flags, kind: r.kind as SerializedRule['kind'], reason: r.reason }));
    return [...builtins, ...customs];
  }

  /** 内置规则只能启停，不能删、不能改正文 —— 关掉「递归删除」这类规则本身就该留痕 */
  async setBuiltin(orgId: string, key: string, enabled: boolean) {
    const rule = DANGER_RULES.find((r) => r.key === key);
    if (!rule) throw new BadRequestException(`没有内置规则 ${key}`);
    const existing = await this.prisma.policy.findFirst({ where: { orgId, builtinKey: key } });
    if (existing) {
      return this.prisma.policy.update({ where: { id: existing.id }, data: { enabled } });
    }
    return this.prisma.policy.create({
      data: {
        orgId,
        builtinKey: key,
        kind: rule.kind,
        pattern: rule.pattern.source,
        flags: rule.pattern.flags,
        reason: rule.reason,
        enabled,
      },
    });
  }

  async createCustom(
    orgId: string,
    input: { kind: string; pattern: string; flags?: string; reason: string; workspaceId?: string | null },
  ) {
    if (!VALID_KINDS.has(input.kind)) throw new BadRequestException(`kind 只能是 ${[...VALID_KINDS].join(' / ')}`);
    if (!input.reason?.trim()) throw new BadRequestException('请填写规则说明（审批弹窗里会展示给用户）');
    validatePattern(input.pattern, input.flags ?? '');
    return this.prisma.policy.create({
      data: {
        orgId,
        workspaceId: input.workspaceId ?? null,
        kind: input.kind,
        pattern: input.pattern,
        flags: input.flags ?? '',
        reason: input.reason.trim(),
        enabled: true,
      },
    });
  }

  async updateCustom(orgId: string, id: string, patch: { enabled?: boolean; pattern?: string; flags?: string; reason?: string }) {
    const row = (await this.prisma.policy.findFirst({ where: { id, orgId } })) as PolicyRow | null;
    if (!row) throw new BadRequestException('规则不存在');
    if (row.builtinKey && (patch.pattern !== undefined || patch.reason !== undefined || patch.flags !== undefined)) {
      throw new BadRequestException('内置规则只能启停，不能修改正文');
    }
    if (patch.pattern !== undefined || patch.flags !== undefined) validatePattern(patch.pattern ?? row.pattern, patch.flags ?? row.flags);
    return this.prisma.policy.update({ where: { id }, data: patch });
  }

  async deleteCustom(orgId: string, id: string) {
    const row = (await this.prisma.policy.findFirst({ where: { id, orgId } })) as PolicyRow | null;
    if (!row) throw new BadRequestException('规则不存在');
    if (row.builtinKey) throw new BadRequestException('内置规则不能删除，只能禁用');
    await this.prisma.policy.delete({ where: { id } });
  }
}
