/**
 * 设置窗口 preload —— 暴露一个最小的设置读写桥（走 IPC，不开放 Node）。
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('apollaSettings', {
  /** 读取当前设置 */
  get: () => ipcRenderer.invoke('apolla:get-settings'),
  /** 保存设置；restart=true 时主进程会重启本地服务使之生效 */
  save: (values: Record<string, string>, restart: boolean) =>
    ipcRenderer.invoke('apolla:save-settings', values, restart),
});
