import path from 'node:path';
import fs from 'node:fs';

/**
 * 把用户/模型给的路径解析到工作区内；越界一律拒绝。
 * 两道检查：
 *  1) 词法检查（path.resolve + 前缀）——挡住 ../ 与绝对路径；
 *  2) 真实路径检查（realpath 最近存在的祖先）——挡住软链接穿透（安全红队 RT 缺口修复）。
 * 对尚不存在的目标（如 Write 新文件），检查其最近存在的父目录的 realpath。
 */
export function resolveSafe(workspaceDir: string, p: string): string {
  const lexRoot = path.resolve(workspaceDir);
  const abs = path.resolve(lexRoot, p);
  if (abs !== lexRoot && !abs.startsWith(lexRoot + path.sep)) {
    throw new Error(`路径越出工作区：${p}`);
  }
  // realpath 校验：根与「最近存在的祖先」的真实路径都必须仍在工作区内
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(lexRoot);
  } catch {
    return abs; // 工作区尚未创建（调用方随后会建）——退化为词法结果
  }
  let probe = abs;
  while (probe !== lexRoot && !fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  try {
    const realProbe = fs.realpathSync(probe);
    if (realProbe !== realRoot && !realProbe.startsWith(realRoot + path.sep)) {
      throw new Error(`路径经软链接越出工作区：${p}`);
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes('软链接')) throw e;
    // realpath 失败（competition/权限）——保守拒绝
    throw new Error(`路径无法安全解析：${p}`);
  }
  return abs;
}

export function toRel(workspaceDir: string, abs: string): string {
  return path.relative(path.resolve(workspaceDir), abs) || '.';
}

const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.csv': 'text/csv',
  '.md': 'text/markdown',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

export function mimeOf(p: string): string {
  return MIME[path.extname(p).toLowerCase()] ?? 'application/octet-stream';
}

const BINARY_EXT = new Set([
  '.pdf', '.docx', '.xlsx', '.pptx', '.doc', '.xls', '.ppt', '.zip', '.tar', '.gz',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp4', '.mp3', '.wav', '.woff', '.woff2', '.so', '.node',
]);

export function looksBinaryByExt(p: string): boolean {
  return BINARY_EXT.has(path.extname(p).toLowerCase());
}
