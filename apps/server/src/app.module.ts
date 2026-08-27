import { Module } from '@nestjs/common';
import { loadConfig, CONFIG } from './config.js';
import { PrismaService } from './prisma.service.js';
import { EventBus } from './events/event-bus.service.js';
import { StorageService } from './storage/storage.service.js';
import { AuditService } from './audit/audit.service.js';
import { TaskManager } from './tasks/task-manager.service.js';
import { AuthGuard } from './auth/auth.js';
import { WorkspacesController } from './api/workspaces.controller.js';
import { TasksController } from './api/tasks.controller.js';
import { FilesController } from './api/files.controller.js';
import { SkillsController } from './api/skills.controller.js';
import { AdminController } from './api/admin.controller.js';

@Module({
  controllers: [
    WorkspacesController,
    TasksController,
    FilesController,
    SkillsController,
    AdminController,
  ],
  providers: [
    { provide: CONFIG, useFactory: loadConfig },
    PrismaService,
    EventBus,
    StorageService,
    AuditService,
    TaskManager,
    AuthGuard,
  ],
})
export class AppModule {}
