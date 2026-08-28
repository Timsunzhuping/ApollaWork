import { describe, expect, it, beforeEach } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AccessService } from './access.service.js';
import type { AuthUser } from '../auth/auth.js';

/**
 * 越权防护测试（生产 P0）。用内存假 Prisma 精确构造跨组织/跨空间场景。
 * 断言：非成员一律 404（不泄露存在性）、权限不足 403、组织隔离生效。
 */
type WS = { id: string; orgId: string; deletedAt: Date | null };
type WM = { workspaceId: string; userId: string; role: string };

class FakePrisma {
  workspaces: WS[] = [];
  members: WM[] = [];
  sessions: { id: string; workspaceId: string }[] = [];
  tasks: { id: string; sessionId: string }[] = [];
  approvals: { id: string; taskId: string }[] = [];
  automations: { id: string; workspaceId: string }[] = [];

  workspace = {
    findFirst: async ({ where }: any) =>
      this.workspaces.find((w) => w.id === where.id && w.deletedAt === null) ?? null,
    findMany: async ({ where }: any) =>
      this.workspaces.filter(
        (w) =>
          w.deletedAt === null &&
          (where.orgId ? w.orgId === where.orgId : true) &&
          (where.id?.in ? where.id.in.includes(w.id) : true),
      ),
  };
  workspaceMember = {
    findUnique: async ({ where }: any) =>
      this.members.find(
        (m) =>
          m.workspaceId === where.workspaceId_userId.workspaceId &&
          m.userId === where.workspaceId_userId.userId,
      ) ?? null,
    findMany: async ({ where }: any) => this.members.filter((m) => m.userId === where.userId),
  };
  session = { findUnique: async ({ where }: any) => this.sessions.find((s) => s.id === where.id) ?? null };
  task = {
    findUnique: async ({ where }: any) => {
      const t = this.tasks.find((x) => x.id === where.id);
      if (!t) return null;
      return { ...t, session: this.sessions.find((s) => s.id === t.sessionId)! };
    },
  };
  approval = { findUnique: async ({ where }: any) => this.approvals.find((a) => a.id === where.id) ?? null };
  automation = { findUnique: async ({ where }: any) => this.automations.find((a) => a.id === where.id) ?? null };
}

const alice: AuthUser = { id: 'u-alice', email: 'a@x.com', name: 'Alice', role: 'member', orgId: 'org-1' };
const bob: AuthUser = { id: 'u-bob', email: 'b@x.com', name: 'Bob', role: 'member', orgId: 'org-1' };
const viewer: AuthUser = { id: 'u-view', email: 'v@x.com', name: 'V', role: 'member', orgId: 'org-1' };
const admin: AuthUser = { id: 'u-admin', email: 'ad@x.com', name: 'Ad', role: 'admin', orgId: 'org-1' };
const outsider: AuthUser = { id: 'u-out', email: 'o@y.com', name: 'O', role: 'admin', orgId: 'org-2' };

let db: FakePrisma;
let access: AccessService;

beforeEach(() => {
  db = new FakePrisma();
  access = new AccessService(db as never);
  // Alice 的空间（她是 editor，viewer 是只读成员，Bob 不是成员）
  db.workspaces.push({ id: 'ws-a', orgId: 'org-1', deletedAt: null });
  db.members.push({ workspaceId: 'ws-a', userId: 'u-alice', role: 'editor' });
  db.members.push({ workspaceId: 'ws-a', userId: 'u-view', role: 'viewer' });
  db.sessions.push({ id: 'ses-a', workspaceId: 'ws-a' });
  db.tasks.push({ id: 'task-a', sessionId: 'ses-a' });
  db.approvals.push({ id: 'appr-a', taskId: 'task-a' });
  db.automations.push({ id: 'auto-a', workspaceId: 'ws-a' });
  // 另一组织的空间
  db.workspaces.push({ id: 'ws-other', orgId: 'org-2', deletedAt: null });
});

describe('越权防护：工作空间', () => {
  it('成员可访问自己的空间', async () => {
    await expect(access.workspace(alice, 'ws-a', 'edit')).resolves.toBeTruthy();
  });

  it('★ 非成员访问他人空间 → 404（不泄露存在性）', async () => {
    await expect(access.workspace(bob, 'ws-a', 'view')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('★ 跨组织访问 → 404（即便对方是自己组织的管理员）', async () => {
    await expect(access.workspace(outsider, 'ws-a', 'view')).rejects.toBeInstanceOf(NotFoundException);
    await expect(access.workspace(admin, 'ws-other', 'view')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('★ viewer 写操作 → 403（权限不足）', async () => {
    await expect(access.workspace(viewer, 'ws-a', 'view')).resolves.toBeTruthy();
    await expect(access.workspace(viewer, 'ws-a', 'edit')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('★ editor 不能执行 owner 级操作（删空间/管成员）', async () => {
    await expect(access.workspace(alice, 'ws-a', 'own')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('组织管理员对本组织空间有 owner 级权限', async () => {
    await expect(access.workspace(admin, 'ws-a', 'own')).resolves.toBeTruthy();
  });

  it('已软删除的空间不可访问', async () => {
    db.workspaces[0].deletedAt = new Date();
    await expect(access.workspace(alice, 'ws-a', 'view')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('越权防护：任务链路（session→task→approval）', () => {
  it('★ 非成员读他人任务 → 404（原漏洞：知道 id 即可读）', async () => {
    await expect(access.task(bob, 'task-a', 'view')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('★ 非成员操作他人审批 → 404（原漏洞：可代他人批准危险命令）', async () => {
    await expect(access.approval(bob, 'appr-a', 'edit')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('★ 非成员访问他人会话 → 404', async () => {
    await expect(access.session(bob, 'ses-a', 'view')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('★ 非成员操作他人自动化任务 → 404', async () => {
    await expect(access.automation(bob, 'auto-a', 'edit')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('viewer 可读任务但不可取消/追加指令', async () => {
    await expect(access.task(viewer, 'task-a', 'view')).resolves.toBeTruthy();
    await expect(access.task(viewer, 'task-a', 'edit')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('成员可正常读写自己空间的任务', async () => {
    await expect(access.task(alice, 'task-a', 'edit')).resolves.toBeTruthy();
  });

  it('不存在的资源 → 404', async () => {
    await expect(access.task(alice, 'no-such', 'view')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('越权防护：管理员治理端点', () => {
  it('★ 普通成员调用管理端点 → 403（原漏洞：可改模型密钥/读全量审计）', () => {
    expect(() => access.requireAdmin(alice)).toThrow(ForbiddenException);
  });
  it('管理员放行', () => {
    expect(() => access.requireAdmin(admin)).not.toThrow();
  });
});

describe('空间列表按成员资格过滤', () => {
  it('★ 普通成员只看到自己有成员资格的空间', async () => {
    const list = await access.listWorkspaces(alice);
    expect(list.map((w) => w.id)).toEqual(['ws-a']);
    const bobList = await access.listWorkspaces(bob);
    expect(bobList).toEqual([]);
  });

  it('管理员看到本组织全部空间（不含他组织）', async () => {
    db.workspaces.push({ id: 'ws-b', orgId: 'org-1', deletedAt: null });
    const list = await access.listWorkspaces(admin);
    expect(list.map((w) => w.id).sort()).toEqual(['ws-a', 'ws-b']);
    expect(list.some((w) => w.id === 'ws-other')).toBe(false);
  });
});
