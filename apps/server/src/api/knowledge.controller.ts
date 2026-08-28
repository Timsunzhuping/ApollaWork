import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AuthGuard, currentUser } from '../auth/auth.js';
import { AccessService } from '../access/access.service.js';
import { KbService } from '../knowledge/kb.service.js';
import { StorageService } from '../storage/storage.service.js';

@UseGuards(AuthGuard)
@Controller('api/v1')
export class KnowledgeController {
  constructor(
    private kb: KbService,
    private storage: StorageService,
    private access: AccessService,
  ) {}

  @Get('workspaces/:id/kb/docs')
  async docs(@Req() req: FastifyRequest, @Param('id') id: string) {
    await this.access.workspace(currentUser(req), id, 'view');
    return this.kb.listDocs(id);
  }

  /** 把工作区内已有文件加入知识库（前端先上传到工作区，再调此入库）。 */
  @Post('workspaces/:id/kb/ingest')
  async ingest(@Req() req: FastifyRequest, @Param('id') id: string, @Body() body: { path: string }) {
    await this.access.workspace(currentUser(req), id, 'edit');
    if (!(await this.storage.exists(id, body.path))) return { error: '文件不存在' };
    // fs 驱动直接用本地路径；S3 驱动先落地到临时文件再交给解析器
    let abs = this.storage.absPathIfLocal(id, body.path);
    let tmp: string | null = null;
    if (!abs) {
      const buf = await this.storage.readFile(id, body.path);
      const os = await import('node:os');
      const fs = await import('node:fs');
      const path = await import('node:path');
      tmp = path.join(os.tmpdir(), `apolla-kb-${Date.now()}-${path.basename(body.path)}`);
      fs.writeFileSync(tmp, buf);
      abs = tmp;
    }
    try {
      const res = await this.kb.ingest(id, abs);
      return { ok: true, ...res };
    } finally {
      if (tmp) (await import('node:fs')).rmSync(tmp, { force: true });
    }
  }

  @Post('workspaces/:id/kb/search')
  async search(@Req() req: FastifyRequest, @Param('id') id: string, @Body() body: { query: string; k?: number }) {
    await this.access.workspace(currentUser(req), id, 'view');
    return this.kb.search(id, body.query, body.k ?? 5);
  }
}
