import fs from 'node:fs';
import path from 'node:path';

export interface SkillManifest {
  name: string;
  description: string;
  dir: string;
  body: string; // SKILL.md 正文（frontmatter 之后）
  allowedTools?: string[];
}

/** 极简 frontmatter 解析（YAML 子集：key: value） */
function parseFrontmatter(md: string): { meta: Record<string, string>; body: string } {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: md };
  const meta: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return { meta, body: m[2] };
}

/** 扫描技能目录（PRD 附录 C）。每个子目录含 SKILL.md。 */
export function loadSkills(...roots: string[]): SkillManifest[] {
  const skills: SkillManifest[] = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillMd = path.join(root, entry.name, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;
      const { meta, body } = parseFrontmatter(fs.readFileSync(skillMd, 'utf8'));
      if (!meta.name || !meta.description) continue;
      skills.push({
        name: meta.name,
        description: meta.description,
        dir: path.join(root, entry.name),
        body,
        allowedTools: meta['allowed-tools']?.split(',').map((s) => s.trim()).filter(Boolean),
      });
    }
  }
  return skills;
}

export function findSkill(skills: SkillManifest[], name: string): SkillManifest | undefined {
  return skills.find((s) => s.name === name);
}
