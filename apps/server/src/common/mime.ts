import path from 'node:path';

const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.csv': 'text/csv',
  '.md': 'text/markdown',
  '.html': 'text/html',
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

/**
 * 预览（inline=1）时实际下发的 Content-Type。
 * 浏览器不会内联渲染 text/csv、application/json 这类：拿到就当附件下载，
 * 预览 iframe 于是一片空白。这里统一改按 text/plain 送出（内容一字不改），
 * 下载路径仍用 mimeOf 的真实类型，保证文件名与打开方式正确。
 */
const INLINE_AS_TEXT = new Set([
  'text/csv',
  'text/markdown',
  'application/json',
  'application/xml',
]);

export function previewContentType(mime: string): string {
  return INLINE_AS_TEXT.has(mime) ? 'text/plain; charset=utf-8' : mime;
}
