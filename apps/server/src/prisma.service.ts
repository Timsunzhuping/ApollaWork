import { Injectable, type OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  constructor() {
    super({
      datasources: {
        db: { url: process.env.DATABASE_URL_PRISMA ?? process.env.DATABASE_URL ?? 'file:./dev.db' },
      },
    });
  }
  async onModuleInit() {
    await this.$connect();
  }
}
