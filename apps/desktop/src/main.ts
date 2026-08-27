/**
 * Apolla Work 桌面客户端 —— Electron 主进程。
 *
 * 职责：拉起内嵌的 apolla server 子进程（本地执行模式：local 执行器 + SQLite + 本地文件存储），
 * 等待其健康后用 BrowserWindow 加载 http://127.0.0.1:<port>（server 已托管 web 静态资源）。
 *
 * 纯逻辑（端口探测 / 环境组装 / 就绪轮询 / 建库 / 编排）全部抽到 ./lib，便于无显示环境下单测；
 * 本文件只负责 Electron 特有的窗口、菜单、IPC 与生命周期。
 */
import path from 'node:path';
import fs from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { app, BrowserWindow, Menu, ipcMain, shell, type MenuItemConstructorOptions } from 'electron';
import {
  resolvePaths,
  loadSettings,
  saveSettings,
  launchLocalServer,
  type ResolvedPaths,
  type ModelSettings,
} from './lib/index.js';
import { dataUrl, loadingPage, errorPage, missingBuildPage, settingsPage } from './ui/pages.js';

const APP_TITLE = 'Apolla Work';
const START_PORT = 3001;

let mainWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let serverChild: ChildProcess | null = null;
let paths: ResolvedPaths;
let starting = false;
let quitting = false;
/** 主动停止 server（重启/退出）时置位，避免误报「服务已停止」。 */
let intentionalStop = false;

const userDataDir = () => app.getPath('userData');
const preloadPath = (name: string) => path.join(__dirname, name);

/** 校验必要构建产物是否就位；返回缺失项的可读描述。 */
function checkBuildArtifacts(p: ResolvedPaths): string[] {
  const missing: string[] = [];
  if (!fs.existsSync(p.serverMain)) missing.push(`${p.serverMain}（server 未构建，缺 dist/main.js）`);
  if (!fs.existsSync(path.join(p.webDist, 'index.html'))) missing.push(`${path.join(p.webDist, 'index.html')}（web 未构建）`);
  return missing;
}

/** 把内部日志映射成加载页上给用户看的阶段文案。 */
function stageMessage(log: string): string | null {
  if (log.includes('创建数据库结构') || log.includes('prisma db push')) return '首次启动：正在初始化本地数据库…';
  if (log.includes('种子') || log.includes('seed')) return '正在写入初始数据…';
  if (log.includes('拉起 server')) return '正在启动本地服务…';
  if (log.includes('选定空闲端口')) return '正在准备本地服务…';
  return null;
}

function killServer(): void {
  if (serverChild && !serverChild.killed) {
    try {
      serverChild.kill();
    } catch {
      /* ignore */
    }
  }
  serverChild = null;
}

/** 完整启动本地服务并把主窗口切到 server 页面；出错则在窗口内展示错误。 */
async function startLocalServer(win: BrowserWindow): Promise<void> {
  if (starting) return;
  starting = true;
  intentionalStop = false;
  try {
    const missing = checkBuildArtifacts(paths);
    if (missing.length) {
      await win.loadURL(dataUrl(missingBuildPage(missing)));
      return;
    }

    await win.loadURL(dataUrl(loadingPage()));

    let lastStage = '';
    const result = await launchLocalServer({
      userDataDir: userDataDir(),
      paths,
      settings: loadSettings(userDataDir()),
      startPort: START_PORT,
      onLog: (m) => {
        console.log(m);
        const stage = stageMessage(m);
        if (stage && stage !== lastStage && !win.isDestroyed()) {
          lastStage = stage;
          void win.loadURL(dataUrl(loadingPage(stage))).catch(() => undefined);
        }
      },
    });

    serverChild = result.child;
    result.child.once('exit', (code, signal) => {
      serverChild = null;
      if (quitting || intentionalStop) return;
      if (mainWindow && !mainWindow.isDestroyed()) {
        void mainWindow
          .loadURL(dataUrl(errorPage('本地服务已停止', `进程退出：code=${code ?? '?'} signal=${signal ?? '-'}`)))
          .catch(() => undefined);
      }
    });

    if (!win.isDestroyed()) await win.loadURL(result.baseUrl);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('本地服务启动失败：', msg);
    if (!win.isDestroyed()) await win.loadURL(dataUrl(errorPage('无法启动本地服务', msg)));
  } finally {
    starting = false;
  }
}

async function restartLocalServer(): Promise<void> {
  intentionalStop = true;
  killServer();
  if (mainWindow && !mainWindow.isDestroyed()) await startLocalServer(mainWindow);
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: APP_TITLE,
    backgroundColor: '#0d1117',
    show: false,
    webPreferences: {
      preload: preloadPath('preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [`--apolla-version=${app.getVersion()}`],
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  // 固定窗口标题，不被页面 <title> 覆盖
  mainWindow.on('page-title-updated', (e) => {
    e.preventDefault();
    mainWindow?.setTitle(APP_TITLE);
  });
  // 外部 http(s) 链接交给系统浏览器，不在应用内开新窗口
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
}

function openSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 640,
    height: 660,
    title: '设置 · Apolla Work',
    parent: mainWindow ?? undefined,
    resizable: false,
    minimizable: false,
    maximizable: false,
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: preloadPath('preload-settings.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  settingsWindow.setMenuBarVisibility(false);
  void settingsWindow.loadURL(dataUrl(settingsPage()));
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

function registerIpc(): void {
  ipcMain.handle('apolla:get-settings', () => loadSettings(userDataDir()));
  ipcMain.handle('apolla:save-settings', async (_e, values: ModelSettings, restart: boolean) => {
    const merged = saveSettings(userDataDir(), values ?? {});
    if (restart) await restartLocalServer();
    return merged;
  });
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin';

  const appMenu: MenuItemConstructorOptions = {
    label: APP_TITLE,
    submenu: [
      { role: 'about', label: '关于 Apolla Work' },
      { type: 'separator' },
      { label: '设置…', accelerator: 'CmdOrCtrl+,', click: () => openSettingsWindow() },
      { label: '重启本地服务', click: () => void restartLocalServer() },
      { type: 'separator' },
      ...(isMac
        ? ([
            { role: 'services', label: '服务' },
            { type: 'separator' },
            { role: 'hide', label: '隐藏 Apolla Work' },
            { role: 'hideOthers', label: '隐藏其他' },
            { role: 'unhide', label: '全部显示' },
            { type: 'separator' },
          ] as MenuItemConstructorOptions[])
        : []),
      { role: 'quit', label: '退出' },
    ],
  };

  const editMenu: MenuItemConstructorOptions = {
    label: '编辑',
    submenu: [
      { role: 'undo', label: '撤销' },
      { role: 'redo', label: '重做' },
      { type: 'separator' },
      { role: 'cut', label: '剪切' },
      { role: 'copy', label: '复制' },
      { role: 'paste', label: '粘贴' },
      { role: 'selectAll', label: '全选' },
    ],
  };

  const viewMenu: MenuItemConstructorOptions = {
    label: '视图',
    submenu: [
      { role: 'reload', label: '重新加载' },
      { role: 'forceReload', label: '强制重新加载' },
      { role: 'toggleDevTools', label: '切换开发者工具' },
      { type: 'separator' },
      { role: 'resetZoom', label: '实际大小' },
      { role: 'zoomIn', label: '放大' },
      { role: 'zoomOut', label: '缩小' },
      { type: 'separator' },
      { role: 'togglefullscreen', label: '全屏' },
    ],
  };

  const windowMenu: MenuItemConstructorOptions = {
    label: '窗口',
    submenu: [
      { role: 'minimize', label: '最小化' },
      ...(isMac
        ? ([
            { role: 'zoom', label: '缩放' },
            { type: 'separator' },
            { role: 'front', label: '前置全部窗口' },
          ] as MenuItemConstructorOptions[])
        : ([{ role: 'close', label: '关闭' }] as MenuItemConstructorOptions[])),
    ],
  };

  Menu.setApplicationMenu(Menu.buildFromTemplate([appMenu, editMenu, viewMenu, windowMenu]));
}

// —— 生命周期 ——
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.setAboutPanelOptions({
    applicationName: APP_TITLE,
    applicationVersion: app.getVersion(),
    copyright: '企业 AI 智能体平台 · 本地执行模式',
  });

  void app.whenReady().then(async () => {
    paths = resolvePaths({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      desktopDistDir: __dirname,
    });
    buildMenu();
    registerIpc();
    createMainWindow();
    if (mainWindow) await startLocalServer(mainWindow);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
        if (mainWindow) void startLocalServer(mainWindow);
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    quitting = true;
    intentionalStop = true;
    killServer();
  });
}
