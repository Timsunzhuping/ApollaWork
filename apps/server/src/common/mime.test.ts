import { describe, it, expect } from 'vitest';
import { mimeOf, previewContentType } from './mime.js';

describe('mime', () => {
  it('按扩展名给出类型，未知回落 octet-stream', () => {
    expect(mimeOf('a/b/report.pdf')).toBe('application/pdf');
    expect(mimeOf('数据.csv')).toBe('text/csv');
    expect(mimeOf('noext')).toBe('application/octet-stream');
  });

  it('★ 预览时 csv/json/md 按 text/plain 下发 —— 否则 iframe 空白', () => {
    // 回归：浏览器对 text/csv 一律当附件下载，产物预览区因此长期一片空白。
    expect(previewContentType('text/csv')).toBe('text/plain; charset=utf-8');
    expect(previewContentType('application/json')).toBe('text/plain; charset=utf-8');
    expect(previewContentType('text/markdown')).toBe('text/plain; charset=utf-8');
  });

  it('可内联渲染的类型不改写（图片/PDF/HTML/纯文本）', () => {
    for (const m of ['application/pdf', 'image/png', 'text/html', 'text/plain', 'image/svg+xml']) {
      expect(previewContentType(m)).toBe(m);
    }
  });
});
