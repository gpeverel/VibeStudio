import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSqliteStorage } from '../../src/adapters/store/index.ts';
import type { SqliteStorage, StoreFaultInjector } from '../../src/adapters/store/index.ts';
import { createSessionEngine } from '../../src/core/session-engine.ts';
import type { SessionEngine, SessionEngineOptions } from '../../src/core/session-engine.ts';
import { createProjectCommandConsent } from '../../src/core/project-command-consent.ts';
import type { AgentEvent, AgentRunCompletion, ProcessCompletion } from '../../src/shared/agent.ts';
import type { AgentRun } from '../../src/core/ports/agent.ts';
import type { SoloAgentPort } from '../../src/core/ports/solo-agent.ts';
import type { GitOperation, GitPort } from '../../src/core/ports/git.ts';
import type { Store } from '../../src/core/ports/store.ts';
import { StoreError } from '../../src/core/ports/store.ts';

const clean: ProcessCompletion = { process: { state: 'exited', exitCode: 0, signal: null }, stdout: 'ended', stderr: 'ended',
  wait: 'settled', signals: [], issues: [], descendants: 'not_guaranteed' };
const success: AgentRunCompletion = { kind: 'success', text: 'Ответ', stopAccepted: false, completion: clean };
const fingerprint = (text: string) => createHash('sha256').update(text).digest('hex');
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

interface TestRun extends AgentRun { finish(result?: AgentRunCompletion): void; interrupts: number }
function agentRun(input: Parameters<SoloAgentPort['start']>[0], automatic = true, rejectSignal = false): TestRun {
  let finish!: (result: AgentRunCompletion) => void;
  const done = new Promise<AgentRunCompletion>(resolve => { finish = resolve; });
  let seq = 0;
  const wrap = (payload: AgentEvent extends infer E ? E extends AgentEvent ? Omit<E, 'schemaVersion' | 'eventId' | 'sessionId' | 'turnId' | 'participantId' | 'seq' | 'timestamp'> : never : never): AgentEvent => ({
    ...payload, schemaVersion: 1, eventId: randomUUID(), sessionId: input.turn.sessionId, turnId: input.turn.id,
    participantId: input.participant.id, seq: ++seq, timestamp: new Date().toISOString(),
  } as AgentEvent);
  const run: TestRun = {
    done, diagnostics: [], interrupts: 0, finish: result => finish(result ?? success),
    events: (async function* () {
      yield wrap({ type: 'run_started', agentSessionId: input.participant.agentSessionId ?? randomUUID() });
      yield wrap({ type: 'text', mode: 'delta', messageId: 'message', text: '<img src="https://example.invalid/x">' });
      yield wrap({ type: 'run_finished', result: await done });
    })(),
    async interrupt() { run.interrupts++; if (rejectSignal) throw new Error('signal'); },
    async kill() { run.interrupts++; },
  };
  if (automatic) finish(success);
  return run;
}

async function fixture(settings: { setup?: boolean; automatic?: boolean; rejectSignal?: boolean; fault?: StoreFaultInjector; journalFails?: boolean;
  engineFault?: SessionEngineOptions['faultInjector'];
  createFailure?: { cleanup: NonNullable<GitOperation['creation']>['cleanup']; foreign?: boolean; physical?: 'present' | 'missing'; absentRecord?: boolean };
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'solo-engine-'));
  const dbPath = join(root, 'state.sqlite');
  let storage = openSqliteStorage(dbPath, { faultInjector: settings.fault });
  let history: 'available' | 'missing' | 'unknown' = 'available';
  let physical: 'present' | 'missing' | 'uncertain' = 'present';
  let snapshot = 'a'.repeat(64), snapshotBlocked = false;
  let starts = 0, setups = 0, creates = 0;
  const runs: TestRun[] = [];
  const journal: { code: string; detail: string }[] = [];
  const setupCommand = { kind: 'npm-script' as const, script: 'setup', args: [] };
  function compose(current: SqliteStorage): SessionEngine {
    const store = current.store;
    const consent = createProjectCommandConsent({ capture: async () => snapshotBlocked
      ? { status: 'blocked', reason: 'missing_input', coverage: { profile: 'project-command-v1', inputs: [], limitations: [] } }
      : { status: 'known', fingerprint: snapshot, coverage: { profile: 'project-command-v1', inputs: [{ path: 'setup.cjs', kind: 'file', digest: snapshot }], limitations: ['filesystem_race_after_capture'] } } },
    { find: id => store.findConsent(id), get: id => store.getConsent(id), save: record => { store.commit({ consents: [record] }); },
      digest: fingerprint, nextId: randomUUID, now: () => new Date().toISOString() });
    const git: GitPort = { inspectRepository: async () => ({ head: 'b'.repeat(40), warnings: [] }),
      createWorkspace: async request => {
        creates++;
        if (settings.createFailure) {
          physical = settings.createFailure.physical ?? 'missing';
          if (!settings.createFailure.absentRecord) await current.gitOperationStore.save({ kind: 'create', operationId: randomUUID(), requestId: request.requestId,
            fingerprint: 'synthetic', repositoryId: 'own-repository', phase: 'completed',
            identity: { projectPath: request.projectPath, workspacePath: request.workspacePath, branch: request.branch,
              baseRef: request.baseRef, sessionId: settings.createFailure.foreign ? 'foreign-session' : request.sessionId },
            error: { code: 'git_failed', message: 'Synthetic create error', files: [] },
            creation: { baseSha: 'b'.repeat(40), baseRefCreated: false, branchCreated: false, worktreeCreated: false,
              cleanup: settings.createFailure.cleanup } });
          throw new Error('Synthetic create error');
        }
        return { baseSha: 'b'.repeat(40), warnings: [], applyMode: 'apply' };
      },
      prepareWorkspace: async () => { throw new Error('unused'); }, applyWorkspace: async () => { throw new Error('unused'); },
      reconcileApply: async () => { throw new Error('unused'); }, pushWorkspace: async () => { throw new Error('unused'); } };
    const options: SessionEngineOptions = {
      store, git, gitOperations: current.gitOperationStore, consent, ids: { next: randomUUID }, clock: { now: () => new Date().toISOString() },
      fingerprints: { digest: fingerprint }, stopTimeoutMs: 35, faultInjector: settings.engineFault,
      journal: { append: async entry => { if (settings.journalFails) throw new Error('journal'); journal.push(entry); } },
      files: { allocatePath: id => join(root, id), copyFiles: async () => undefined, inspect: async () => physical,
        inspectProject: async () => ({ canonicalPath: join(root, 'project'), name: 'Тест', defaultBranch: 'main', configVersion: 1,
          config: { setup: settings.setup ? setupCommand : null, copyFiles: [], setupTimeoutMs: 1000 } }) },
      setupRequest: (project, workspace) => ({ projectId: project.id, projectRoot: workspace.path, operationId: `setup:${workspace.id}`,
        purpose: 'setup', command: setupCommand, cwd: workspace.path, env: {}, permissions: { fileSystem: 'workspace-write', network: 'allowed', elevated: false } }),
      commands: { start: async (request, authorization) => {
        const decision = await authorization.recheck(request); if (decision.status !== 'allowed') return { status: 'blocked', decision };
        setups++;
        return { status: 'started', run: { stdout: (async function* () {})(), stderr: (async function* () {})(),
          interrupt: async () => undefined, kill: async () => undefined,
          done: Promise.resolve({ exitCode: 0, signal: null, completion: clean }) } };
      } },
      agents: { history: async () => history, start: async input => { starts++; const run = agentRun(input, settings.automatic !== false, settings.rejectSignal); runs.push(run); return run; } },
    };
    return createSessionEngine(options);
  }
  let engine = compose(storage); await engine.recover();
  cleanup.push(async () => { for (const run of runs) run.finish(); await engine.shutdown(); storage.close(); await rm(root, { recursive: true, force: true }); });
  const project = await engine.selectProject({ requestId: 'select' }, async () => root);
  const creation = await engine.createSession({ requestId: 'create', projectId: project!.id, cli: 'claude' });
  await engine.waitForIdle();
  const sessionId = creation.sessionId!;
  return {
    get engine() { return engine; }, get store(): Store { return storage.store; }, sessionId, project: project!, runs, journal,
    counts: () => ({ starts, setups, creates }), setSnapshot: (value: string) => { snapshot = value; }, blockSnapshot: () => { snapshotBlocked = true; },
    setHistory: (value: typeof history) => { history = value; }, setPhysical: (value: typeof physical) => { physical = value; },
    restart: async () => { await engine.waitForIdle(); storage.close(); storage = openSqliteStorage(dbPath); engine = compose(storage); await engine.recover(); },
  };
}

describe('durable SessionEngine', () => {
  it.each(['completed', 'not_needed'] as const)('доказанная компенсация create (%s) — ошибка без неизвестного эффекта', async rollback => {
    const f = await fixture({ createFailure: { cleanup: rollback } });
    expect(f.store.findOperation('create')).toMatchObject({ status: 'failed', error: { code: 'workspace_failed' } });
    const view = f.engine.getSession({ sessionId: f.sessionId });
    expect(view).toMatchObject({ status: 'error', workspace: { state: 'missing' }, actions: { send: false } });
    expect(f.store.getLease(view.workspace.id)?.state).toBe('released');
    await f.restart();
    expect(f.engine.getSession({ sessionId: f.sessionId }).status).toBe('error');
    expect(f.counts().creates).toBe(1);
  });
  it.each([
    { cleanup: 'pending' as const }, { cleanup: 'failed' as const }, { cleanup: 'preserved' as const },
    { cleanup: 'completed' as const, foreign: true }, { cleanup: 'completed' as const, physical: 'present' as const },
    { cleanup: 'completed' as const, absentRecord: true },
  ])('неизвестный или чужой результат cleanup сохраняет слот: %j', async createFailure => {
    const f = await fixture({ createFailure });
    expect(f.store.findOperation('create')?.status).toBe('uncertain');
    const view = f.engine.getSession({ sessionId: f.sessionId });
    expect(view.status).toBe('recovery_required'); expect(f.store.getLease(view.workspace.id)?.state).toBe('uncertain');
    expect(f.counts().creates).toBe(1);
  });
  it('recovery сверяет durable-компенсацию, если результат engine ещё не записан', async () => {
    const f = await fixture({ createFailure: { cleanup: 'completed' } });
    const op = f.store.findOperation('create')!, session = f.store.getSession(f.sessionId)!, workspace = f.store.getSessionWorkspace(f.sessionId)!;
    // Граница: Git сохранил подтверждённый cleanup, а engine ещё хранит прежнее намерение.
    f.store.commit({ operations: [{ ...op, status: 'running', phase: 'effect_pending', error: null }],
      sessions: [{ ...session, status: 'preparing' }], workspaces: [{ ...workspace, state: 'creating' }],
      leases: [{ workspaceId: workspace.id, operationId: op.id, state: 'held' }] });
    await f.restart();
    expect(f.engine.getSession({ sessionId: f.sessionId }).status).toBe('error');
    expect(f.store.findOperation('create')).toMatchObject({ status: 'failed', error: { code: 'workspace_failed' } });
    expect(f.store.getLease(workspace.id)?.state).toBe('released'); expect(f.counts().creates).toBe(1);
  });
  it('ошибка обработки Stop не захватывает чужой слот и не блокирует весь engine', async () => {
    let failResult = false;
    const f = await fixture({ automatic: false, engineFault: point => { if (failResult && point === 'before_result') throw new Error('Synthetic result handler failure'); } });
    const original = await f.engine.sendTurn({ requestId: 'turn', sessionId: f.sessionId, prompt: 'А', conversation: 'new' });
    await vi.waitFor(() => expect(f.runs).toHaveLength(1)); failResult = true;
    await f.engine.stop({ requestId: 'stop', sessionId: f.sessionId });
    await vi.waitFor(() => expect(f.store.findOperation('stop')?.status).toBe('failed'));
    const view = f.engine.getSession({ sessionId: f.sessionId });
    expect(f.store.getLease(view.workspace.id)).toMatchObject({ operationId: original.id, state: 'held' });
    expect(f.store.listTurns(f.sessionId)[0]?.status).toBe('stopping'); expect(f.store.failed).toBe(false);
    await expect(f.engine.selectProject({ requestId: 'another-project' }, async () => null)).resolves.toBeNull();
    failResult = false; f.runs[0]!.finish(); await f.engine.waitForIdle();
    expect(f.engine.getSession({ sessionId: f.sessionId }).status).toBe('interrupted');
  });
  it('нарушение ограничения остаётся диагностируемым и не изображает отказ SQLite', async () => {
    const f = await fixture();
    vi.spyOn(f.store, 'beginOperation').mockImplementationOnce(() => { throw new StoreError('constraint', 'lease_required'); });
    await expect(f.engine.sendTurn({ requestId: 'turn', sessionId: f.sessionId, prompt: 'А', conversation: 'new' })).rejects.toMatchObject({ code: 'busy' });
    await vi.waitFor(() => expect(f.journal).toContainEqual(expect.objectContaining({ code: 'store_constraint', detail: 'lease_required' })));
    expect(f.store.failed).toBe(false); expect(f.counts().starts).toBe(0);
  });
  it('сохраняет переходы и ленту до уведомления, повтор create не создаёт workspace', async () => {
    const f = await fixture();
    const invalidNotices: number[] = [];
    f.engine.onEventsAvailable(notice => {
      const page = f.engine.readEvents({ sessionId: notice.sessionId, after: notice.seq - 1, limit: 1 });
      if (page.events[0]?.seq !== notice.seq) invalidNotices.push(notice.seq);
    });
    const command = { requestId: 'turn', sessionId: f.sessionId, prompt: 'Задача', conversation: 'continue' as const };
    const [a, b] = await Promise.all([f.engine.sendTurn(command), f.engine.sendTurn(command)]);
    expect(a.id).toBe(b.id); await f.engine.waitForIdle();
    expect(invalidNotices).toEqual([]);
    expect(f.counts()).toEqual({ starts: 1, setups: 0, creates: 1 });
    expect(f.engine.getSession({ sessionId: f.sessionId }).status).toBe('answered');
    const again = await f.engine.createSession({ requestId: 'create', projectId: f.project.id, cli: 'claude' });
    expect(again.sessionId).toBe(f.sessionId); expect(f.counts().creates).toBe(1);
    const events = f.engine.readEvents({ sessionId: f.sessionId, after: 0, limit: 200 }).events;
    expect(events.map(e => e.seq)).toEqual(events.map((_e, i) => i + 1));
    expect(events.filter(e => e.payload.type === 'user_message')).toHaveLength(1);
    const final = events.findIndex(e => e.payload.type === 'agent' && e.payload.event.type === 'run_finished');
    expect(events[final + 1]?.payload).toMatchObject({ type: 'session_state', status: 'answered' });
  });
  it('использует ответ атомарного beginOperation даже при устаревшем предварительном чтении', async () => {
    const f = await fixture();
    const before = f.store.listSessions();
    vi.spyOn(f.store, 'findOperation').mockReturnValueOnce(undefined);
    const repeated = await f.engine.createSession({ requestId: 'create', projectId: f.project.id, cli: 'claude' });
    await f.engine.waitForIdle();
    expect(repeated.sessionId).toBe(f.sessionId); expect(f.counts().creates).toBe(1);
    expect(f.store.listSessions()).toEqual(before);
  });
  it.each([1, 17])('success модели при exit %i остаётся ошибкой', async exitCode => {
    const f = await fixture({ automatic: false });
    await f.engine.sendTurn({ requestId: 'turn', sessionId: f.sessionId, prompt: 'А', conversation: 'new' });
    await vi.waitFor(() => expect(f.runs).toHaveLength(1));
    f.runs[0]!.finish({ ...success, completion: { ...clean, process: { state: 'exited', exitCode, signal: null } } });
    await f.engine.waitForIdle();
    expect(f.engine.getSession({ sessionId: f.sessionId })).toMatchObject({ status: 'error', result: { kind: 'error', reason: 'nonzero_exit' } });
  });
  it('конфликтует по содержимому requestId и не запускает конкурентный ход', async () => {
    const f = await fixture({ automatic: false });
    await f.engine.sendTurn({ requestId: 'turn', sessionId: f.sessionId, prompt: 'А', conversation: 'new' });
    await expect(f.engine.sendTurn({ requestId: 'turn', sessionId: f.sessionId, prompt: 'Б', conversation: 'new' })).rejects.toMatchObject({ code: 'request_conflict' });
    await expect(f.engine.sendTurn({ requestId: 'other', sessionId: f.sessionId, prompt: 'В', conversation: 'new' })).rejects.toMatchObject({ code: 'busy' });
    await vi.waitFor(() => expect(f.runs).toHaveLength(1)); f.runs[0]!.finish(); await f.engine.waitForIdle(); expect(f.counts().starts).toBe(1);
  });
  it('Stop идемпотентен, поздний success становится interrupted без продолжения', async () => {
    const f = await fixture({ automatic: false });
    await f.engine.sendTurn({ requestId: 'turn', sessionId: f.sessionId, prompt: 'А', conversation: 'new' });
    await vi.waitFor(() => expect(f.runs).toHaveLength(1));
    const request = { requestId: 'stop', sessionId: f.sessionId };
    const a = await f.engine.stop(request), b = await f.engine.stop(request);
    expect(a.id).toBe(b.id); f.runs[0]!.finish(); await f.engine.waitForIdle();
    const view = f.engine.getSession({ sessionId: f.sessionId });
    expect(view.status).toBe('interrupted'); expect(view.result).toMatchObject({ kind: 'interrupted', stopAccepted: true });
    expect(f.runs[0]!.interrupts).toBe(1); expect(f.store.getLease(view.workspace.id)?.state).toBe('released');
  });
  it('ошибка сигнала сохраняет неопределённый слот даже при позднем exit', async () => {
    const f = await fixture({ automatic: false, rejectSignal: true });
    await f.engine.sendTurn({ requestId: 'turn', sessionId: f.sessionId, prompt: 'А', conversation: 'new' });
    await vi.waitFor(() => expect(f.runs).toHaveLength(1));
    await f.engine.stop({ requestId: 'stop', sessionId: f.sessionId });
    await new Promise(resolve => setTimeout(resolve, 5)); f.runs[0]!.finish(); await f.engine.waitForIdle();
    const view = f.engine.getSession({ sessionId: f.sessionId }); expect(view.status).toBe('recovery_required');
    expect(f.store.getLease(view.workspace.id)?.state).toBe('uncertain');
    await expect(f.engine.sendTurn({ requestId: 'again', sessionId: f.sessionId, prompt: 'А', conversation: 'new' })).rejects.toMatchObject({ code: 'recovery_required' });
  });
  it('неподтверждённое завершение не освобождает слот', async () => {
    const f = await fixture({ automatic: false });
    await f.engine.sendTurn({ requestId: 'turn', sessionId: f.sessionId, prompt: 'А', conversation: 'new' });
    await vi.waitFor(() => expect(f.runs).toHaveLength(1));
    f.runs[0]!.finish({ ...success, completion: { ...clean, process: { state: 'unconfirmed' }, wait: 'deadline' } });
    await f.engine.waitForIdle(); expect(f.engine.getSession({ sessionId: f.sessionId }).status).toBe('recovery_required');
  });
  it('setup требует конкретного согласия и не пересекается с ходом', async () => {
    const f = await fixture({ setup: true });
    const initial = f.engine.getSession({ sessionId: f.sessionId }); expect(initial.setup.decision?.status).toBe('needs_consent');
    await expect(f.engine.sendTurn({ requestId: 'turn', sessionId: f.sessionId, prompt: 'А', conversation: 'new' })).rejects.toMatchObject({ code: 'invalid_transition' });
    if (initial.setup.decision?.status !== 'needs_consent') throw new Error('challenge');
    await f.engine.confirmSetup({ requestId: 'confirm', sessionId: f.sessionId, challengeId: initial.setup.decision.challengeId });
    await f.engine.waitForIdle(); expect(f.counts().setups).toBe(1); expect(f.engine.getSession({ sessionId: f.sessionId }).status).toBe('ready');
  });
  it('изменение снимка между показом и подтверждением блокирует setup', async () => {
    const f = await fixture({ setup: true }), decision = f.engine.getSession({ sessionId: f.sessionId }).setup.decision;
    if (decision?.status !== 'needs_consent') throw new Error('challenge');
    f.setSnapshot('b'.repeat(64));
    await f.engine.confirmSetup({ requestId: 'confirm', sessionId: f.sessionId, challengeId: decision.challengeId });
    await f.engine.waitForIdle(); expect(f.counts().setups).toBe(0);
    expect(f.engine.getSession({ sessionId: f.sessionId }).setup.decision).toMatchObject({ status: 'blocked', reason: 'stale_challenge' });
  });
  it('старые challenges после restart не оживают, свежий вопрос получает другой ID', async () => {
    const f = await fixture({ setup: true }), before = f.engine.getSession({ sessionId: f.sessionId }).setup.decision;
    if (before?.status !== 'needs_consent') throw new Error('challenge');
    await f.restart(); const after = f.engine.getSession({ sessionId: f.sessionId }).setup.decision;
    expect(after?.status).toBe('needs_consent');
    if (after?.status !== 'needs_consent') throw new Error('challenge'); expect(after.challengeId).not.toBe(before.challengeId);
    await expect(f.engine.confirmSetup({ requestId: 'old', sessionId: f.sessionId, challengeId: before.challengeId })).rejects.toMatchObject({ code: 'consent_blocked' });
    expect(f.counts().setups).toBe(0);
  });
  it('потеря истории запрещает resume, явный новый диалог сохраняет прежнюю ленту', async () => {
    const f = await fixture();
    await f.engine.sendTurn({ requestId: 'turn', sessionId: f.sessionId, prompt: 'А', conversation: 'new' }); await f.engine.waitForIdle();
    f.setHistory('missing'); await f.restart();
    await expect(f.engine.sendTurn({ requestId: 'resume', sessionId: f.sessionId, prompt: 'Б', conversation: 'continue' })).rejects.toMatchObject({ code: 'history_missing' });
    await f.engine.sendTurn({ requestId: 'new', sessionId: f.sessionId, prompt: 'Б', conversation: 'new' }); await f.engine.waitForIdle();
    expect(f.counts().starts).toBe(2);
    expect(f.store.readEvents(f.sessionId, 0, 200).events.filter(e => e.payload.type === 'user_message')).toHaveLength(2);
  });
  it('потеря workspace сохраняет историю и блокирует новый эффект', async () => {
    const f = await fixture(); f.setPhysical('missing'); await f.restart();
    expect(f.engine.getSession({ sessionId: f.sessionId }).workspace.state).toBe('missing');
    expect(f.store.readEvents(f.sessionId, 0, 200).events.length).toBeGreaterThan(1);
    await expect(f.engine.sendTurn({ requestId: 'turn', sessionId: f.sessionId, prompt: 'А', conversation: 'new' })).rejects.toMatchObject({ code: 'recovery_required' });
  });
  it('ошибка журнала видна в SQLite, ответ не теряется', async () => {
    const f = await fixture({ journalFails: true });
    await f.engine.sendTurn({ requestId: 'turn', sessionId: f.sessionId, prompt: 'А', conversation: 'new' }); await f.engine.waitForIdle();
    expect(f.engine.getSession({ sessionId: f.sessionId }).status).toBe('answered');
    expect(f.store.readEvents(f.sessionId, 0, 200).events.some(e => e.payload.type === 'diagnostic' && e.payload.code === 'journal_failed')).toBe(true);
  });
  it('ошибка SQLite откатывает intent и не запускает агента', async () => {
    let fail = false;
    const f = await fixture({ fault: (point, context) => { if (fail && point === 'before_commit' && context.operation === 'begin_operation') throw new Error('disk'); } });
    fail = true;
    await expect(f.engine.sendTurn({ requestId: 'turn', sessionId: f.sessionId, prompt: 'А', conversation: 'new' })).rejects.toMatchObject({ code: 'store_failed' });
    expect(f.counts().starts).toBe(0); expect(f.store.findOperation('turn')).toBeUndefined();
    expect(f.store.readEvents(f.sessionId, 0, 200).events.some(e => e.payload.type === 'user_message')).toBe(false);
  });
});
