import fs from 'node:fs';
import path from 'node:path';
import { SETTINGS_KEYS, type ModelSettings } from './types.js';

/** settings.json 的绝对路径。 */
export function settingsPath(userDataDir: string): string {
  return path.join(userDataDir, 'settings.json');
}

/** 只保留白名单键，丢弃其它字段。 */
function pick(obj: Record<string, unknown>): ModelSettings {
  const out: ModelSettings = {};
  for (const k of SETTINGS_KEYS) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) out[k] = v;
  }
  return out;
}

/** 读取设置；文件缺失或损坏时返回 {}。 */
export function loadSettings(userDataDir: string): ModelSettings {
  const p = settingsPath(userDataDir);
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return pick(parsed as Record<string, unknown>);
  } catch {
    /* 缺失/非法 → 视为空设置 */
  }
  return {};
}

/** 合并写入设置（仅白名单键），返回合并后的完整设置。 */
export function saveSettings(userDataDir: string, partial: ModelSettings): ModelSettings {
  fs.mkdirSync(userDataDir, { recursive: true });
  const merged = { ...loadSettings(userDataDir), ...pick(partial as Record<string, unknown>) };
  fs.writeFileSync(settingsPath(userDataDir), JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}
