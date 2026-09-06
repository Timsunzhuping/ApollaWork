import path from 'node:path';

/**
 * 上传治理（T-404）：扩展名白名单 + 魔数校验 + 可执行/宏文档拦截。
 * 任意文件进工作区都会被 Agent 打开、解析、执行脚本处理 —— 这里是第一道门。
 * 病毒扫描（ClamAV）是第二道，见 clamav.ts。
 */

export const DEFAULT_ALLOWED_EXT = [
  // 办公文档
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf',
  // 数据 / 文本
  'csv', 'tsv', 'txt', 'md', 'json', 'xml', 'yaml', 'yml', 'html', 'htm', 'log',
  // 图片
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'tif', 'tiff',
  // 压缩包（内部文件由 Agent 解压后再受同样规则约束）
  'zip',
];

/** 含宏的 Office 文档：默认拒绝（UPLOAD_ALLOW_MACROS=1 放行） */
export const MACRO_EXT = ['docm', 'xlsm', 'pptm', 'dotm', 'xltm', 'potm'];

/** 无论白名单怎么配都拒绝的可执行 / 脚本 / 安装包扩展名 */
export const ALWAYS_DENY_EXT = [
  'exe', 'dll', 'msi', 'com', 'scr', 'pif', 'bat', 'cmd', 'ps1', 'vbs', 'vbe', 'wsf', 'hta',
  'sh', 'bash', 'zsh', 'app', 'dmg', 'pkg', 'jar', 'apk', 'deb', 'rpm', 'so', 'dylib', 'iso',
];

export interface UploadPolicy {
  allowedExt: Set<string>;
  allowMacros: boolean;
}

export function loadUploadPolicy(env: NodeJS.ProcessEnv = process.env): UploadPolicy {
  const custom = (env.UPLOAD_ALLOWED_EXT ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/^\./, ''))
    .filter(Boolean);
  return {
    allowedExt: new Set(custom.length ? custom : DEFAULT_ALLOWED_EXT),
    allowMacros: env.UPLOAD_ALLOW_MACROS === '1',
  };
}

export interface UploadVerdict {
  ok: boolean;
  reason?: string;
}

const deny = (reason: string): UploadVerdict => ({ ok: false, reason });

/** 魔数识别：返回一组「这些扩展名与文件头相符」的候选；识别不出返回 null */
export function sniffKind(head: Buffer): { kinds: string[]; executable: boolean } | null {
  const b = head;
  const startsWith = (sig: number[], offset = 0) => sig.every((v, i) => b[offset + i] === v);
  // 可执行文件：Windows PE、ELF、Mach-O（含 fat）、Java class
  if (startsWith([0x4d, 0x5a])) return { kinds: [], executable: true };
  if (startsWith([0x7f, 0x45, 0x4c, 0x46])) return { kinds: [], executable: true };
  if (startsWith([0xcf, 0xfa, 0xed, 0xfe]) || startsWith([0xce, 0xfa, 0xed, 0xfe]) || startsWith([0xca, 0xfe, 0xba, 0xbe]))
    return { kinds: [], executable: true };
  if (startsWith([0x25, 0x50, 0x44, 0x46])) return { kinds: ['pdf'], executable: false }; // %PDF
  if (startsWith([0x50, 0x4b, 0x03, 0x04]) || startsWith([0x50, 0x4b, 0x05, 0x06]))
    return { kinds: ['zip', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'docm', 'xlsm', 'pptm', 'dotm', 'xltm', 'potm'], executable: false };
  if (startsWith([0xd0, 0xcf, 0x11, 0xe0])) return { kinds: ['doc', 'xls', 'ppt'], executable: false }; // OLE2
  if (startsWith([0x89, 0x50, 0x4e, 0x47])) return { kinds: ['png'], executable: false };
  if (startsWith([0xff, 0xd8, 0xff])) return { kinds: ['jpg', 'jpeg'], executable: false };
  if (startsWith([0x47, 0x49, 0x46, 0x38])) return { kinds: ['gif'], executable: false };
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && b.subarray(8, 12).toString('ascii') === 'WEBP')
    return { kinds: ['webp'], executable: false };
  if (startsWith([0x42, 0x4d])) return { kinds: ['bmp'], executable: false };
  if (startsWith([0x49, 0x49, 0x2a, 0x00]) || startsWith([0x4d, 0x4d, 0x00, 0x2a])) return { kinds: ['tif', 'tiff'], executable: false };
  if (startsWith([0x7b, 0x5c, 0x72, 0x74, 0x66])) return { kinds: ['rtf'], executable: false }; // {\rtf
  return null;
}

/** 文本类判定：前 8KB 无 NUL 字节即视为文本 */
export function looksLikeText(head: Buffer): boolean {
  const n = Math.min(head.length, 8192);
  for (let i = 0; i < n; i++) if (head[i] === 0) return false;
  return true;
}

const TEXT_EXT = new Set(['csv', 'tsv', 'txt', 'md', 'json', 'xml', 'yaml', 'yml', 'html', 'htm', 'log', 'svg', 'rtf']);

/**
 * 判定一个上传文件是否放行。
 * 顺序：可执行魔数 → 永远拒绝的扩展名 → 宏文档 → 白名单 → 魔数与扩展名是否相符 →
 * 文本类必须像文本（防 .csv 里塞二进制）。
 */
export function checkUpload(filename: string, head: Buffer, policy: UploadPolicy): UploadVerdict {
  const ext = path.extname(filename).slice(1).toLowerCase();
  const sniff = sniffKind(head);
  if (sniff?.executable) return deny('文件头是可执行程序（PE/ELF/Mach-O），不接受');
  if (!ext) return deny('文件没有扩展名，无法判定类型');
  if (ALWAYS_DENY_EXT.includes(ext)) return deny(`不接受可执行/脚本/安装包类型 .${ext}`);
  const isMacro = MACRO_EXT.includes(ext);
  if (isMacro && !policy.allowMacros) return deny(`含宏的 Office 文档 .${ext} 默认拒绝（UPLOAD_ALLOW_MACROS=1 可放行）`);
  if (!isMacro && !policy.allowedExt.has(ext)) return deny(`.${ext} 不在允许上传的类型内`);
  if (sniff && !sniff.kinds.includes(ext)) return deny(`文件内容与扩展名 .${ext} 不符（实际像 ${sniff.kinds[0] ?? '其他二进制'}）`);
  if (!sniff && TEXT_EXT.has(ext) && !looksLikeText(head)) return deny(`.${ext} 应为文本文件，但内容是二进制`);
  return { ok: true };
}
