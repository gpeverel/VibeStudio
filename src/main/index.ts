import { app, BrowserWindow, session } from 'electron';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const smoke = process.argv.includes('--smoke-test');
const smokeProfile = smoke ? mkdtempSync(join(tmpdir(), 'vibestudio-smoke-')) : undefined;
if (smokeProfile) {
  app.setPath('userData', smokeProfile);
  app.setPath('sessionData', smokeProfile);
  app.setAppLogsPath(join(smokeProfile, 'logs'));
}

let mainWindow: BrowserWindow | undefined;
let smokeTimeout: ReturnType<typeof setTimeout> | undefined;

function finishSmoke(code: number): void {
  clearTimeout(smokeTimeout);
  mainWindow?.destroy();
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
    await window.loadURL(url.href);
  } else {
    await window.loadFile(fileURLToPath(new URL('../renderer/index.html', import.meta.url)));
  }

  if (smoke) {
    // Проверяется React, собранный HTML и реальный sandboxed preload, без IPC-команд.
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
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
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
  else app.exit(1);
});

app.on('window-all-closed', () => {
  if (!smoke && process.platform !== 'darwin') app.quit();
});
