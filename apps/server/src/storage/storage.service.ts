import { Inject, Injectable } from '@nestjs/common';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG, type AppConfig } from '../config.js';

/**
 * 工作区文件存储。开发用 fs 驱动（本地目录）；生产 S3/MinIO 驱动实现同一接口。
 * 每个工作区独立目录：{storageDir}/workspaces/{workspaceId}/
 */
@Injectable()
export class StorageService {
  constructor(@Inject(CONFIG) private config: AppConfig) {
    fs.mkdirSync(this.root(), { recursive: true });
  }

  private root() {
    return path.join(this.config.storageDir, 'workspaces');
  }

  workspaceDir(workspaceId: string): string {
    const dir = path.join(this.root(), workspaceId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private safe(workspaceId: string, rel: string): string {
    const base = this.workspaceDir(workspaceId);
    const abs = path.resolve(base, rel);
    if (abs !== base && !abs.startsWith(base + path.sep)) throw new Error('路径越界');
    return abs;
  }

  writeFile(workspaceId: string, rel: string, data: Buffer | string) {
    const abs = this.safe(workspaceId, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, data);
    return fs.statSync(abs).size;
  }

  readFile(workspaceId: string, rel: string): Buffer {
    return fs.readFileSync(this.safe(workspaceId, rel));
  }

  exists(workspaceId: string, rel: string): boolean {
    try {
      return fs.existsSync(this.safe(workspaceId, rel));
    } catch {
      return false;
    }
  }

  stat(workspaceId: string, rel: string) {
    return fs.statSync(this.safe(workspaceId, rel));
  }

  /** 列出工作区所有文件（相对路径），跳过隐藏与内部目录 */
  list(workspaceId: string): { path: string; size: number }[] {
    const base = this.workspaceDir(workspaceId);
    const out: { path: string; size: number }[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) walk(abs);
        else out.push({ path: path.relative(base, abs), size: fs.statSync(abs).size });
      }
    };
    walk(base);
    return out;
  }

  absPath(workspaceId: string, rel: string): string {
    return this.safe(workspaceId, rel);
  }
}
