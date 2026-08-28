import { PrismaClient } from '@prisma/client';

// 与应用同一套解析：相对 file: 路径相对 prisma/ 目录（与 Prisma CLI 一致）
const raw = process.env.DATABASE_URL_PRISMA ?? 'file:./dev.db';
const url =
  raw.startsWith('file:') && !raw.slice(5).startsWith('/')
    ? 'file:' + new URL(raw.slice(5), import.meta.url).pathname
    : raw;
const prisma = new PrismaClient({ datasources: { db: { url } } });

async function main() {
  // 组织
  let org = await prisma.org.findFirst();
  if (!org) org = await prisma.org.create({ data: { name: 'Apolla 演示企业' } });

  // 内置管理员（dev 认证用）
  let user = await prisma.user.findUnique({ where: { email: 'tim.sun@hermess.ai' } });
  if (!user) {
    user = await prisma.user.create({
      data: { email: 'tim.sun@hermess.ai', name: 'Tim' },
    });
  }
  await prisma.membership.upsert({
    where: { orgId_userId: { orgId: org.id, userId: user.id } },
    create: { orgId: org.id, userId: user.id, role: 'admin' },
    update: { role: 'admin' },
  });

  // 默认工作空间（创建者即 owner）
  const wsCount = await prisma.workspace.count({ where: { orgId: org.id } });
  if (wsCount === 0) {
    await prisma.workspace.create({
      data: {
        orgId: org.id,
        name: '我的工作台',
        description: '默认工作空间',
        defaultMode: 'auto',
        members: { create: { userId: user.id, role: 'owner' } },
      },
    });
  }

  // 迁移兜底：历史空间若无任何成员，把内置管理员补为 owner（避免升级后自己被锁在外面）
  const orphans = await prisma.workspace.findMany({
    where: { orgId: org.id, deletedAt: null, members: { none: {} } },
    select: { id: true, name: true },
  });
  for (const ws of orphans) {
    await prisma.workspaceMember.create({
      data: { workspaceId: ws.id, userId: user.id, role: 'owner' },
    });
    console.log('  补建空间成员:', ws.name);
  }

  console.log('✅ 种子数据就绪：', { org: org.name, admin: user.email });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
