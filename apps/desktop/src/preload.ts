/**
 * 主窗口 preload —— 最小 contextBridge。
 * 仅暴露只读信息，不开放任何 Node 能力。
 * 配合 contextIsolation:true / nodeIntegration:false / sandbox:true。
 */
import { contextBridge } from 'electron';

function argValue(prefix: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

contextBridge.exposeInMainWorld('apolla', {
  /** 桌面应用版本（由主进程通过 additionalArguments 注入） */
  version: argValue('--apolla-version=') ?? '0.0.0',
  /** 运行平台 */
  platform: process.platform,
  /** 运行时版本（只读，便于问题排查） */
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
});
