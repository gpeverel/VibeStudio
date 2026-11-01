import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { test as base, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

const exec = promisify(execFile);
const require = createRequire(import.meta.url);

interface Desktop {
  app: ElectronApplication;
  page: Page;
  projectPath: string;
}

async function deadline<T>(operation: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

export const test = base.extend<{ desktop: Desktop }>({
  desktop: async ({ playwright }, use, testInfo) => {
    const { _electron } = playwright;
    const temporaryParent = resolve('.tmp');
    await mkdir(temporaryParent, { recursive: true });
    const root = await mkdtemp(join(temporaryParent, 'vibestudio-e2e-'));
    const projectPath = join(root, 'project');
    const profile = join(root, 'profile');
    const errors: string[] = [];
    let application: ElectronApplication | undefined;
    let closed: Promise<void> | undefined;
    let closing = false;
    let output = '';
    let pid: number | undefined;
    let processClosed = false;
    try {
      await mkdir(projectPath);
      // Только собственный репозиторий, без пользовательских шаблонов и настроек Git.
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && !key.startsWith('GIT_')
            && key !== 'ELECTRON_RUN_AS_NODE' && key !== 'ELECTRON_RENDERER_URL') env[key] = value;
      }
      env.GIT_CONFIG_NOSYSTEM = '1';
      env.GIT_CONFIG_GLOBAL = '/dev/null';
      env.VIBESTUDIO_E2E_ROOT = root;
      // Playwright задаёт FORCE_COLOR для своих процессов; не передаём конфликт с NO_COLOR в приложение.
      if (env.NO_COLOR !== undefined) delete env.FORCE_COLOR;
      const git = (...args: string[]) => exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
        { cwd: projectPath, env, timeout: 10_000 });
      await git('init', '--template=', '-b', 'main');
      await git('config', 'user.name', 'E2E Fixture');
      await git('config', 'user.email', 'e2e@example.invalid');
      await writeFile(join(projectPath, 'README.md'), 'Временный проект проверки экрана «Сессии».\n');
      await git('add', 'README.md');
      await git('commit', '-m', 'fixture');
      expect((await git('remote')).stdout.trim()).toBe('');

      application = await _electron.launch({
        args: [resolve('tests/e2e/electron-main.mjs')],
        cwd: resolve('.'), env, timeout: 15_000,
        chromiumSandbox: true,
      });
      const child = application.process();
      pid = child.pid;
      closed = new Promise<void>(resolveClosed => {
        child.once('close', (code, signal) => {
          processClosed = true;
          if (!closing || code !== 0 || signal !== null) errors.push(`main завершился: code=${code}, signal=${signal}, closing=${closing}`);
          resolveClosed();
        });
      });
      const capture = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-64 * 1024); };
      child.stdout?.on('data', capture);
      child.stderr?.on('data', capture);
      application.on('close', () => { if (!closing) errors.push('Electron закрылся до завершения сценария.'); });
      application.on('console', message => { if (message.type() === 'error') errors.push(`main console: ${message.text()}`); });
      // weberror собирает pageerror всех страниц, в том числе во время первой загрузки.
      application.context().on('weberror', event => errors.push(`pageerror: ${event.error().stack ?? event.error().message}`));
      application.on('window', page => {
        page.on('crash', () => errors.push('renderer завершился аварийно.'));
      });

      expect(await application.evaluate(({ app }) => ({ userData: app.getPath('userData'), sessionData: app.getPath('sessionData') })))
        .toEqual({ userData: profile, sessionData: profile });
      expect(await application.evaluate(() => process.versions.electron))
        .toBe((require('electron/package.json') as { version: string }).version);
      // Подписки установлены до импорта настоящего собранного main и создания окна.
      await application.evaluate(({ app }) => { app.emit('vibestudio:e2e:start'); });
      const page = await application.firstWindow();
      await expect(page.getByRole('heading', { name: 'Сессии', exact: true })).toBeVisible();
      expect(existsSync(join(profile, 'vibestudio.sqlite')), 'Создана настоящая SQLite в отдельном профиле').toBe(true);
      await use({ app: application, page, projectPath });
    } finally {
      closing = true;
      if (application) {
        try { await deadline(application.close(), 10_000, 'Electron не закрылся за 10 секунд.'); }
        catch (error) {
          errors.push(String(error));
          const child = application.process();
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }
        if (closed) {
          try { await deadline(closed, 5000, 'Не подтверждено завершение процесса Electron.'); }
          catch (error) { errors.push(String(error)); }
        }
      }
      const diagnosticsPath = join(root, 'runtime-errors.jsonl');
      if (existsSync(diagnosticsPath)) errors.push(await readFile(diagnosticsPath, 'utf8'));
      if (output) await testInfo.attach('electron-output', { body: output, contentType: 'text/plain' });
      // При неподтверждённом завершении сохраняем каталог для диагностики и проваливаем тест.
      if (!application || processClosed) await rm(root, { recursive: true, force: true });
      const removed = !existsSync(root);
      await testInfo.attach('cleanup', {
        body: JSON.stringify({ root, pid, processClosed, removed, errors }, null, 2), contentType: 'application/json',
      });
      expect(removed, 'Временный профиль, SQLite и Git-проект удалены целиком').toBe(true);
      expect(errors, 'Неожиданные ошибки Electron, preload или страницы').toEqual([]);
    }
  },
});

export { expect };
