import type { ApprovalKind } from '@apolla/protocol';

export interface DangerRule {
  pattern: RegExp;
  kind: ApprovalKind;
  reason: string;
}

/** 危险命令规则表（PRD 附录 A）。命中即强制审批，与权限模式无关。 */
export const DANGER_RULES: DangerRule[] = [
  { pattern: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(\/|~)/, kind: 'file_delete', reason: '递归删除绝对路径' },
  { pattern: /\brm\s+-[a-zA-Z]*[rf]/, kind: 'file_delete', reason: '递归/强制删除' },
  { pattern: /\bsudo\b/, kind: 'bash_command', reason: '提权执行' },
  { pattern: /\b(mkfs|fdisk|diskutil\s+erase)\b/, kind: 'bash_command', reason: '磁盘破坏性操作' },
  { pattern: /\bdd\b[^|]*\bof=/, kind: 'bash_command', reason: 'dd 写设备/文件' },
  { pattern: /chmod\s+(-[a-zA-Z]+\s+)?777\b/, kind: 'bash_command', reason: '开放全部权限' },
  { pattern: /\bgit\s+push\b/, kind: 'bash_command', reason: '向远端推送' },
  { pattern: /\b(npm|pnpm|yarn|pip3?|uv)\s+(install|add)\s+[^|]*(-g|--global)\b/, kind: 'bash_command', reason: '全局安装依赖' },
  { pattern: /\b(curl|wget)\b[^|]*\s(-d|--data|--data-binary|-F|--form|-T|--upload-file)\b/, kind: 'network_egress', reason: '向外部上传数据' },
  { pattern: /\b(shutdown|reboot|launchctl|systemctl)\b/, kind: 'bash_command', reason: '系统服务/电源操作' },
];

export function checkDanger(command: string): DangerRule | undefined {
  return DANGER_RULES.find((r) => r.pattern.test(command));
}

/** 普通出网命令检测（非上传类）：curl/wget GET 等，按域外审批策略处理 */
export function isNetworkCommand(command: string): boolean {
  return /\b(curl|wget|nc|telnet|ssh|scp|rsync\s+[^ ]*::)\b/.test(command);
}
