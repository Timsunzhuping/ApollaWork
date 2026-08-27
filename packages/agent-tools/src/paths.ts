import path from 'node:path';

/** 把用户/模型给的路径解析到工作区内；越界一律拒绝。 */
export function resolveSafe(workspaceDir: string, p: string): string {
  const abs = path.resolve(workspaceDir, p);
  const root = path.resolve(workspaceDir);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`路径越出工作区：${p}`);
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
