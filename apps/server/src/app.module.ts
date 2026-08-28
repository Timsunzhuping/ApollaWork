import { Module } from '@nestjs/common';
import { loadConfig, CONFIG } from './config.js';
import { PrismaService } from './prisma.service.js';
import { EventBus } from './events/event-bus.service.js';
import { StorageService } from './storage/storage.service.js';
import { AuditService } from './audit/audit.service.js';
import { TaskManager } from './tasks/task-manager.service.js';
import { AutomationService } from './automation/automation.service.js';
import { ConnectorService } from './connectors/connector.service.js';
import { KbService } from './knowledge/kb.service.js';
import { ModelService } from './models/model.service.js';
import { MarketplaceService } from './marketplace/marketplace.service.js';
import { AuthGuard } from './auth/auth.js';
import { AccessService } from './access/access.service.js';
import { QuotaService } from './quota/quota.service.js';
import { HealthController } from './health/health.controller.js';
import { AuthConfigController } from './api/auth.controller.js';
import { WorkspacesController } from './api/workspaces.controller.js';
import { TasksController } from './api/tasks.controller.js';
import { FilesController } from './api/files.controller.js';
import { SkillsController } from './api/skills.controller.js';
import { AdminController } from './api/admin.controller.js';
import { AutomationController } from './api/automation.controller.js';
import { ConnectorsController } from './api/connectors.controller.js';
import { KnowledgeController } from './api/knowledge.controller.js';
import { MarketplaceController } from './api/marketplace.controller.js';

@Module({
  controllers: [
    WorkspacesController,
    TasksController,
    FilesController,
    SkillsController,
    AdminController,
    AutomationController,
    ConnectorsController,
    KnowledgeController,
    MarketplaceController,
    HealthController,
    AuthConfigController,
  ],
  providers: [
    { provide: CONFIG, useFactory: loadConfig },
    PrismaService,
    EventBus,
    StorageService,
    AuditService,
    TaskManager,
    AutomationService,
    ConnectorService,
    KbService,
    ModelService,
    MarketplaceService,
    AccessService,
    QuotaService,
    AuthGuard,
  ],
})
export class AppModule {}
