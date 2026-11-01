import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GitOperation } from '../../src/core/ports/git.ts';
import { StoreError } from '../../src/core/ports/store.ts';
import { openSqliteStorage, type SqliteStorage, type StoreFaultInjector } from '../../src/adapters/store/index.ts';
import { TempDir } from './helpers.ts';
import { baseWrite, consent, event, NOW, operation, participant, project, session, turn, workspace } from './records.ts';

let temp: TempDir;
let dbPath: string;
const opened: SqliteStorage[] = [];
beforeEach(() => { temp = new TempDir(); dbPath = temp.path('state.sqlite'); });
afterEach(() => {
  for (const storage of opened.splice(0)) storage.close();
  temp.cleanup();
});

function open(options: { faultInjector?: StoreFaultInjector } = {}): SqliteStorage {
  const storage = openSqliteStorage(dbPath, options);
  opened.push(storage);
  return storage;
}

function failureOf(action: () => unknown): StoreError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(StoreError);
    return error as StoreError;
  }
  throw new Error('Ожидалась ошибка хранилища.');
}

describe('SqliteStore: операции и requestId', () => {
  it('повтор requestId возвращает существующую операцию без новых событий; другое содержимое — конфликт', () => {
    const { store } = open();
    const first = store.beginOperation(operation('op-1'), baseWrite({ events: [event('e1')] }));
    expect(first.created).toBe(true);
    expect(first.events.map(item => item.seq)).toEqual([1]);

    // Повтор приходит с новым внутренним id, но тем же requestId и содержимым.
    const repeat = store.beginOperation(operation('op-1-retry', { requestId: 'request-op-1', fingerprint: 'fingerprint-op-1' }),
      { events: [event('e-повтор')] });
    expect(repeat.created).toBe(false);
    expect(repeat.operation.id).toBe('op-1');
    expect(repeat.events).toEqual([]);
    expect(store.readEvents('session-1', 0, 10).events.map(item => item.id)).toEqual(['e1']);
    expect(store.getOperation('op-1-retry')).toBeUndefined();

    const conflict = failureOf(() => store.beginOperation(operation('op-1-other', { requestId: 'request-op-1', fingerprint: 'другое' }),
      { events: [event('e-конфликт')] }));
    expect(conflict.code).toBe('request_conflict');
    expect(store.readEvents('session-1', 0, 10).events).toHaveLength(1);
    expect(store.failed).toBe(false);
  });

  it('два экземпляра приложения на одной БД: гонка за requestId даёт одну операцию и одно событие', () => {
    const first = open().store;
    const second = open().store;
    const a = first.beginOperation(operation('op-a', { requestId: 'shared' }), baseWrite({ events: [event('ea')] }));
    const b = second.beginOperation(operation('op-b', { requestId: 'shared', fingerprint: 'fingerprint-op-a' }), { events: [event('eb')] });
    expect([a.created, b.created]).toEqual([true, false]);
    expect(b.operation.id).toBe('op-a');
    expect(second.readEvents('session-1', 0, 10).events.map(item => item.id)).toEqual(['ea']);
    expect(failureOf(() => second.beginOperation(operation('op-c', { requestId: 'shared', fingerprint: 'иное' }))).code)
      .toBe('request_conflict');
  });

  it('идентичность существующей операции не меняется через commit', () => {
    const { store } = open();
    store.beginOperation(operation('op-1'), baseWrite());
    expect(failureOf(() => store.commit({ operations: [operation('op-1', { fingerprint: 'подмена' })] })).code).toBe('request_conflict');
    expect(failureOf(() => store.commit({ operations: [operation('op-2', { requestId: 'request-op-1' })] })).code).toBe('request_conflict');
    store.commit({ operations: [operation('op-1', { status: 'completed', phase: 'result_saved', updatedAt: '2026-10-29T10:05:00.000Z' })] });
    expect(store.getOperation('op-1')).toMatchObject({ status: 'completed', phase: 'result_saved' });
    expect(store.failed).toBe(false);
  });
});

describe('SqliteStore: атомарность состояния и событий', () => {
  it('отклонённая запись не оставляет ни сущностей, ни событий, ни дыр в seq', () => {
    const { store } = open();
    store.beginOperation(operation('op-1'), baseWrite({ events: [event('e1')] }));

    // Событие и ход корректны, но сессия ссылается на несуществующий проект.
    const error = failureOf(() => store.commit({
      sessions: [session('session-x', 'нет-проекта')], events: [event('e2')],
    }));
    expect(error.code).toBe('constraint');
    expect(store.getSession('session-x')).toBeUndefined();
    expect(store.readEvents('session-1', 0, 10).events.map(item => item.seq)).toEqual([1]);
    expect(store.failed).toBe(false);

    const next = store.commit({ events: [event('e3')] });
    expect(next.map(item => item.seq)).toEqual([2]);
  });

  it('состояние хода и событие фиксируются вместе; повтор id события отклоняется целиком', () => {
    const { store } = open();
    store.beginOperation(operation('op-1', { turnId: 't1' }), baseWrite({
      leases: [{ workspaceId: 'workspace-session-1', operationId: 'op-1', state: 'held' }],
      turns: [turn('t1', 1, 'op-1')], events: [event('e1')],
    }));
    const committed = store.commit({
      turns: [turn('t1', 1, 'op-1', { status: 'running' })],
      events: [event('e2'), event('e3')],
    });
    expect(committed.map(item => item.seq)).toEqual([2, 3]);
    expect(store.getTurn('t1')?.status).toBe('running');

    const duplicate = failureOf(() => store.commit({ turns: [turn('t1', 1, 'op-1', { status: 'stopping' })], events: [event('e3')] }));
    expect(duplicate.code).toBe('constraint');
    expect(store.getTurn('t1')?.status).toBe('running');
    expect(store.readEvents('session-1', 0, 10).events).toHaveLength(3);
  });

  it('seq непрерывен по сессиям независимо; чтение по курсору не теряет и не повторяет события', () => {
    const { store } = open();
    store.beginOperation(operation('op-1'), baseWrite());
    store.commit({ sessions: [session('session-2')], workspaces: [workspace('session-2')], participants: [participant('session-2')] });
    for (let batch = 0; batch < 3; batch++) {
      store.commit({ events: Array.from({ length: 9 }, (_, index) => event(`a-${batch}-${index}`)) });
    }
    store.commit({ events: [event('b-1', 'session-2')] });

    const seen: number[] = [];
    let cursor = 0;
    for (let guard = 0; guard < 10; guard++) {
      const page = store.readEvents('session-1', cursor, 10);
      seen.push(...page.events.map(item => item.seq));
      expect(page.nextCursor).toBe(page.events.at(-1)?.seq ?? cursor);
      cursor = page.nextCursor;
      if (!page.hasMore) break;
    }
    expect(seen).toEqual(Array.from({ length: 27 }, (_, index) => index + 1));
    expect(store.readEvents('session-1', cursor, 10)).toEqual({ events: [], nextCursor: 27, hasMore: false });
    expect(store.readEvents('session-2', 0, 10).events.map(item => item.seq)).toEqual([1]);
  });

  it('новый экземпляр хранилища видит те же записи и продолжает seq', () => {
    const first = open();
    first.store.beginOperation(operation('op-1'), baseWrite({ events: [event('e1'), event('e2')] }));
    first.close();
    const second = open().store;
    expect(second.getOperation('op-1')?.requestId).toBe('request-op-1');
    expect(second.readEvents('session-1', 1, 10).events.map(item => item.id)).toEqual(['e2']);
    expect(second.commit({ events: [event('e3')] }).map(item => item.seq)).toEqual([3]);
    expect(second.findProjectByPath('/synthetic/project-1')?.id).toBe('project-1');
    expect(second.getSessionWorkspace('session-1')?.id).toBe('workspace-session-1');
    expect(second.getSessionParticipant('session-1')?.cli).toBe('claude');
  });

  it('JSON-поля возвращаются без искажений', () => {
    const { store } = open();
    const decision = { status: 'needs_consent', reason: 'not_granted', challengeId: 'c1', fingerprint: 'f'.repeat(64),
      coverage: { profile: 'project-command-v1', inputs: [], limitations: ['filesystem_race_after_capture'] } } as const;
    const stored = { ...workspace(), setupState: 'needs_consent' as const, setupDecision: decision, setupCompletion: null };
    store.beginOperation(operation('op-1'), baseWrite({ workspaces: [stored] }));
    expect(store.getWorkspace('workspace-session-1')).toEqual(stored);
    expect(store.getProject('project-1')).toEqual(project());
  });
});

describe('SqliteStore: принадлежность сущностей', () => {
  it('чужие session/workspace/participant/operation отклоняются на уровне БД', () => {
    const { store } = open();
    store.beginOperation(operation('op-1'), baseWrite({
      sessions: [session(), session('session-2')],
      workspaces: [workspace(), workspace('session-2')],
      participants: [participant(), participant('session-2')],
    }));
    const rejected = (write: Parameters<typeof store.commit>[0]) => failureOf(() => store.commit(write)).code;

    expect(rejected({ participants: [{ ...participant('session-2'), id: 'p-чужой', workspaceId: 'workspace-session-1' }] })).toBe('constraint');
    expect(rejected({ participants: [{ ...participant('session-2'), id: 'p-codex-mix', cli: 'codex', profile: 'practical-local-v1' }] })).toBe('constraint');
    expect(rejected({ participants: [{ ...participant(), cli: 'codex', profile: 'codex-app-server-read-v1' }] })).toBe('constraint');
    expect(rejected({ operations: [operation('op-x', { sessionId: 'session-1', workspaceId: 'workspace-session-2' })] })).toBe('constraint');
    expect(rejected({ operations: [operation('op-y', { sessionId: 'нет-сессии', workspaceId: null })] })).toBe('constraint');
    // Ход session-1 с операцией и слотом другого workspace.
    expect(rejected({
      operations: [operation('op-z', { requestId: 'request-z', sessionId: 'session-2', workspaceId: 'workspace-session-2' })],
      leases: [{ workspaceId: 'workspace-session-2', operationId: 'op-z', state: 'held' }],
      turns: [turn('t-чужой', 1, 'op-z')],
    })).toBe('constraint');
    expect(store.getTurn('t-чужой')).toBeUndefined();
    expect(store.getSessionParticipant('session-1')?.cli).toBe('claude');
    expect(store.failed).toBe(false);
  });

  it('история не исчезает при уборке workspace', () => {
    const { store } = open();
    store.beginOperation(operation('op-1', { turnId: 't1' }), baseWrite({
      leases: [{ workspaceId: 'workspace-session-1', operationId: 'op-1', state: 'held' }],
      turns: [turn('t1', 1, 'op-1')], events: [event('e1')],
    }));
    store.commit({
      turns: [turn('t1', 1, 'op-1', { status: 'completed', endedAt: NOW })],
      leases: [{ workspaceId: 'workspace-session-1', operationId: 'op-1', state: 'released' }],
    });
    store.commit({ workspaces: [{ ...workspace(), state: 'missing' }], events: [event('e2')] });
    expect(store.getWorkspace('workspace-session-1')?.state).toBe('missing');
    expect(store.getTurn('t1')?.status).toBe('completed');
    expect(store.getOperation('op-1')).toBeDefined();
    expect(store.readEvents('session-1', 0, 10).events).toHaveLength(2);
  });
});

describe('SqliteStore: слот workspace и ход', () => {
  const lease = (operationId: string, state: 'held' | 'uncertain' | 'released') =>
    ({ workspaceId: 'workspace-session-1', operationId, state });

  it('слот serial: ход нельзя запустить под чужим слотом, неопределённый слот не возвращается в held', () => {
    const { store } = open();
    store.beginOperation(operation('op-setup', { kind: 'prepare_setup' }), baseWrite({ leases: [lease('op-setup', 'held')] }));

    // Агентный запуск не пересекается с setup.
    const attempt = failureOf(() => store.beginOperation(operation('op-turn', { turnId: 't1' }), {
      leases: [lease('op-turn', 'held')], turns: [turn('t1', 1, 'op-turn')],
    }));
    expect(attempt.code).toBe('constraint');
    expect(attempt.message).toMatch(/lease_busy/);
    expect(store.findOperation('request-op-turn')).toBeUndefined();
    expect(store.getTurn('t1')).toBeUndefined();

    // Неподтверждённое завершение setup держит слот.
    store.commit({ leases: [lease('op-setup', 'uncertain')] });
    expect(store.getLease('workspace-session-1')).toEqual(lease('op-setup', 'uncertain'));
    expect(failureOf(() => store.commit({ leases: [lease('op-setup', 'held')] })).message).toMatch(/lease_uncertain/);
    expect(failureOf(() => store.beginOperation(operation('op-turn', { turnId: 't1' }), {
      leases: [lease('op-turn', 'held')], turns: [turn('t1', 1, 'op-turn')],
    })).message).toMatch(/lease_busy|lease_uncertain/);

    // Явное освобождение открывает workspace следующей операции.
    store.commit({ leases: [lease('op-setup', 'released')] });
    store.beginOperation(operation('op-turn', { turnId: 't1' }), { leases: [lease('op-turn', 'held')], turns: [turn('t1', 1, 'op-turn')] });
    expect(store.getLease('workspace-session-1')).toEqual(lease('op-turn', 'held'));
    expect(store.getTurn('t1')?.status).toBe('starting');
  });

  it('у participant не больше одного активного хода', () => {
    const { store } = open();
    store.beginOperation(operation('op-1', { turnId: 't1' }), baseWrite({ leases: [lease('op-1', 'held')], turns: [turn('t1', 1, 'op-1')] }));
    store.commit({ operations: [operation('op-2', { turnId: 't2' })], turns: [turn('t2', 2, 'op-2', { status: 'completed', endedAt: NOW })] });
    // Второй активный ход под тем же слотом всё равно отклоняется индексом participant.
    const second = failureOf(() => store.commit({ turns: [turn('t3', 3, 'op-1')] }));
    expect(second.code).toBe('constraint');
    expect(second.message).toMatch(/UNIQUE/);
    expect(store.listTurns('session-1').map(item => item.id)).toEqual(['t1', 't2']);
  });
});

describe('SqliteStore: согласия', () => {
  it('согласие сохраняется между экземплярами; отзыв и инвалидирование видны после повторного открытия', () => {
    const first = open();
    first.store.beginOperation(operation('op-1', { kind: 'confirm_setup' }), baseWrite({ consents: [consent('consent-1')] }));
    expect(first.store.findConsent('setup:project-1')).toEqual(consent('consent-1'));
    first.close();

    const second = open().store;
    expect(second.getConsent('consent-1')?.status).toBe('granted');
    // Только одно выданное согласие на операцию.
    expect(failureOf(() => second.commit({ consents: [consent('consent-2')] })).code).toBe('constraint');
    second.commit({ consents: [consent('consent-1', 'setup:project-1', { status: 'revoked', updatedAt: '2026-10-29T10:01:00.000Z' })] });
    second.commit({ consents: [consent('consent-2', 'setup:project-1', { fingerprint: 'd'.repeat(64), updatedAt: '2026-10-29T10:02:00.000Z' })] });
    expect(second.findConsent('setup:project-1')?.id).toBe('consent-2');
    second.commit({ consents: [consent('consent-2', 'setup:project-1', { status: 'invalidated', updatedAt: '2026-10-29T10:03:00.000Z' })] });

    const third = open().store;
    expect(third.findConsent('setup:project-1')).toMatchObject({ id: 'consent-2', status: 'invalidated' });
    expect(third.getConsent('consent-1')?.status).toBe('revoked');
    expect(third.findConsent('setup:другой')).toBeUndefined();
  });
});

describe('SqliteStore: отказ записи', () => {
  it('ошибка SQLite фиксирует отказ: новые записи и Git-операции блокируются, чтение остаётся', async () => {
    const storage = open();
    storage.store.beginOperation(operation('op-1'), baseWrite({ events: [event('e1')] }));

    // Реальная ошибка SQLite: таблица событий исчезла из-под приложения.
    const intruder = new Database(dbPath);
    intruder.exec('ALTER TABLE events RENAME TO events_moved');
    intruder.close();

    const error = failureOf(() => storage.store.commit({ events: [event('e2')] }));
    expect(error.code).toBe('store_failed');
    expect(storage.store.failed).toBe(true);
    expect(failureOf(() => storage.store.commit({})).code).toBe('store_failed');
    expect(failureOf(() => storage.store.beginOperation(operation('op-2'))).code).toBe('store_failed');
    await expect(storage.gitOperationStore.save(gitOperation('git-1'))).rejects.toMatchObject({ code: 'store_failed' });
    expect(storage.store.getSession('session-1')?.id).toBe('session-1');
    expect(storage.store.getOperation('op-1')?.id).toBe('op-1');
  });

  it('исключение до COMMIT откатывает запись и блокирует хранилище; после COMMIT — запись остаётся', () => {
    let mode: 'none' | 'before' | 'after' = 'none';
    const points: string[] = [];
    const storage = open({
      faultInjector: (point, context) => {
        points.push(`${point}:${context.operation}`);
        if (mode === 'before' && point === 'before_commit') throw new Error('синтетический отказ диска');
        if (mode === 'after' && point === 'after_commit') throw new Error('процесс завершён после COMMIT');
      },
    });
    storage.store.beginOperation(operation('op-1'), baseWrite({ events: [event('e1')] }));
    expect(points).toEqual(['before_commit:begin_operation', 'after_commit:begin_operation']);

    mode = 'after';
    expect(() => storage.store.commit({ events: [event('e2')] })).toThrowError('процесс завершён после COMMIT');
    mode = 'none';
    expect(storage.store.failed).toBe(false);
    expect(storage.store.readEvents('session-1', 0, 10).events.map(item => item.id)).toEqual(['e1', 'e2']);

    mode = 'before';
    expect(failureOf(() => storage.store.commit({ events: [event('e3')] })).code).toBe('store_failed');
    expect(storage.store.failed).toBe(true);
    mode = 'none';
    expect(failureOf(() => storage.store.commit({ events: [event('e4')] })).code).toBe('store_failed');
    expect(storage.store.readEvents('session-1', 0, 10).events.map(item => item.id)).toEqual(['e1', 'e2']);
  });

  it('закрытое хранилище не принимает записей и чтений', () => {
    const storage = open();
    storage.store.beginOperation(operation('op-1'), baseWrite());
    storage.close();
    expect(failureOf(() => storage.store.commit({})).code).toBe('store_failed');
    expect(failureOf(() => storage.store.getSession('session-1')).code).toBe('store_failed');
    expect(storage.store.failed).toBe(true);
  });
});

function gitOperation(requestId: string, overrides: Partial<GitOperation> = {}): GitOperation {
  return {
    kind: 'create', operationId: `operation-${requestId}`, requestId, repositoryId: '/repo/.git', fingerprint: 'f'.repeat(64),
    phase: 'intent_saved',
    identity: { projectPath: '/repo', workspacePath: '/ws', sessionId: 'session-1', branch: 'vs/session-1', baseRef: 'main' },
    creation: { baseSha: 'a'.repeat(40), baseRefCreated: true, branchCreated: false, worktreeCreated: false, cleanup: 'pending' },
    ...overrides,
  };
}

describe('SqliteGitOperationStore', () => {
  it('сохраняет контракт 0B: save заменяет по requestId, get и list отдают независимые копии, данные переживают переоткрытие', async () => {
    const first = open();
    const { gitOperationStore } = first;
    expect(await gitOperationStore.get('git-1')).toBeUndefined();
    const created = gitOperation('git-1');
    await gitOperationStore.save(created);
    await gitOperationStore.save(gitOperation('git-2', { kind: 'apply', phase: 'checkpoint_created', preApplyRef: 'refs/vibestudio/s/operations/x/pre-apply' }));
    const done = gitOperation('git-1', {
      phase: 'completed', workspaceResult: { baseSha: 'a'.repeat(40), warnings: ['dirty_tree'], applyMode: 'apply' },
      error: { code: 'git_failed', message: 'сбой', files: ['a.txt'] },
      cleanupError: { code: 'git_failed', message: 'не удалось', files: [] },
    });
    await gitOperationStore.save(done);

    const found = await gitOperationStore.get('git-1');
    expect(found).toEqual(done);
    found!.identity.branch = 'испорчено';
    expect((await gitOperationStore.get('git-1'))?.identity.branch).toBe('vs/session-1');
    expect((await gitOperationStore.list()).map(item => item.requestId)).toEqual(['git-1', 'git-2']);
    first.close();

    const second = open().gitOperationStore;
    expect(await second.get('git-1')).toEqual(done);
    expect((await second.list()).map(item => item.phase)).toEqual(['completed', 'checkpoint_created']);
  });

  it('операции Git не удаляются и operationId уникален', async () => {
    const { gitOperationStore } = open();
    await gitOperationStore.save(gitOperation('git-1'));
    await expect(gitOperationStore.save(gitOperation('git-2', { operationId: 'operation-git-1' }))).rejects.toMatchObject({ code: 'constraint' });
    const intruder = new Database(dbPath);
    try {
      expect(() => intruder.exec('DELETE FROM git_operations')).toThrowError(/history_immutable/);
    } finally { intruder.close(); }
  });
});
