import { app, BrowserWindow, dialog, ipcMain, session } from 'electron';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProductionComposition } from './composition.ts';
import { createIpcHandlers, isTrustedIpcSource } from './ipc.ts';
import { SOLO_EVENTS_CHANNEL, SOLO_IPC_PREFIX } from '../shared/app-api.ts';

const smoke = process.argv.includes('--smoke-test');
const smokeProfile = smoke ? mkdtempSync(join(tmpdir(), 'vibestudio-smoke-')) : undefined;
if (smokeProfile) {
  app.setPath('userData', smokeProfile);
  app.setPath('sessionData', smokeProfile);
  app.setAppLogsPath(join(smokeProfile, 'logs'));
}

let mainWindow: BrowserWindow | undefined;
let smokeTimeout: ReturnType<typeof setTimeout> | undefined;
let composition: Awaited<ReturnType<typeof createProductionComposition>> | undefined;
let trustedRendererUrl = '';
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
let closing = false;
const ownsData = app.requestSingleInstanceLock();
if (!ownsData) app.quit();
app.on('second-instance', () => { mainWindow?.show(); mainWindow?.focus(); });

function finishSmoke(code: number): void {
  clearTimeout(smokeTimeout);
  clearTimeout(noticeTimer);
  mainWindow?.destroy();
  composition?.close();
  if (smokeProfile) rmSync(smokeProfile, { recursive: true, force: true });
  app.exit(code);
}

async function createWindow(): Promise<void> {
  const window = new BrowserWindow({
    title: 'VibeStudio',
    width: 1000,
    height: 720,
    minWidth: 640,
    minHeight: 480,
    show: false,
    webPreferences: {
      preload: fileURLToPath(new URL('../preload/index.cjs', import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow = window;
  window.on('closed', () => { mainWindow = undefined; });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (!smoke && !app.isPackaged && devUrl) {
    const url = new URL(devUrl);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      throw new Error('Dev renderer должен загружаться с локального HTTP-сервера.');
    }
    trustedRendererUrl = url.href;
    await window.loadURL(trustedRendererUrl);
  } else {
    trustedRendererUrl = new URL('../renderer/index.html', import.meta.url).href;
    await window.loadFile(fileURLToPath(new URL('../renderer/index.html', import.meta.url)));
  }

  if (smoke) {
    // Проверяется React, настоящий SQLite/read IPC и sandboxed preload; CLI не запускаются.
    const loaded: unknown = await window.webContents.executeJavaScript(
      `new Promise((resolve) => {
        const deadline = Date.now() + 3000;
        const check = () => {
          if (document.querySelector('#sessions-title')?.textContent === 'Сессии') {
            resolve(document.title === 'VibeStudio' && window.api?.appName === 'VibeStudio'
              && typeof window.require === 'undefined' && typeof window.process === 'undefined');
          } else if (Date.now() >= deadline) resolve(false);
          else setTimeout(check, 25);
        };
        check();
      })`,
    );
    if (loaded !== true) throw new Error('Проверка окна или preload не пройдена.');
    const state: unknown = await window.webContents.executeJavaScript(
      `Promise.all([window.api.listProjects(), window.api.listSessions()]).then(results =>
        results.every(result => result.ok === true && Array.isArray(result.value) && result.value.length === 0))`,
    );
    if (state !== true) throw new Error('Проверка SQLite и доверенного IPC не пройдена.');
    console.log('Проверка окна Electron и preload пройдена.');
    finishSmoke(0);
  } else {
    window.show();
  }
}

if (smoke) {
  smokeTimeout = setTimeout(() => {
    console.error('Проверка запуска Electron превысила 15 секунд.');
    finishSmoke(1);
  }, 15_000);
}

app.whenReady().then(async () => {
  if (!ownsData) return;
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  composition = await createProductionComposition(app.getPath('userData'));
  const handlers = createIpcHandlers({ engine: composition.engine,
    authorize(source) {
      if (!source || typeof source !== 'object' || !mainWindow || mainWindow.isDestroyed()) return false;
      return isTrustedIpcSource(source, { sender: mainWindow.webContents, mainFrame: mainWindow.webContents.mainFrame,
        url: trustedRendererUrl, currentUrl: mainWindow.webContents.getURL() });
    },
    async selectProject() {
      if (!mainWindow) return null;
      const selected = await dialog.showOpenDialog(mainWindow, { title: 'Выбрать Git-проект', properties: ['openDirectory'] });
      return selected.canceled ? null : selected.filePaths[0] ?? null;
    },
  });
  for (const [name, handler] of Object.entries(handlers)) ipcMain.handle(`${SOLO_IPC_PREFIX}${name}`,
    (event, payload: unknown) => handler(event, payload));
  const notices = new Map<string, number>();
  composition.engine.onEventsAvailable(({ sessionId, seq }) => {
    notices.set(sessionId, seq);
    noticeTimer ??= setTimeout(() => {
      noticeTimer = undefined;
      if (mainWindow && !mainWindow.isDestroyed()) for (const [sessionId, seq] of notices) {
        mainWindow.webContents.send(SOLO_EVENTS_CHANNEL, { sessionId, seq });
      }
      notices.clear();
    }, 25);
  });
  await createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow().catch((error: unknown) => {
        console.error(error);
        app.exit(1);
      });
    }
  });
}).catch((error: unknown) => {
  console.error(error);
  if (smoke) finishSmoke(1);
  else {
    dialog.showErrorBox('VibeStudio не удалось запустить', 'Состояние приложения не открыто. Более новая или повреждённая БД не изменяется. Подробности доступны в диагностике запуска.');
    composition?.close(); app.exit(1);
  }
});

app.on('before-quit', event => {
  if (closing || smoke || !composition) return;
  event.preventDefault(); closing = true;
  clearTimeout(noticeTimer);
  void composition.engine.shutdown().finally(() => { composition?.close(); app.quit(); });
});

app.on('window-all-closed', () => {
  if (!smoke && process.platform !== 'darwin') app.quit();
});
