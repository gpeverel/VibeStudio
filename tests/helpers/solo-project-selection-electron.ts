/** Настоящие production composition, renderer и preload. Подменён только ответ системного picker. */
import { app, BrowserWindow, ipcMain } from 'electron';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createProductionComposition } from '../../src/main/composition.ts';
import { createIpcHandlers, isTrustedIpcSource } from '../../src/main/ipc.ts';
import { SOLO_IPC_PREFIX } from '../../src/shared/app-api.ts';

const root = process.argv[2];
if (!root) throw new Error('Нужен собственный временный каталог.');
const profile = join(root, 'profile'); mkdirSync(profile);
app.setPath('userData', profile); app.setPath('sessionData', profile); app.setAppLogsPath(join(root, 'logs'));
const deadline = setTimeout(() => { console.error('Истекло время проверки выбора проекта.'); app.exit(1); }, 20_000);
let composition: Awaited<ReturnType<typeof createProductionComposition>> | undefined;
async function main() {
  try {
    const plain = join(root!, 'не репозиторий'), project = join(root!, 'Проект с пробелами');
    mkdirSync(plain); mkdirSync(project);
    const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
      { cwd: project, stdio: 'pipe', timeout: 10_000 });
    git('init', '-b', 'main');
    git('config', 'user.name', 'Selection UI Fixture'); git('config', 'user.email', 'selection@example.invalid');
    writeFileSync(join(project, 'README.md'), 'Собственный проект проверки выбора.\n');
    git('add', '.'); git('commit', '-m', 'fixture');
    await app.whenReady();
    composition = await createProductionComposition(join(root!, 'state'));
    const window = new BrowserWindow({ show: false, webPreferences: { preload: join(root!, 'preload.cjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: true } });
    const renderer = join(root!, 'renderer', 'index.html'), expectedUrl = pathToFileURL(renderer).href;
    const choices = [plain, project];
    const handlers = createIpcHandlers({ engine: composition.engine,
      selectProject: async () => choices.shift() ?? null,
      authorize: source => isTrustedIpcSource(source, { sender: window.webContents, mainFrame: window.webContents.mainFrame,
        url: expectedUrl, currentUrl: window.webContents.getURL() }) });
    for (const [name, handler] of Object.entries(handlers)) ipcMain.handle(`${SOLO_IPC_PREFIX}${name}`, (event, request: unknown) => handler(event, request));
    async function js<T = unknown>(code: string): Promise<T> { return window.webContents.executeJavaScript(code) as Promise<T>; }
    async function until(code: string) {
      const end = Date.now() + 5000;
      while (!await js<boolean>(code)) {
        if (Date.now() > end) throw new Error(`Не выполнено ${code}: ${await js('document.body.innerText')}`);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    const click = (label: string) => js(`(() => { const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}); if(!b||b.disabled)throw new Error('Кнопка недоступна');b.click(); })()`);
    await window.loadFile(renderer);
    await until("document.querySelector('#sessions-title')?.textContent === 'Сессии'");
    await click('Выбрать проект');
    await until("document.querySelector('[role=alert]')?.textContent.includes('not_git_repository')");
    assert.match(await js<string>("document.querySelector('[role=alert]').textContent"), /корневую папку Git-репозитория/);
    assert.equal(composition.engine.listProjects().length, 0);
    assert.equal(existsSync(join(plain, '.git')), false);
    await click('Выбрать проект');
    await until("document.querySelector('select')?.value !== '' && !document.querySelector('[role=alert]')");
    assert.equal(composition.engine.listProjects()[0]?.name, 'Проект с пробелами');
    await js("document.querySelector('input[type=checkbox]').click()");
    await click('Создать сессию');
    await until("document.body.innerText.includes('Можно отправить задачу')");
    assert.equal(composition.engine.listSessions().length, 1);
    const reloaded = once(window.webContents, 'did-finish-load');
    window.webContents.reload(); await reloaded;
    await until("document.body.innerText.includes('Можно отправить задачу')");
    assert.equal(composition.engine.listProjects().length, 1);
    await composition.engine.shutdown(); composition.close(); composition = undefined;
    window.destroy(); clearTimeout(deadline);
    console.log(JSON.stringify({ ok: true, projects: 1, sessions: 1, modelCliRuns: 0 })); app.exit(0);
  } catch (error) {
    console.error(error); clearTimeout(deadline);
    if (composition) { await composition.engine.shutdown(); composition.close(); }
    app.exit(1);
  }
}
void main();
