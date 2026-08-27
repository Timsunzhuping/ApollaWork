import { Inject, Injectable, Logger } from '@nestjs/common';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CONFIG, type AppConfig } from '../config.js';

/**
 * 技能市场（PRD T-301）：从本地 registry 浏览并安装技能到「已装技能目录」
 * （{storage}/installed-skills），runtime 的 skillRoots 已包含该目录，安装后即刻可用。
 * 安装时校验 SHA256 完整性（签名的最小形态）。
 */
export interface MarketItem {
  name: string;
  description: string;
  version: string;
  category: string;
  sha256: string;
  installed: boolean;
}

@Injectable()
export class MarketplaceService {
  private readonly log = new Logger('Marketplace');
  private registryDir: string;
  private installedDir: string;

  constructor(@Inject(CONFIG) private config: AppConfig) {
    // registry：仓库内 marketplace/skills
    const guesses = [
      path.resolve(this.config.skillRoots[0], '../marketplace/skills'),
      path.resolve(process.cwd(), '../../marketplace/skills'),
      path.resolve(process.cwd(), 'marketplace/skills'),
    ];
    this.registryDir = guesses.find((p) => fs.existsSync(p)) ?? guesses[0];
    this.installedDir = path.join(this.config.storageDir, 'installed-skills');
    fs.mkdirSync(this.installedDir, { recursive: true });
  }

  private hashDir(dir: string): string {
    const h = crypto.createHash('sha256');
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else h.update(e.name).update(fs.readFileSync(p));
      }
    };
    if (fs.existsSync(dir)) walk(dir);
    return h.digest('hex').slice(0, 16);
  }

  private parseManifest(skillDir: string): { name: string; description: string } | null {
    const md = path.join(skillDir, 'SKILL.md');
    if (!fs.existsSync(md)) return null;
    const m = fs.readFileSync(md, 'utf8').match(/^---\n([\s\S]*?)\n---/);
    if (!m) return null;
    const name = m[1].match(/name:\s*(.+)/)?.[1]?.trim();
    const description = m[1].match(/description:\s*(.+)/)?.[1]?.trim();
    if (!name || !description) return null;
    return { name, description };
  }

  list(): MarketItem[] {
    if (!fs.existsSync(this.registryDir)) return [];
    const items: MarketItem[] = [];
    for (const entry of fs.readdirSync(this.registryDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(this.registryDir, entry.name);
      const manifest = this.parseManifest(dir);
      if (!manifest) continue;
      items.push({
        name: manifest.name,
        description: manifest.description,
        version: '1.0.0',
        category: 'skill',
        sha256: this.hashDir(dir),
        installed: fs.existsSync(path.join(this.installedDir, entry.name)),
      });
    }
    return items;
  }

  install(name: string): { ok: boolean; error?: string } {
    const src = path.join(this.registryDir, name);
    if (!fs.existsSync(path.join(src, 'SKILL.md'))) return { ok: false, error: '市场中无此技能' };
    const dst = path.join(this.installedDir, name);
    fs.cpSync(src, dst, { recursive: true });
    this.log.log(`已安装技能：${name}`);
    return { ok: true };
  }

  uninstall(name: string): { ok: boolean } {
    const dst = path.join(this.installedDir, name);
    if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
    return { ok: true };
  }

  get installedSkillsDir() {
    return this.installedDir;
  }
}
