import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import path from 'node:path';

/**
 * 解析数据库连接串（生产 P1 修复）。
 *
 * 坑：Prisma CLI 把 schema.prisma 里的相对 `file:./x.db` 解析为**相对 schema 目录**，
 * 而应用进程默认按 **cwd** 解析 —— 同一个字符串指向两个文件，会造成
 * 「迁移打到 A 库、应用读 B 库」这类生产事故。
 * 这里统一：相对 file: 路径一律相对 prisma/ 目录解析，与 CLI 行为一致。
 * 生产建议直接给绝对路径或 postgresql:// 连接串。
 */
export function resolveDatabaseUrl(raw?: string): string {
  const url = raw ?? process.env.DATABASE_URL_PRISMA ?? process.env.DATABASE_URL ?? 'file:./dev.db';
  if (!url.startsWith('file:')) return url; // postgres 等直接用
  const p = url.slice('file:'.length);
  if (path.isAbsolute(p)) return url;
  // 相对路径 → 相对 <server>/prisma 解析（与 Prisma CLI 一致）。
  // __dirname 在编译产物中为 <server>/dist，源码运行时为 <server>/src，上一级即 <server>。
  const serverRoot = path.resolve(__dirname, '..');
  return 'file:' + path.resolve(serverRoot, 'prisma', p);
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  private static readonly log = new Logger('Prisma');
  private readonly url: string;

  constructor() {
    const url = resolveDatabaseUrl();
    super({ datasources: { db: { url } } });
    this.url = url;
  }

  async onModuleInit() {
    await this.$connect();
    PrismaService.log.log(`数据库：${this.url.replace(/:\/\/[^@]*@/, '://***@')}`);
    await this.assertSchemaReady();
  }

  /**
   * 启动即校验表结构存在（快速失败）。
   * 否则 schema 未迁移时会在用户点某个功能时才 500，排查成本极高。
   */
  private async assertSchemaReady() {
    const required = ['Org', 'User', 'Workspace', 'WorkspaceMember', 'Task', 'TaskEventRow'];
    for (const table of required) {
      try {
        await this.$queryRawUnsafe(`SELECT 1 FROM "${table}" LIMIT 1`);
      } catch {
        throw new Error(
          `数据库缺少表 ${table} —— 请先执行迁移：\n` +
            `  cd apps/server && npx prisma migrate deploy   （生产）\n` +
            `  cd apps/server && npx prisma db push          （开发）\n` +
            `当前连接：${this.url}`,
        );
      }
    }
  }
}
