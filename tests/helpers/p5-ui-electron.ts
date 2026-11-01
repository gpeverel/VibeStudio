/** Independent browser acceptance. The transport is real Electron/preload; backend facts are explicit UI fixtures. */
import { app, BrowserWindow, ipcMain, nativeTheme, session as electronSession } from 'electron';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import type { AppApi } from '../../src/shared/app-api.ts';
import { SOLO_EVENTS_CHANNEL, SOLO_IPC_PREFIX } from '../../src/shared/app-api.ts';
import type { ApiResult, OperationKind, OperationView, SessionView, SoloEvent, SoloEventPayload } from '../../src/shared/solo.ts';
import { PENDING_COMMANDS_KEY } from '../../src/renderer/pending-commands.ts';

const rootArgument = process.argv[2]; if (!rootArgument) throw new Error('Нужен собственный каталог стенда.');
const root = rootArgument;
app.setPath('userData', join(root, 'electron-profile'));
app.setPath('sessionData', join(root, 'electron-profile'));
app.setAppLogsPath(join(root, 'electron-logs'));
const deadline = setTimeout(() => { console.error('UI acceptance deadline'); app.exit(1); }, 35_000);
const began = performance.now();
let window: BrowserWindow;
let view: SessionView | null = null;
const events: SoloEvent[] = [];
const operations = new Map<string, OperationView>();
const requests: string[] = [];
const creationRequests: string[] = [];
let creations = 0;
let effects = 0;
let confirmations = 0;
let revocations = 0;
const project = { id: 'project', name: 'Временный проект', setup: 'node setup.cjs', configVersion: 1 };
const malicious = '<img id="untrusted-image" src="https://outside.invalid/pixel" onerror="window.pwned=1"><script>window.pwned=2</script>';
const coverage = { profile: 'project-command-v1' as const, inputs: [{ path: 'setup.cjs', kind: 'file' as const, digest: 'a'.repeat(64) }],
  limitations: ['filesystem_race_after_capture' as const] };
const ok = <T>(value: T): ApiResult<T> => ({ ok: true, value });
function append(payload: SoloEventPayload, notify = true) {
  events.push({ id: randomUUID(), sessionId: 'session', seq: events.length + 1, timestamp: new Date().toISOString(), payload });
  if (notify) window.webContents.send(SOLO_EVENTS_CHANNEL, { sessionId: 'session', seq: events.length });
}
function operation(kind: OperationKind, request: { requestId: string }): OperationView {
  const existing = operations.get(request.requestId); if (existing) return existing;
  const value: OperationView = { id: randomUUID(), requestId: request.requestId, sessionId: 'session', kind, status: 'completed', error: null };
  operations.set(request.requestId, value); return value;
}
function ready() {
  view!.status = 'ready'; view!.setup.state = 'completed'; view!.setup.decision = { status: 'allowed', consentId: 'consent', fingerprint: 'a'.repeat(64), coverage };
  view!.actions = { send: true, stop: false, prepareSetup: false, newConversation: true, reason: null };
}
const handlers: Omit<AppApi, 'appName' | 'onEventsAvailable'> = {
  selectProject: async () => ok(project), listProjects: async () => ok([project]), listSessions: async () => ok(view ? [view] : []),
  getSession: async () => ok(view!),
  createSession: async request => {
    creationRequests.push(request.requestId);
    if (operations.has(request.requestId)) return ok(operations.get(request.requestId)!);
    assert.equal(await js(`JSON.parse(sessionStorage.getItem(${JSON.stringify(PENDING_COMMANDS_KEY)})).commands.some(item => item.method === 'createSession' && item.request.requestId === ${JSON.stringify(request.requestId)})`), true);
    creations++;
    view = { id: 'session', projectId: project.id, title: request.title ?? 'UI Solo', status: 'needs_consent', detail: 'Нужно решение на setup.',
      participant: { id: 'participant', cli: request.cli, profile: 'practical-local-v1', context: 'new' },
      workspace: { id: 'workspace', state: 'ready', branch: 'vs/ui' },
      setup: { state: 'needs_consent', command: project.setup, decision: { status: 'needs_consent', reason: 'not_granted', challengeId: 'challenge', fingerprint: 'a'.repeat(64), coverage }, completion: null,
        execution: { cwd: '/own-temporary-workspace', configVersion: 1, environmentNames: ['PATH'], permissions: { fileSystem: 'unrestricted', network: 'allowed', elevated: false } } },
      actions: { send: false, stop: false, prepareSetup: true, newConversation: false, reason: 'Нужно завершить подготовку.' },
      result: null, limitations: ['cli_configuration_not_audited'], updatedAt: new Date().toISOString() };
    append({ type: 'session_state', status: view.status, detail: view.detail });
    operation('create_session', request);
    throw new Error('Synthetic lost creation response after committed effect');
  },
  prepareSetup: async request => ok(operation('prepare_setup', request)),
  confirmSetup: async request => { assert.equal(request.challengeId, 'challenge'); confirmations++; ready(); append({ type: 'session_state', status: 'ready', detail: 'Setup завершён.' }); return ok(operation('confirm_setup', request)); },
  revokeConsent: async request => {
    assert.equal(request.consentId, 'consent'); revocations++;
    view!.setup.decision = { status: 'needs_consent', reason: 'not_granted', challengeId: 'after-revoke', fingerprint: 'a'.repeat(64), coverage };
    append({ type: 'diagnostic', code: 'consent_revoked', detail: 'Согласие отозвано.' }); return ok(operation('revoke_consent', request));
  },
  sendTurn: async request => {
    requests.push(request.requestId);
    if (operations.has(request.requestId)) return ok(operations.get(request.requestId)!);
    const result = operation('send_turn', request); effects++;
    append({ type: 'user_message', turnId: `turn-${effects}`, text: request.prompt, conversation: request.conversation });
    if (request.prompt === 'Ожидание') {
      view!.status = 'running'; view!.actions.send = false; view!.actions.stop = true;
      append({ type: 'session_state', status: 'running', detail: 'Ожидание Stop.' });
    } else {
      view!.status = 'answered'; view!.participant.context = 'available'; view!.actions.send = true;
      append({ type: 'agent', event: { schemaVersion: 1, eventId: randomUUID(), sessionId: 'session', participantId: 'participant', turnId: `turn-${effects}`,
        seq: 1, timestamp: new Date().toISOString(), type: 'text', messageId: 'answer', mode: 'snapshot', text: malicious } });
    }
    if (request.prompt === 'Повтор запроса' || request.prompt === 'Ожидание') throw new Error('Synthetic transport failure after accepted command');
    return ok(result);
  },
  stop: async request => {
    view!.status = 'interrupted'; view!.actions.stop = false; view!.actions.send = true;
    append({ type: 'session_state', status: 'interrupted', detail: 'Stop принят.' }); return ok(operation('stop', request));
  },
  readEvents: async request => {
    const rest = events.filter(event => event.seq > request.after);
    const page = rest.slice(0, request.limit);
    return ok({ events: page, nextCursor: page.at(-1)?.seq ?? request.after, hasMore: rest.length > page.length });
  },
};
async function js<T = unknown>(code: string): Promise<T> { return window.webContents.executeJavaScript(code) as Promise<T>; }
async function until(code: string) {
  const end = Date.now() + 6000;
  while (!await js<boolean>(code)) { if (Date.now() > end) throw new Error(`UI condition timed out: ${code}\n${await js('document.body.innerText')}`); await new Promise(resolve => setTimeout(resolve, 20)); }
}
function click(label: string) {
  return js(`(() => { const b = [...document.querySelectorAll('button')].find(e => e.textContent.trim() === ${JSON.stringify(label)}); if (!b || b.disabled) throw new Error('Action unavailable: '+${JSON.stringify(label)}); b.focus(); b.click(); })()`);
}
function prompt(text: string) {
  return js(`(() => {const e=document.querySelector('#prompt'); e.focus(); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e, ${JSON.stringify(text)}); e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
}
function enter() { window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' }); }

async function main() {
try {
  await app.whenReady();
  const externalRequests: string[] = [];
  electronSession.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { externalRequests.push(details.url); callback({ cancel: true }); });
  window = new BrowserWindow({ show: false, width: 1000, height: 720, webPreferences: { preload: join(root, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 2) console.error(`Renderer: ${message}`); });
  window.webContents.on('preload-error', (_event, _path, error) => console.error(error));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  for (const [method, handler] of Object.entries(handlers)) {
    ipcMain.handle(`${SOLO_IPC_PREFIX}${method}`, (event, request: unknown) => {
      assert.equal(event.sender, window.webContents); assert.equal(event.senderFrame, window.webContents.mainFrame);
      return (handler as (request: unknown) => Promise<unknown>)(request);
    });
  }
  await window.loadFile(join(root, 'renderer', 'index.html'));
  await until("document.querySelector('#sessions-title')?.textContent === 'Сессии'");
  const readyMs = performance.now() - began;
  assert.equal(await js("typeof window.require + '/' + typeof window.process"), 'undefined/undefined');
  await until("document.querySelector('select')?.value === 'project'");
  await js("document.querySelector('input[type=checkbox]').click()");
  await js(`(() => { const original=Storage.prototype.setItem; Storage.prototype.setItem=function(key,value) { if(key===${JSON.stringify(PENDING_COMMANDS_KEY)})throw new DOMException('Quota exceeded','QuotaExceededError'); return original.call(this,key,value); }; window.restorePendingStorage=()=>{Storage.prototype.setItem=original;}; })()`);
  await click('Создать сессию'); await until("document.body.innerText.includes('Запрос не отправлен.')");
  assert.equal(creations, 0); assert.equal(creationRequests.length, 0);
  await js('window.restorePendingStorage()');
  await click('Создать сессию'); await until("[...document.querySelectorAll('button')].some(b=>b.textContent==='Повторить тот же запрос'&&!b.disabled)");
  assert.equal(creations, 1);
  window.webContents.reload(); await until("document.body.innerText.includes('Исход прежнего запроса неизвестен')");
  assert.equal(creationRequests.length, 1); // No automatic replay after reload.
  await js("document.querySelector('input[type=checkbox]').click()");
  assert.equal(await js("[...document.querySelectorAll('button')].find(b=>b.textContent==='Создать сессию').disabled"), true);
  await click('Повторить тот же запрос'); await until("!document.body.innerText.includes('Повторить тот же запрос') && document.body.innerText.includes('Подтвердить эту подготовку')");
  assert.equal(creations, 1); assert.equal(creationRequests.length, 2); assert.equal(creationRequests[0], creationRequests[1]);
  assert.equal(await js(`sessionStorage.getItem(${JSON.stringify(PENDING_COMMANDS_KEY)})`), null);
  assert.equal(await js("[...document.querySelectorAll('button')].find(b=>b.textContent==='Отправить').disabled"), true);
  assert.equal(await js("document.body.innerText.includes('Не ограничен песочницей') && document.body.innerText.includes('/own-temporary-workspace') && document.body.innerText.includes('PATH')"), true);
  await click('Подтвердить эту подготовку'); await until("document.body.innerText.includes('Можно отправить задачу')");
  await until("document.activeElement?.id === 'prompt'");
  // A restored completed setup may have a new invalidated challenge, but cannot be executed twice.
  view!.setup.decision = { status: 'needs_consent', reason: 'invalidated', challengeId: 'after-restart', fingerprint: 'b'.repeat(64), coverage };
  window.webContents.reload(); await until("document.body.innerText.includes('Подготовка уже выполнена')");
  assert.equal(await js("[...document.querySelectorAll('button')].some(b=>b.textContent==='Подтвердить эту подготовку')"), false);
  assert.equal(confirmations, 1);
  ready(); append({ type: 'diagnostic', code: 'consent_rechecked', detail: 'Неизменное согласие после проверки.' });
  await until("[...document.querySelectorAll('button')].some(b=>b.textContent==='Отозвать согласие')");
  await click('Отозвать согласие'); await until("document.body.innerText.includes('Подготовка уже выполнена')");
  assert.equal(revocations, 1); assert.equal(confirmations, 1);
  assert.equal(await js("[...document.querySelectorAll('button')].some(b=>b.textContent==='Подтвердить эту подготовку')"), false);
  await prompt('Первый вопрос');
  await js("document.querySelector('#prompt').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,isComposing:true}))");
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(effects, 0);
  await js("document.querySelector('#prompt').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',shiftKey:true,bubbles:true}))");
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(effects, 0);
  enter(); await until("document.querySelector('.event-text') && document.body.innerText.includes('untrusted-image')");
  assert.equal(effects, 1); assert.equal(await js("document.querySelector('#untrusted-image') === null && window.pwned === undefined"), true);
  assert.equal(externalRequests.length, 0);
  await prompt('Ожидание'); enter(); await until("[...document.querySelectorAll('button')].some(b=>b.textContent==='Остановить'&&!b.disabled)");
  await click('Остановить'); await until("document.body.innerText.includes('Stop принят.')");
  await until("document.activeElement?.id === 'prompt'");
  assert.equal(await js(`JSON.parse(sessionStorage.getItem(${JSON.stringify(PENDING_COMMANDS_KEY)})).commands.map(item=>item.method).join(',')`), 'sendTurn');
  await click('Повторить тот же запрос'); await until("!document.body.innerText.includes('Повторить тот же запрос')");
  assert.equal(effects, 2); assert.equal(requests.at(-1), requests.at(-2));
  await prompt('Повтор запроса'); enter(); await until("[...document.querySelectorAll('button')].some(b=>b.textContent==='Повторить тот же запрос'&&!b.disabled)");
  assert.equal(await js("[...document.querySelectorAll('button')].find(b=>b.textContent==='Отправить').disabled"), true);
  const beforeRetry = effects, sentBeforeReload = requests.length;
  window.webContents.reload(); await until("document.body.innerText.includes('Исход прежнего запроса неизвестен')");
  assert.equal(requests.length, sentBeforeReload);
  await click('Повторить тот же запрос');
  await until("!document.body.innerText.includes('Повторить тот же запрос')");
  assert.equal(effects, beforeRetry); assert.equal(requests.at(-1), requests.at(-2));
  view!.participant.context = 'missing'; view!.actions.send = false; view!.actions.newConversation = true;
  append({ type: 'recovery', code: 'history_missing', detail: 'История CLI потеряна.' });
  await until("document.body.innerText.includes('Начать новый диалог без прежнего контекста CLI')");
  await prompt('Новый контекст');
  await js("[...document.querySelectorAll('label')].find(e=>e.textContent.includes('Начать новый диалог без прежнего контекста CLI')).querySelector('input').click()");
  await click('Начать новый диалог'); await until("document.body.innerText.includes('Вы · новый диалог')");
  for (let i = 0; i < 405; i++) append({ type: 'diagnostic', code: `batch-${i}`, detail: `Строка ${i}` }, false);
  // No notification: periodic catch-up must recover the committed pages.
  await until("document.body.innerText.includes('Строка 404')");
  assert.equal(await js("document.body.innerText.includes('Сообщение на границе страницы может быть неполным')"), true);
  assert.ok(await js<number>("document.querySelectorAll('.feed-entry').length") <= 300);
  await click('История с начала'); await until("document.querySelector('#conversation-heading')?.textContent === 'История сессии'");
  assert.equal(await js("document.body.innerText.includes('Сообщение на границе страницы может быть неполным')"), true);
  assert.equal(await js("document.body.innerText.includes('Первый вопрос')"), true);
  await click('Следующая страница'); await until("document.body.innerText.includes('Строка 150')");
  await click('К последним событиям');
  const count = events.length;
  window.webContents.reload(); await until("document.body.innerText.includes('Строка 404')");
  assert.equal(events.length, count); assert.equal(effects, 4);
  nativeTheme.themeSource = 'dark'; await until("getComputedStyle(document.documentElement).getPropertyValue('--color-bg').trim()==='#151514'");
  nativeTheme.themeSource = 'light'; await until("getComputedStyle(document.documentElement).getPropertyValue('--color-bg').trim()==='#fafaf9'");
  window.webContents.debugger.attach('1.3');
  await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  assert.equal(await js("getComputedStyle(document.documentElement).getPropertyValue('--duration-base').trim()"), '0ms');
  // Hidden acceptance windows have no OS focus; emulate an active page before checking keyboard focus styling.
  await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  window.setSize(640, 480); window.webContents.setZoomFactor(2);
  await js("document.querySelector('#prompt').focus()");
  assert.equal(await js("document.activeElement?.id"), 'prompt');
  assert.ok(await js<number>("document.querySelector('#prompt').getBoundingClientRect().width") > 0);
  assert.notEqual(await js("getComputedStyle(document.querySelector('#prompt')).outlineStyle"), 'none');
  window.webContents.debugger.detach();
  console.log(JSON.stringify({ ok: true, scenario: 'ui-fixture-real-preload', readyMs, effects, events: count,
    processes: app.getAppMetrics().map(metric => ({ type: metric.type, workingSetKiB: metric.memory.workingSetSize, cpu: metric.cpu.percentCPUUsage })),
    mainResourceUsage: process.resourceUsage() }));
  window.destroy(); clearTimeout(deadline); app.exit(0);
} catch (error) { console.error(error); clearTimeout(deadline); app.exit(1); }
}
void main();
