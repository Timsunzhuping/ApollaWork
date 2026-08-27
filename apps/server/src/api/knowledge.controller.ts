import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.js';
import { KbService } from '../knowledge/kb.service.js';
import { StorageService } from '../storage/storage.service.js';

@UseGuards(AuthGuard)
@Controller('api/v1')
export class KnowledgeController {
  constructor(
    private kb: KbService,
    private storage: StorageService,
  ) {}

  @Get('workspaces/:id/kb/docs')
  async docs(@Param('id') id: string) {
    return this.kb.listDocs(id);
  }

  /** 把工作区内已有文件加入知识库（前端先上传到工作区，再调此入库）。 */
  @Post('workspaces/:id/kb/ingest')
  async ingest(@Param('id') id: string, @Body() body: { path: string }) {
    if (!this.storage.exists(id, body.path)) return { error: '文件不存在' };
    const abs = this.storage.absPath(id, body.path);
    const res = await this.kb.ingest(id, abs);
    return { ok: true, ...res };
  }

  @Post('workspaces/:id/kb/search')
  async search(@Param('id') id: string, @Body() body: { query: string; k?: number }) {
    return this.kb.search(id, body.query, body.k ?? 5);
  }
}
