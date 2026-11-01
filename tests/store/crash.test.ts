import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/store/index.ts';
import { TempDir } from './helpers.ts';
import { event, operation } from './records.ts';

let temp: TempDir;
let dbPath: string;
const opened: SqliteStorage[] = [];
beforeEach(() => { temp = new TempDir(); dbPath = temp.path('state.sqlite'); });
afterEach(() => {
  for (const storage of opened.splice(0)) storage.close();
  temp.cleanup();
});

function crashAt(point: 'before_commit' | 'after_commit') {
  const script = fileURLToPath(new URL('../helpers/store-crash-child.ts', import.meta.url));
  return spawnSync(process.execPath, ['--experimental-transform-types', script, dbPath, point], { encoding: 'utf8', timeout: 30_000 });
}

function reopen(): SqliteStorage {
  const storage = openSqliteStorage(dbPath);
  opened.push(storage);
  return storage;
}

describe('SQLite: убитый процесс и восстановление новым процессом', () => {
  it('SIGKILL до COMMIT: вторая запись исчезает целиком, первая цела, seq без дыр', () => {
    const child = crashAt('before_commit');
    expect(child.signal, child.stderr).toBe('SIGKILL');

    const { store, migration } = reopen();
    // Файл уже на последней версии: повторное открытие новым процессом ничего не мигрирует.
    expect(migration).toBeUndefined();
    expect(store.getOperation('op-1')).toMatchObject({ status: 'running', phase: 'intent_saved' });
    expect(store.getTurn('t1')?.status).toBe('starting');
    expect(store.getLease('workspace-session-1')).toEqual({ workspaceId: 'workspace-session-1', operationId: 'op-1', state: 'held' });
    expect(store.readEvents('session-1', 0, 10).events.map(item => item.id)).toEqual(['e1']);
    expect(store.commit({ events: [event('e-после')] }).map(item => item.seq)).toEqual([2]);
  });

  it('SIGKILL после COMMIT: запись и события видны вместе, повтор requestId не создаёт второй операции', () => {
    const child = crashAt('after_commit');
    expect(child.signal, child.stderr).toBe('SIGKILL');

    const { store } = reopen();
    expect(store.getTurn('t1')?.status).toBe('running');
    expect(store.readEvents('session-1', 0, 10).events.map(item => [item.seq, item.id])).toEqual([[1, 'e1'], [2, 'e2'], [3, 'e3']]);

    // Приложение, не знающее, дошла ли запись, повторяет команду: эффект и события не дублируются.
    const repeat = store.beginOperation(operation('op-1-повтор', { requestId: 'request-op-1', fingerprint: 'fingerprint-op-1' }), { events: [event('e-дубль')] });
    expect(repeat.created).toBe(false);
    expect(repeat.operation.id).toBe('op-1');
    expect(store.readEvents('session-1', 0, 10).events).toHaveLength(3);
  });

  it('БД, оставленная убитым процессом, проходит проверку целостности и не требует миграции', () => {
    expect(crashAt('after_commit').signal).toBe('SIGKILL');
    const { store } = reopen();
    expect(store.listOperations().map(item => item.id)).toEqual(['op-1']);
    expect(store.failed).toBe(false);
  });
});
