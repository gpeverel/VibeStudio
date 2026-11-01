/** Real UI/preload/SQLite/Git/engine with an explicitly synthetic agent. No installed model CLI is invoked. */
import { app, BrowserWindow, ipcMain } from 'electron';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { lstatSync, readdirSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { SOLO_EVENTS_CHANNEL, SOLO_IPC_PREFIX } from '../../src/shared/app-api.ts';
import { openEngineStand, until } from './p5-engine.ts';
import { createControlledAgent, success } from './p5-agent.ts';

const [bundleRoot, dataRoot] = process.argv.slice(2);
if (!bundleRoot || !dataRoot) throw new Error('Нужны собственные каталоги сборки и данных.');
app.setPath('userData', join(dataRoot, 'electron-profile')); app.setPath('sessionData', join(dataRoot, 'electron-profile'));
app.setAppLogsPath(join(dataRoot, 'electron-logs'));
const began = performance.now();
const deadline = setTimeout(() => { console.error('Baseline deadline'); app.exit(1); }, 30_000);
let window: BrowserWindow;
let stand: ReturnType<typeof openEngineStand> | undefined;
const samples: { phase: string; elapsedMs: number; rssKiB: number; cpuSeconds: number; processes: number }[] = [];
function seconds(value: string) { return value.split(':').reduce((total, part) => total * 60 + Number(part), 0); }
function sample(phase: string) {
  const ps = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,rss=,time='], { encoding: 'utf8', timeout: 3000 });
  if (ps.status !== 0) throw new Error('Не удалось измерить дерево процессов');
  const rows = ps.stdout.trim().split('\n').map(line => {
    const [pid, ppid, rss, time] = line.trim().split(/\s+/); return { pid: Number(pid), ppid: Number(ppid), rss: Number(rss), cpu: seconds(time!) };
  });
  const own = new Set([process.pid]); let changed = true;
  while (changed) { changed = false; for (const row of rows) if (row.pid !== ps.pid && own.has(row.ppid) && !own.has(row.pid)) { own.add(row.pid); changed = true; } }
  const included = rows.filter(row => own.has(row.pid));
  samples.push({ phase, elapsedMs: performance.now() - began, rssKiB: included.reduce((sum, row) => sum + row.rss, 0),
    cpuSeconds: included.reduce((sum, row) => sum + row.cpu, 0), processes: included.length });
}
function bytes(path: string): number {
  const stat = lstatSync(path); if (stat.isSymbolicLink()) return 0;
  return stat.isDirectory() ? readdirSync(path).reduce((sum, name) => sum + bytes(join(path, name)), 0) : stat.size;
}
const timings: Record<string, number> = {};
async function js<T = unknown>(code: string): Promise<T> { return window.webContents.executeJavaScript(code) as Promise<T>; }
async function uiUntil(code: string) {
  const end = Date.now() + 6000;
  while (!await js<boolean>(code)) { if (Date.now() > end) throw new Error(`UI: ${code}\n${await js('document.body.innerText')}`); await new Promise(resolve => setTimeout(resolve, 10)); }
}
function click(text: string) { return js(`(() => { const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}); if(!b||b.disabled)throw new Error('Недоступно: '+${JSON.stringify(text)});b.focus();b.click(); })()`); }
async function prompt(text: string) {
  await js(`(() => {const e=document.querySelector('#prompt');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await click('Отправить');
}
async function main() {
  let sampler: ReturnType<typeof setInterval> | undefined;
  try {
    await app.whenReady();
    const agent = createControlledAgent({ autoFinish: false });
    stand = openEngineStand(join(dataRoot!, 'data'), { agent }); await stand.engine.recover();
    window = new BrowserWindow({ width: 1000, height: 720, show: false,
      webPreferences: { preload: join(bundleRoot!, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    for (const [name, handler] of Object.entries(stand.ipc)) ipcMain.handle(`${SOLO_IPC_PREFIX}${name}`, (event, request: unknown) =>
      handler(event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame ? stand!.source : undefined, request));
    const unsubscribe = stand.engine.onEventsAvailable(notice => window.webContents.send(SOLO_EVENTS_CHANNEL, notice));
    let phase = 'startup'; sample(phase);
    sampler = setInterval(() => sample(phase), 50);
    await window.loadFile(join(bundleRoot!, 'renderer', 'index.html'));
    await uiUntil("document.querySelector('#sessions-title')?.textContent === 'Сессии'"); timings.startupToUiMs = performance.now() - began;
    phase = 'idle'; await new Promise(resolve => setTimeout(resolve, 250)); sample(phase);
    phase = 'project_selection';
    await click('Выбрать проект'); await uiUntil("document.querySelector('select')?.value !== ''");
    await js("document.querySelector('input[type=checkbox]').click()");
    let started = performance.now(); phase = 'workspace'; await click('Создать сессию');
    await uiUntil("document.body.innerText.includes('Можно отправить задачу')"); timings.workspaceMs = performance.now() - started;
    const sessionId = stand.engine.listSessions()[0]!.id;
    for (let index = 0; index < 2; index++) {
      phase = index === 0 ? 'first_turn' : 'resume'; started = performance.now();
      await prompt(index === 0 ? 'Первый синтетический ход' : 'Продолжение синтетического диалога');
      await until(() => agent.runs.length === index + 1); const acceptedAt = performance.now();
      await new Promise(resolve => setTimeout(resolve, 40));
      agent.runs[index]!.text(`Ответ ${index + 1}`); agent.runs[index]!.finish(success(`Ответ ${index + 1}`));
      await uiUntil(`document.body.innerText.includes('Ответ ${index + 1}') && document.body.innerText.includes('Ответ получен')`);
      timings[`${phase}Ms`] = performance.now() - started; timings[`${phase}AcceptanceMs`] = acceptedAt - started; sample(phase);
    }
    phase = 'stop'; await prompt('Ход для остановки'); await until(() => agent.runs.length === 3);
    await uiUntil("[...document.querySelectorAll('button')].some(b=>b.textContent==='Остановить'&&!b.disabled)");
    started = performance.now(); await click('Остановить'); await uiUntil("document.body.innerText.includes('Ход остановлен.')");
    timings.stopMs = performance.now() - started; await stand.engine.waitForIdle(); sample('after_stop');
    const recorded = stand.store.readEvents(sessionId, 0, 200).events;
    assert.equal(stand.store.getSession(sessionId)?.status, 'interrupted'); assert.equal(agent.runs.length, 3);
    phase = 'reload';
    window.webContents.reload(); await uiUntil("document.body.innerText.includes('Ответ 1') && document.body.innerText.includes('Ход остановлен.')");
    assert.equal(stand.store.readEvents(sessionId, 0, 200).events.length, recorded.length); sample('reloaded');
    clearInterval(sampler); unsubscribe();
    const dataBytes = bytes(join(dataRoot!, 'data')); const profileBytes = bytes(join(dataRoot!, 'electron-profile'));
    await stand.close(); window.destroy(); sample('window_closed');
    console.log(JSON.stringify({ scenario: 'real-electron-sqlite-solo-synthetic-agent', platform: process.platform, arch: process.arch,
      node: process.versions.node, electron: process.versions.electron, sqliteAbi: process.versions.modules,
      timings, samples, peakSampledRssKiB: Math.max(...samples.map(item => item.rssKiB)), dataBytes, profileBytes,
      events: recorded.length, agentRuns: agent.runs.length, modelCliRuns: 0, artificialAgentDelayMs: 40 }));
    clearTimeout(deadline); app.exit(0);
  } catch (error) { clearInterval(sampler); console.error(error); clearTimeout(deadline); app.exit(1); }
}
void main();
