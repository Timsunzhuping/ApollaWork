import { describe, expect, it } from 'vitest';
import { checkUpload, loadUploadPolicy, looksLikeText, sniffKind } from './upload-policy.js';

/** 上传治理（T-404）：白名单 + 魔数 + 可执行/宏拦截 */
const policy = loadUploadPolicy({});
const pdf = Buffer.from('%PDF-1.7\n%âãÏÓ\n');
const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pe = Buffer.from('MZ\x90\x00\x03\x00\x00\x00', 'binary');
const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]);
const text = Buffer.from('quarter,budget\nQ1,120\n');

describe('checkUpload', () => {
  it('常见办公/数据/图片类型放行', () => {
    expect(checkUpload('report.pdf', pdf, policy).ok).toBe(true);
    expect(checkUpload('budget.xlsx', zip, policy).ok).toBe(true);
    expect(checkUpload('deck.pptx', zip, policy).ok).toBe(true);
    expect(checkUpload('data.csv', text, policy).ok).toBe(true);
    expect(checkUpload('logo.PNG', png, policy).ok).toBe(true);
  });

  it('★ 可执行文件头无论叫什么名字都拒绝', () => {
    expect(checkUpload('report.pdf', pe, policy)).toMatchObject({ ok: false, reason: expect.stringContaining('可执行') });
    expect(checkUpload('data.csv', elf, policy).ok).toBe(false);
  });

  it('★ 脚本/安装包扩展名永远拒绝（即使写进白名单）', () => {
    const permissive = loadUploadPolicy({ UPLOAD_ALLOWED_EXT: 'sh,exe,csv' });
    expect(checkUpload('run.sh', Buffer.from('#!/bin/bash\n'), permissive).ok).toBe(false);
    expect(checkUpload('setup.exe', Buffer.from('xx'), permissive).ok).toBe(false);
    expect(checkUpload('ok.csv', text, permissive).ok).toBe(true);
  });

  it('★ 含宏 Office 文档默认拒绝，UPLOAD_ALLOW_MACROS=1 放行', () => {
    expect(checkUpload('macro.xlsm', zip, policy).ok).toBe(false);
    expect(checkUpload('macro.xlsm', zip, loadUploadPolicy({ UPLOAD_ALLOW_MACROS: '1' })).ok).toBe(true);
  });

  it('★ 内容与扩展名不符拒绝（.pdf 里装的是 zip）', () => {
    const v = checkUpload('report.pdf', zip, policy);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('不符');
  });

  it('文本类扩展名塞二进制拒绝', () => {
    expect(checkUpload('data.csv', Buffer.from([0x00, 0x01, 0x02, 0x00]), policy).ok).toBe(false);
  });

  it('白名单外扩展名拒绝；无扩展名拒绝；自定义白名单生效', () => {
    expect(checkUpload('model.bin', Buffer.from('abc'), policy).ok).toBe(false);
    expect(checkUpload('README', text, policy).ok).toBe(false);
    const only = loadUploadPolicy({ UPLOAD_ALLOWED_EXT: '.pdf' });
    expect(checkUpload('a.pdf', pdf, only).ok).toBe(true);
    expect(checkUpload('a.csv', text, only).ok).toBe(false);
  });
});

describe('sniffKind / looksLikeText', () => {
  it('识别 PDF / ZIP 族 / PNG / PE / ELF', () => {
    expect(sniffKind(pdf)?.kinds).toEqual(['pdf']);
    expect(sniffKind(zip)?.kinds).toContain('docx');
    expect(sniffKind(png)?.kinds).toEqual(['png']);
    expect(sniffKind(pe)?.executable).toBe(true);
    expect(sniffKind(elf)?.executable).toBe(true);
    expect(sniffKind(text)).toBeNull();
  });
  it('文本判定：含 NUL 即非文本', () => {
    expect(looksLikeText(text)).toBe(true);
    expect(looksLikeText(Buffer.from([0x61, 0x00, 0x62]))).toBe(false);
  });
});
