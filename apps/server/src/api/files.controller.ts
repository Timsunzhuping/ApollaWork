import {
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UnprocessableEntityException,
  UnsupportedMediaTypeException,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import path from 'node:path';
import { PrismaService } from '../prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { AuthGuard, currentUser } from '../auth/auth.js';
import { AccessService } from '../access/access.service.js';
import { mimeOf, previewContentType } from '../common/mime.js';
import { checkUpload, loadUploadPolicy } from '../common/upload-policy.js';
import { clamOptionsFromEnv, scanBuffer } from '../common/clamav.js';
import { AuditService } from '../audit/audit.service.js';

@UseGuards(AuthGuard)
@Controller('api/v1')
export class FilesController {
  private readonly uploadPolicy = loadUploadPolicy();
  private readonly clam = clamOptionsFromEnv();

  constructor(
    private prisma: PrismaService,
    private storage: StorageService,
    private access: AccessService,
    private audit: AuditService,
  ) {}

  @Get('workspaces/:id/files')
  async list(@Req() req: FastifyRequest, @Param('id') id: string) {
    await this.access.workspace(currentUser(req), id, 'view');
    const files = await this.storage.list(id);
    return files
      .map((f) => ({ ...f, mime: mimeOf(f.path) }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * 上传（multipart）。依赖 @fastify/multipart（在 main.ts 注册）。
   * T-404 上传治理：扩展名白名单 + 魔数校验 + 可执行/宏拦截（415），
   * 可选 ClamAV 扫描（命中 422；clamd 不可达则 503 拒绝上传，fail-closed）。
   */
  @Post('workspaces/:id/files')
  async upload(@Param('id') id: string, @Req() req: FastifyRequest) {
    const user = currentUser(req);
    await this.access.workspace(user, id, 'edit');
    const mp = req as FastifyRequest & { parts?: () => AsyncIterableIterator<any> };
    if (!mp.parts) return { error: '需要 multipart 上传' };
    const saved: { path: string; size: number }[] = [];
    for await (const part of mp.parts()) {
      if (part.type === 'file') {
        const rel = (part.fieldname && part.fieldname !== 'file' ? part.fieldname + '/' : '') + part.filename;
        const buf = await part.toBuffer();
        const verdict = checkUpload(part.filename, buf.subarray(0, 8192), this.uploadPolicy);
        if (!verdict.ok) {
          await this.audit.record(user.id, 'file.upload.rejected', `${id}:${rel}`, verdict.reason);
          throw new UnsupportedMediaTypeException(`拒绝上传 ${part.filename}：${verdict.reason}`);
        }
        if (this.clam) {
          let scan;
          try {
            scan = await scanBuffer(buf, this.clam);
          } catch (e) {
            throw new ServiceUnavailableException(`病毒扫描不可用，已拒绝上传：${(e as Error).message}`);
          }
          if (!scan.clean) {
            await this.audit.record(user.id, 'file.upload.malware', `${id}:${rel}`, scan.signature);
            throw new UnprocessableEntityException(`文件 ${part.filename} 检出恶意内容（${scan.signature}），已拒绝`);
          }
        }
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
    reply.header('Content-Type', inline === '1' ? previewContentType(mime) : mime);
    if (inline !== '1') {
      reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(path.basename(rel))}"`);
    }
    return reply.send(buf);
  }
}
