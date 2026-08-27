import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL_PRISMA ?? 'file:./dev.db' } },
});

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

  // 默认工作空间
  const wsCount = await prisma.workspace.count({ where: { orgId: org.id } });
  if (wsCount === 0) {
    await prisma.workspace.create({
      data: { orgId: org.id, name: '我的工作台', description: '默认工作空间', defaultMode: 'auto' },
    });
  }

  console.log('✅ 种子数据就绪：', { org: org.name, admin: user.email });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
