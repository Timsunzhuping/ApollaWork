import type { ApprovalKind } from '@apolla/protocol';

export interface DangerRule {
  /** 稳定标识：策略中心用它记录「某内置规则被禁用」 */
  key: string;
  pattern: RegExp;
  kind: ApprovalKind;
  reason: string;
}

/** 可跨进程传输的规则（策略中心下发给沙箱容器用） */
export interface SerializedRule {
  key: string;
  pattern: string;
  flags: string;
  kind: ApprovalKind;
  reason: string;
}

/** 危险命令规则表（PRD 附录 A）。命中即强制审批，与权限模式无关。 */
export const DANGER_RULES: DangerRule[] = [
  { key: 'rm-recursive-abs', pattern: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(\/|~)/, kind: 'file_delete', reason: '递归删除绝对路径' },
  { key: 'rm-recursive', pattern: /\brm\s+-[a-zA-Z]*[rf]/, kind: 'file_delete', reason: '递归/强制删除' },
  { key: 'sudo', pattern: /\bsudo\b/, kind: 'bash_command', reason: '提权执行' },
  { key: 'disk-destroy', pattern: /\b(mkfs|fdisk|diskutil\s+erase)\b/, kind: 'bash_command', reason: '磁盘破坏性操作' },
  { key: 'dd-write', pattern: /\bdd\b[^|]*\bof=/, kind: 'bash_command', reason: 'dd 写设备/文件' },
  { key: 'chmod-777', pattern: /chmod\s+(-[a-zA-Z]+\s+)?777\b/, kind: 'bash_command', reason: '开放全部权限' },
  { key: 'git-push', pattern: /\bgit\s+push\b/, kind: 'bash_command', reason: '向远端推送' },
  { key: 'global-install', pattern: /\b(npm|pnpm|yarn|pip3?|uv)\s+(install|add)\s+[^|]*(-g|--global)\b/, kind: 'bash_command', reason: '全局安装依赖' },
  { key: 'curl-upload', pattern: /\b(curl|wget)\b[^|]*\s(-d|--data|--data-binary|-F|--form|-T|--upload-file)\b/, kind: 'network_egress', reason: '向外部上传数据' },
  { key: 'system-power', pattern: /\b(shutdown|reboot|launchctl|systemctl)\b/, kind: 'bash_command', reason: '系统服务/电源操作' },
  // fork bomb（经典 :(){ :|:& };: 及其变体）——防耗尽宿主 PID/内存（安全红队缺口修复）
  { key: 'fork-bomb', pattern: /\(\s*\)\s*\{[^}]*\|[^}]*&[^}]*\}\s*;/, kind: 'bash_command', reason: 'fork bomb' },
  { key: 'fork-bomb-2', pattern: /:\s*\(\s*\)\s*\{\s*:/, kind: 'bash_command', reason: 'fork bomb' },
  // 创建软链接——可能被用于穿透工作区边界，需审批（配合 resolveSafe 的 realpath 校验）
  { key: 'symlink', pattern: /\bln\s+-s\b/, kind: 'file_overwrite', reason: '创建软链接' },
  // wget 上传数据
  { key: 'wget-upload', pattern: /\bwget\b[^|]*--post-(file|data)\b/, kind: 'network_egress', reason: 'wget 向外上传数据' },
];

/** 命中即需审批。rules 缺省为内置规则；策略中心可下发裁剪/追加后的集合（T-413） */
export function checkDanger(command: string, rules: DangerRule[] = DANGER_RULES): DangerRule | undefined {
  return rules.find((r) => r.pattern.test(command));
}

export function serializeRules(rules: DangerRule[]): SerializedRule[] {
  return rules.map((r) => ({ key: r.key, pattern: r.pattern.source, flags: r.pattern.flags, kind: r.kind, reason: r.reason }));
}

/** 把下发的规则编译回 RegExp；编译失败的单条跳过并告警，不让一条坏规则拖垮全部审批 */
export function compileRules(rules: SerializedRule[], onError?: (r: SerializedRule, e: Error) => void): DangerRule[] {
  const out: DangerRule[] = [];
  for (const r of rules) {
    try {
      out.push({ key: r.key, pattern: new RegExp(r.pattern, r.flags), kind: r.kind, reason: r.reason });
    } catch (e) {
      onError?.(r, e as Error);
    }
  }
  return out;
}

/** 普通出网命令检测（非上传类）：curl/wget GET 等，按域外审批策略处理 */
/**
 * 命令里是否出现常见联网工具 —— 只用于「提示用户审批」的体验，**不是安全边界**：
 * 真正的出网控制在容器层（NetworkMode none）与 server 侧出网策略（T-402）。
 */
export function isNetworkCommand(command: string): boolean {
  return /\b(curl|wget|nc|telnet|ssh|scp|rsync\s+[^ ]*::)\b/.test(command);
}
