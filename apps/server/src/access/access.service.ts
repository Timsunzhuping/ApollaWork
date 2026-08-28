import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service.js';
import type { AuthUser } from '../auth/auth.js';

/** 空间级权限等级（由低到高）。 */
export type AccessLevel = 'view' | 'edit' | 'own';
const RANK: Record<string, number> = { viewer: 1, editor: 2, owner: 3 };
const NEED: Record<AccessLevel, number> = { view: 1, edit: 2, own: 3 };

/**
 * 统一访问控制（生产 P0）。
 *
 * 规则：
 *  - 一切资源先解析到所属 workspace，再判权限，杜绝「知道 id 就能访问」。
 *  - 组织隔离：workspace.orgId 必须等于调用者 orgId。
 *  - 组织管理员（Membership.role=admin）对本组织内全部空间有 owner 级权限。
 *  - 其余用户按 WorkspaceMember.role（viewer/editor/owner）判定。
 *  - 找不到或无权 → 一律 404（不泄露资源是否存在），仅在确知有权但等级不足时返回 403。
 */
@Injectable()
export class AccessService {
  constructor(private prisma: PrismaService) {}

  /** 校验对某工作空间的访问权限，返回该空间。 */
  async workspace(user: AuthUser, workspaceId: string, need: AccessLevel = 'view') {
    const ws = await this.prisma.workspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
    });
    // 不存在、或不属于本组织 → 404（不区分，避免探测）
    if (!ws || ws.orgId !== user.orgId) throw new NotFoundException('工作空间不存在');

    if (user.role === 'admin') return ws; // 组织管理员：全空间 owner 级

    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: user.id } },
    });
    if (!member) throw new NotFoundException('工作空间不存在'); // 非成员：不泄露存在性
    if ((RANK[member.role] ?? 0) < NEED[need]) {
      throw new ForbiddenException(`需要 ${need} 权限，当前为 ${member.role}`);
    }
    return ws;
  }

  /** 校验对会话的访问权限，返回会话（含 workspaceId）。 */
  async session(user: AuthUser, sessionId: string, need: AccessLevel = 'view') {
    const s = await this.prisma.session.findUnique({ where: { id: sessionId } });
    if (!s) throw new NotFoundException('会话不存在');
    await this.workspace(user, s.workspaceId, need);
    return s;
  }

  /** 校验对任务的访问权限，返回任务（含 session）。 */
  async task(user: AuthUser, taskId: string, need: AccessLevel = 'view') {
    const t = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: { session: true },
    });
    if (!t) throw new NotFoundException('任务不存在');
    await this.workspace(user, t.session.workspaceId, need);
    return t;
  }

  /** 校验对审批项的访问权限（经其任务）。 */
  async approval(user: AuthUser, approvalId: string, need: AccessLevel = 'edit') {
    const a = await this.prisma.approval.findUnique({ where: { id: approvalId } });
    if (!a) throw new NotFoundException('审批不存在');
    await this.task(user, a.taskId, need);
    return a;
  }

  /** 校验对自动化任务的访问权限（经其空间）。 */
  async automation(user: AuthUser, automationId: string, need: AccessLevel = 'edit') {
    const a = await this.prisma.automation.findUnique({ where: { id: automationId } });
    if (!a) throw new NotFoundException('自动化任务不存在');
    await this.workspace(user, a.workspaceId, need);
    return a;
  }

  /** 组织管理员校验（模型密钥、审计、连接器等治理操作）。 */
  requireAdmin(user: AuthUser) {
    if (user.role !== 'admin') throw new ForbiddenException('需要组织管理员权限');
  }

  /** 当前用户可见的工作空间列表（管理员看本组织全部）。 */
  async listWorkspaces(user: AuthUser) {
    if (user.role === 'admin') {
      return this.prisma.workspace.findMany({
        where: { orgId: user.orgId, deletedAt: null },
        orderBy: { createdAt: 'desc' },
      });
    }
    const members = await this.prisma.workspaceMember.findMany({
      where: { userId: user.id },
      select: { workspaceId: true },
    });
    return this.prisma.workspace.findMany({
      where: {
        id: { in: members.map((m) => m.workspaceId) },
        orgId: user.orgId,
        deletedAt: null,
      },
      orderBy: { createdAt: 'desc' },
    });
  }
}
