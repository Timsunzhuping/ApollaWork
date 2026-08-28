import { Controller, Get, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import path from 'node:path';
import { PrismaService } from '../prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { AuthGuard, currentUser } from '../auth/auth.js';
import { AccessService } from '../access/access.service.js';
import { mimeOf } from '../common/mime.js';

@UseGuards(AuthGuard)
@Controller('api/v1')
export class FilesController {
  constructor(
    private prisma: PrismaService,
    private storage: StorageService,
    private access: AccessService,
  ) {}

  @Get('workspaces/:id/files')
  async list(@Req() req: FastifyRequest, @Param('id') id: string) {
    await this.access.workspace(currentUser(req), id, 'view');
    const files = await this.storage.list(id);
    return files
      .map((f) => ({ ...f, mime: mimeOf(f.path) }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  /** 上传（multipart）。依赖 @fastify/multipart（在 main.ts 注册）。 */
  @Post('workspaces/:id/files')
  async upload(@Param('id') id: string, @Req() req: FastifyRequest) {
    await this.access.workspace(currentUser(req), id, 'edit');
    const mp = req as FastifyRequest & { parts?: () => AsyncIterableIterator<any> };
    if (!mp.parts) return { error: '需要 multipart 上传' };
    const saved: { path: string; size: number }[] = [];
    for await (const part of mp.parts()) {
      if (part.type === 'file') {
        const rel = (part.fieldname && part.fieldname !== 'file' ? part.fieldname + '/' : '') + part.filename;
        const buf = await part.toBuffer();
        const size = await this.storage.writeFile(id, rel, buf);
        await this.prisma.fileEntry.upsert({
          where: { workspaceId_path: { workspaceId: id, path: rel } },
          create: { workspaceId: id, path: rel, size, mime: mimeOf(rel) },
          update: { size, version: { increment: 1 } },
        });
        saved.push({ path: rel, size });
      }
    }
    return { saved };
  }

  @Get('workspaces/:id/file')
  async download(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Query('path') rel: string,
    @Query('inline') inline: string,
    @Res() reply: FastifyReply,
  ) {
    await this.access.workspace(currentUser(req), id, 'view');
    if (!(await this.storage.exists(id, rel))) return reply.code(404).send({ error: 'not found' });
    const buf = await this.storage.readFile(id, rel);
    const mime = mimeOf(rel);
    reply.header('Content-Type', mime);
    if (inline !== '1') {
      reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(path.basename(rel))}"`);
    }
    return reply.send(buf);
  }
}
