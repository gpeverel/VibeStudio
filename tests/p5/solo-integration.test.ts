import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { openEngineStand, must, until } from '../helpers/p5-engine.ts';
import { createControlledAgent, success } from '../helpers/p5-agent.ts';
import { createCursorFeed } from '../../src/renderer/feed.ts';
import type { SoloEvent } from '../../src/shared/solo.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup(options: Parameters<typeof openEngineStand>[1] = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vs-p5-engine-')));
  const stand = openEngineStand(root, options);
  cleanups.push(async () => { await stand.close(); rmSync(root, { recursive: true, force: true }); });
  await stand.engine.recover(); return stand;
}
const turn = (sessionId: string, requestId = randomUUID()) => ({ requestId, sessionId, prompt: 'Прочитай проект', conversation: 'continue' as const });

describe('P5: реальные SQLite, engine и IPC-контракты', () => {
  it.each(['claude', 'codex'] as const)('проходит создание, ответ и следующий ход с закреплённым %s', async cli => {
    const s = await setup(), session = await s.create(cli);
    const request = turn(session.id);
    const operation = must(await s.ipc.sendTurn(s.source, request)); await s.engine.waitForIdle();
    expect(must(await s.ipc.getSession(s.source, { sessionId: session.id }))).toMatchObject({ status: 'answered', participant: { cli, context: 'available' } });
    const duplicate = must(await s.ipc.sendTurn(s.source, request)); expect(duplicate.id).toBe(operation.id);
    expect(s.agent.runs).toHaveLength(1);
    must(await s.ipc.sendTurn(s.source, turn(session.id))); await s.engine.waitForIdle();
    expect(s.agent.runs).toHaveLength(2);
    expect(s.agent.runs[1]?.input.participant.agentSessionId).toBe(s.store.getSessionParticipant(session.id)?.agentSessionId);
    expect(s.agent.runs[0]?.input.participant.cli).toBe(cli);
    expect(s.store.listTurns(session.id).map(item => item.seq)).toEqual([1, 2]);
  });
  it('конкурентный повтор requestId запускает один ход, другое содержимое конфликтует', async () => {
    const s = await setup(), session = await s.create(), request = turn(session.id);
    const [a, b] = await Promise.all([s.ipc.sendTurn(s.source, request), s.ipc.sendTurn(s.source, request)]);
    expect(must(a).id).toBe(must(b).id); await s.engine.waitForIdle(); expect(s.agent.runs).toHaveLength(1);
    expect(await s.ipc.sendTurn(s.source, { ...request, prompt: 'Другая задача' })).toMatchObject({ ok: false, error: { code: 'request_conflict' } });
    expect(s.agent.runs).toHaveLength(1);
  });
  it('уведомляет только после commit, а новый UI восстанавливает ту же ленту по курсору', async () => {
    const s = await setup(), session = await s.create();
    const observations: number[] = [], invalidNotifications: number[] = [];
    const unsubscribe = s.engine.onEventsAvailable(notice => {
      const page = s.store.readEvents(notice.sessionId, notice.seq - 1, 1);
      if (page.events[0]?.seq !== notice.seq) invalidNotifications.push(notice.seq);
      observations.push(notice.seq);
    });
    must(await s.ipc.sendTurn(s.source, turn(session.id))); await s.engine.waitForIdle(); unsubscribe();
    expect(observations.length).toBeGreaterThan(2);
    expect(invalidNotifications).toEqual([]);
    let rendered: readonly SoloEvent[] = [];
    const feed = createCursorFeed<SoloEvent>({ read: async after => must(await s.ipc.readEvents(s.source, { sessionId: session.id, after, limit: 2 })),
      changed: page => { rendered = page.events; }, failed: error => { throw error; } });
    await feed.refresh();
    const all = s.store.readEvents(session.id, 0, 200).events;
    expect(rendered).toEqual(all); await feed.refresh(); expect(rendered).toEqual(all);
    expect(new Set(rendered.map(event => event.id)).size).toBe(rendered.length);
    expect(s.agent.runs).toHaveLength(1);
  });
  it('отказывает поддельному источнику, чужим ID и разрешающим полям до эффекта', async () => {
    const s = await setup(), session = await s.create();
    expect(await s.ipc.sendTurn({ ownWindow: 'forged' }, turn(session.id))).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
    for (const extra of [{ approved: true }, { cwd: s.projectPath }, { workspaceId: session.workspace.id }, { profile: 'full-access' }]) {
      expect(await s.ipc.sendTurn(s.source, { ...turn(session.id), ...extra })).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    }
    expect(await s.ipc.sendTurn(s.source, turn('foreign-session'))).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(await s.ipc.createSession(s.source, { requestId: randomUUID(), projectId: session.projectId, cli: 'unsupported' })).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(s.agent.runs).toHaveLength(0);
  });
  it('потеря CLI-истории запрещает продолжение, новый диалог требует явного выбора', async () => {
    const s = await setup(), session = await s.create();
    must(await s.ipc.sendTurn(s.source, turn(session.id))); await s.engine.waitForIdle();
    s.agent.setHistory('missing');
    must(await s.ipc.sendTurn(s.source, turn(session.id))); await s.engine.waitForIdle();
    expect(s.agent.runs).toHaveLength(1); expect(s.store.getSessionParticipant(session.id)?.context).toBe('missing');
    expect(await s.ipc.sendTurn(s.source, turn(session.id))).toMatchObject({ ok: false, error: { code: 'history_missing' } });
    must(await s.ipc.sendTurn(s.source, { ...turn(session.id), conversation: 'new' })); await s.engine.waitForIdle();
    expect(s.agent.runs).toHaveLength(2); expect(s.agent.runs[1]?.input.participant.agentSessionId).toBeNull();
  });
  it('ошибка диагностического журнала не удаляет SQLite-историю и показывается отдельно', async () => {
    const s = await setup({ journal: { append: async () => { throw new Error('synthetic disk full'); } } }), session = await s.create();
    must(await s.ipc.sendTurn(s.source, turn(session.id))); await s.engine.waitForIdle();
    expect(s.store.getSession(session.id)?.status).toBe('answered');
    expect(s.store.readEvents(session.id, 0, 200).events.some(event => event.payload.type === 'diagnostic' && event.payload.code === 'journal_failed')).toBe(true);
  });
  it.each(['normal', 'late_success', 'unconfirmed', 'hang'] as const)('Stop %s конечен; повтор не создаёт эффектов', async stop => {
    const agent = createControlledAgent({ autoFinish: false, stop });
    const s = await setup({ agent }), session = await s.create();
    must(await s.ipc.sendTurn(s.source, turn(session.id))); await until(() => agent.runs.length === 1);
    const request = { requestId: randomUUID(), sessionId: session.id };
    const first = must(await s.ipc.stop(s.source, request));
    const again = must(await s.ipc.stop(s.source, request)); expect(again.id).toBe(first.id);
    const expected = stop === 'unconfirmed' || stop === 'hang' ? 'recovery_required' : 'interrupted';
    await until(() => s.store.getSession(session.id)?.status === expected);
    expect(agent.runs[0]?.interruptCount).toBe(1);
    const result = s.store.listTurns(session.id)[0]?.result;
    expect(result).toMatchObject({ kind: 'interrupted', stopAccepted: true });
    if (expected === 'recovery_required') {
      expect(await s.ipc.sendTurn(s.source, turn(session.id))).toMatchObject({ ok: false, error: { code: 'recovery_required' } });
      agent.runs[0]!.finish(success('Поздний результат')); await s.engine.waitForIdle();
      expect(s.store.getSession(session.id)?.status).toBe('recovery_required');
    }
  });
  it('ошибка SQLite откатывает state+event, блокирует эффект и останавливает уже активный ход', async () => {
    let broken = false;
    const agent = createControlledAgent({ autoFinish: false });
    const s = await setup({ agent, storage: { faultInjector: (point, context) => {
      if (broken && point === 'before_commit' && context.eventTypes.includes('agent')) throw new Error('synthetic SQLITE_FULL');
    } } }), session = await s.create();
    must(await s.ipc.sendTurn(s.source, turn(session.id))); await until(() => agent.runs.length === 1);
    await until(() => s.store.readEvents(session.id, 0, 200).events.some(event => event.payload.type === 'agent'));
    const before = s.store.readEvents(session.id, 0, 200).events;
    broken = true; agent.runs[0]!.text('Не должно попасть в БД');
    await until(() => s.store.failed);
    await until(() => agent.runs[0]!.interruptCount > 0);
    expect(s.store.readEvents(session.id, 0, 200).events).toEqual(before);
    expect(await s.ipc.sendTurn(s.source, turn(session.id))).toMatchObject({ ok: false, error: { code: 'store_failed' } });
    expect(agent.runs).toHaveLength(1);
  });

  it('согласованный setup исполняет ровно одну собственную команду до первого хода', async () => {
    const s = await setup({ setup: true }), session = await s.create();
    const decision = session.setup.decision;
    if (decision?.status !== 'needs_consent') throw new Error(JSON.stringify(decision));
    const request = { requestId: randomUUID(), sessionId: session.id, challengeId: decision.challengeId };
    const first = must(await s.ipc.confirmSetup(s.source, request));
    expect(must(await s.ipc.confirmSetup(s.source, request)).id).toBe(first.id);
    await s.engine.waitForIdle();
    const view = must(await s.ipc.getSession(s.source, { sessionId: session.id }));
    expect(view.status).toBe('ready'); expect(view.setup.state).toBe('completed');
    const path = join(s.store.getSessionWorkspace(session.id)!.path, 'setup-effects.txt');
    expect(readFileSync(path, 'utf8')).toBe('setup\n');
    must(await s.ipc.sendTurn(s.source, turn(session.id))); await s.engine.waitForIdle();
    expect(s.store.getSession(session.id)?.status).toBe('answered');
    expect(readFileSync(path, 'utf8')).toBe('setup\n');
  });
  it('изменение script между confirm и spawn блокирует реальный setup', async () => {
    let workspacePath = '';
    const s = await setup({ setup: true, fault: (point, operation) => {
      if (point === 'before_effect' && operation.kind === 'confirm_setup') writeFileSync(join(workspacePath, 'setup.cjs'), 'console.log("changed");');
    } }), session = await s.create();
    workspacePath = s.store.getSessionWorkspace(session.id)!.path;
    if (session.setup.decision?.status !== 'needs_consent') throw new Error('Нет challenge');
    must(await s.ipc.confirmSetup(s.source, { requestId: randomUUID(), sessionId: session.id, challengeId: session.setup.decision.challengeId }));
    await s.engine.waitForIdle();
    expect(s.store.getSession(session.id)?.status).toBe('needs_consent');
    expect(existsSync(join(workspacePath, 'setup-effects.txt'))).toBe(false);
    expect(s.agent.runs).toHaveLength(0);
  });
  it('не теряет запоздалую ошибку interrupt, когда done пришёл раньше', async () => {
    let rejectSignal!: () => void;
    const gate = new Promise<void>(resolve => { rejectSignal = resolve; });
    const agent = createControlledAgent({ autoFinish: false, stop: 'reject', interruptGate: gate });
    const s = await setup({ agent, stopTimeoutMs: 200 }), session = await s.create();
    must(await s.ipc.sendTurn(s.source, turn(session.id))); await until(() => agent.runs.length === 1);
    must(await s.ipc.stop(s.source, { requestId: randomUUID(), sessionId: session.id }));
    agent.runs[0]!.finish(success('Поздний success'));
    await new Promise(resolve => setTimeout(resolve, 10)); rejectSignal();
    await s.engine.waitForIdle();
    expect(s.store.getSession(session.id)?.status).toBe('recovery_required');
    expect(s.store.listTurns(session.id)[0]?.result?.completion.issues.some(issue => issue.code === 'signal_failed')).toBe(true);
    expect(s.store.getLease(session.workspace.id)?.state).toBe('uncertain');
  });
  it('success задачи при ненулевом exit не становится успешной сессией', async () => {
    const agent = createControlledAgent({ autoFinish: false });
    const s = await setup({ agent }), session = await s.create();
    must(await s.ipc.sendTurn(s.source, turn(session.id))); await until(() => agent.runs.length === 1);
    const result = success();
    agent.runs[0]!.finish({ ...result, completion: { ...result.completion, process: { state: 'exited', exitCode: 1, signal: null } } });
    await s.engine.waitForIdle(); expect(s.store.getSession(session.id)?.status).toBe('error');
  });
});
