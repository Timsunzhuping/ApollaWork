import fs from 'node:fs';
import path from 'node:path';
import type { StorageDriver, StoredObject } from './driver.js';

/** 本地文件系统驱动：单机部署 / 开发默认。执行目录即持久目录，无需搬运。 */
export class FsDriver implements StorageDriver {
  readonly kind = 'fs' as const;
  constructor(private root: string) {
    fs.mkdirSync(root, { recursive: true });
  }

  private dir(workspaceId: string) {
    const d = path.join(this.root, workspaceId);
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  private safe(workspaceId: string, rel: string) {
    const base = this.dir(workspaceId);
    const abs = path.resolve(base, rel);
    if (abs !== base && !abs.startsWith(base + path.sep)) throw new Error('路径越界');
    return abs;
  }

  async list(workspaceId: string): Promise<StoredObject[]> {
    const base = this.dir(workspaceId);
    const out: StoredObject[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const abs = path.join(d, e.name);
        if (e.isDirectory()) walk(abs);
        else out.push({ path: path.relative(base, abs), size: fs.statSync(abs).size });
      }
    };
    walk(base);
    return out;
  }

  async read(workspaceId: string, rel: string) {
    return fs.readFileSync(this.safe(workspaceId, rel));
  }

  async write(workspaceId: string, rel: string, data: Buffer) {
    const abs = this.safe(workspaceId, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, data);
    return data.length;
  }

  async exists(workspaceId: string, rel: string) {
    try {
      return fs.existsSync(this.safe(workspaceId, rel));
    } catch {
      return false;
    }
  }

  async remove(workspaceId: string, rel: string) {
    const abs = this.safe(workspaceId, rel);
    if (fs.existsSync(abs)) fs.rmSync(abs, { recursive: true, force: true });
  }

  async materialize(workspaceId: string) {
    return this.dir(workspaceId); // 零拷贝
  }

  async persist() {
    /* no-op：执行目录即持久目录 */
  }

  absPath(workspaceId: string, rel: string) {
    return this.safe(workspaceId, rel);
  }
}
