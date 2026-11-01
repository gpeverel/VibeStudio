import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createGitAdapter } from '../src/adapters/git/index.ts';
import { openSqliteStorage, type SqliteStorage, type StoreFaultInjector } from '../src/adapters/store/index.ts';
import type { GitFaultPoint, GitOperation, GitOperationStore } from '../src/core/ports/git.ts';
import { WorkspaceStand } from './workspace/stand.ts';

const stands: WorkspaceStand[] = [];
const storages: SqliteStorage[] = [];
afterEach(() => {
  for (const storage of storages.splice(0)) storage.close();
  for (const own of stands.splice(0)) own.cleanup();
});

function stand(): WorkspaceStand {
  const own = new WorkspaceStand();
  stands.push(own);
  own.commit({ 'tracked.txt': 'base\n' }, 'Базовый коммит');
  return own;
}

const dbPathOf = (own: WorkspaceStand) => join(own.root, 'git-state.sqlite');
function openStorage(own: WorkspaceStand, faultInjector?: StoreFaultInjector): SqliteStorage {
  const storage = openSqliteStorage(dbPathOf(own), faultInjector ? { faultInjector } : {});
  storages.push(storage);
  return storage;
}

const workspaceOf = (own: WorkspaceStand, session = 's1') => join(own.workspacesRoot, session);
const request = (own: WorkspaceStand, overrides: Partial<Parameters<ReturnType<typeof createGitAdapter>['createWorkspace']>[0]> = {}) => ({
  requestId: 'create-1', projectPath: own.project, workspacePath: workspaceOf(own), sessionId: 's1', branch: 'vs/s1', baseRef: 'main',
  ...overrides,
});
const refsOf = (own: WorkspaceStand) => own.run(own.project, 'for-each-ref', '--format=%(refname)', 'refs/vibestudio', 'refs/heads/vs');
const worktreesOf = (own: WorkspaceStand) => own.run(own.project, 'worktree', 'list', '--porcelain');
const gitDir = (own: WorkspaceStand) => join(own.project, '.git');

async function operationOf(store: GitOperationStore, requestId = 'create-1'): Promise<GitOperation> {
  const found = await store.get(requestId);
  if (!found) throw new Error(`Операция ${requestId} не записана.`);
  return found;
}

/** Состояние репозитория после полной компенсации: ничего от неудавшегося создания не осталось. */
function expectPristine(own: WorkspaceStand): void {
  expect(refsOf(own)).toBe('');
  expect(worktreesOf(own).split('\n').filter(line => line.startsWith('worktree '))).toHaveLength(1);
  expect(existsSync(workspaceOf(own))).toBe(false);
  expect(own.run(own.project, 'status', '--porcelain=v1', '--untracked-files=all')).toBe('');
}

describe('G10: createWorkspace — durable намерение и признаки владения', () => {
  it('намерение записано до первого эффекта, признаки владения фиксируются по шагам и переживают переоткрытие БД', async () => {
    const own = stand();
    const storage = openStorage(own);
    const seen: { point: GitFaultPoint; operation: GitOperation | undefined; refs: string }[] = [];
    const adapter = createGitAdapter({
      store: storage.gitOperationStore,
      faultInjector: async point => {
        seen.push({ point, operation: await storage.gitOperationStore.get('create-1'), refs: refsOf(own) });
      },
    });
    const result = await adapter.createWorkspace(request(own));

    const byPoint = Object.fromEntries(seen.map(item => [item.point, item]));
    expect(seen.map(item => item.point)).toEqual(['create_after_intent', 'create_after_base_ref', 'create_after_worktree',
      'create_after_config', 'create_before_result']);
    // До первого update-ref запись уже durable, ресурсов ещё нет.
    expect(byPoint.create_after_intent?.operation).toMatchObject({
      kind: 'create', phase: 'intent_saved',
      creation: { baseSha: result.baseSha, baseRefCreated: false, branchCreated: false, worktreeCreated: false, cleanup: 'not_needed' },
    });
    expect(byPoint.create_after_intent?.refs).toBe('');
    expect(byPoint.create_after_base_ref?.operation?.creation).toMatchObject({ baseRefCreated: true, branchCreated: false, worktreeCreated: false });
    expect(byPoint.create_after_base_ref?.refs).toBe('refs/vibestudio/s1/base');
    expect(byPoint.create_after_worktree?.operation?.creation).toMatchObject({ baseRefCreated: true, branchCreated: true, worktreeCreated: true });
    expect(byPoint.create_before_result?.operation?.workspaceResult).toBeUndefined();

    storage.close();
    const reopened = openStorage(own);
    expect(await operationOf(reopened.gitOperationStore)).toMatchObject({
      phase: 'completed', workspaceResult: result, creation: { baseRefCreated: true, branchCreated: true, worktreeCreated: true, cleanup: 'not_needed' },
    });
    // Повтор из нового экземпляра возвращает записанный результат без изменений Git.
    const before = worktreesOf(own);
    expect(await createGitAdapter({ store: reopened.gitOperationStore }).createWorkspace(request(own))).toEqual(result);
    expect(worktreesOf(own)).toBe(before);
  });

  it('сбой после worktree add удаляет только созданное операцией и записывает исходную ошибку', async () => {
    const own = stand();
    const storage = openStorage(own);
    let blockConfig = true;
    const adapter = createGitAdapter({
      store: storage.gitOperationStore,
      // Настоящий сбой git config: блокировка файла конфигурации.
      faultInjector: point => {
        if (point === 'create_after_worktree' && blockConfig) writeFileSync(join(gitDir(own), 'config.lock'), '');
      },
    });
    await expect(adapter.createWorkspace(request(own))).rejects.toMatchObject({ code: 'git_failed' });
    expectPristine(own);

    const record = await operationOf(storage.gitOperationStore);
    expect(record).toMatchObject({
      phase: 'completed', error: { code: 'git_failed' },
      creation: { baseRefCreated: true, branchCreated: true, worktreeCreated: true, cleanup: 'completed' },
    });
    expect(record.workspaceResult).toBeUndefined();
    expect(record.cleanupError).toBeUndefined();

    // Тот же requestId воспроизводит записанный сбой, не трогая Git; новая попытка — новый requestId.
    const refsBefore = refsOf(own);
    await expect(adapter.createWorkspace(request(own))).rejects.toMatchObject({ code: 'git_failed' });
    expect(refsOf(own)).toBe(refsBefore);
    await expect(adapter.createWorkspace(request(own, { requestId: 'create-1', branch: 'vs/другая' }))).rejects.toMatchObject({ code: 'request_conflict' });
    rmLock(own);
    blockConfig = false;
    const retry = await adapter.createWorkspace(request(own, { requestId: 'create-2' }));
    expect(retry.baseSha).toBe(own.run(own.project, 'rev-parse', 'main'));
    expect(own.run(workspaceOf(own), 'branch', '--show-current')).toBe('vs/s1');
  });

  it('пользовательские данные в созданном worktree сохраняются: cleanup помечается preserved, исходная ошибка не теряется', async () => {
    const own = stand();
    const storage = openStorage(own);
    const adapter = createGitAdapter({
      store: storage.gitOperationStore,
      faultInjector: point => {
        if (point === 'create_after_worktree') writeFileSync(join(gitDir(own), 'config.lock'), '');
        if (point === 'create_before_cleanup') writeFileSync(join(workspaceOf(own), 'мои-заметки.txt'), 'важное\n');
      },
    });
    await expect(adapter.createWorkspace(request(own))).rejects.toMatchObject({ code: 'git_failed' });

    expect(own.read(join(workspaceOf(own), 'мои-заметки.txt'))).toBe('важное\n');
    expect(refsOf(own).split('\n').sort()).toEqual(['refs/heads/vs/s1', 'refs/vibestudio/s1/base']);
    expect(await operationOf(storage.gitOperationStore)).toMatchObject({
      phase: 'completed', error: { code: 'git_failed' }, cleanupError: { code: 'dirty_tree', files: ['мои-заметки.txt'] },
      creation: { cleanup: 'preserved', worktreeCreated: true },
    });
    // Неопределённый cleanup не повторяется автоматически.
    rmLock(own);
    await expect(adapter.createWorkspace(request(own))).rejects.toMatchObject({ code: 'operation_in_progress' });
    expect(own.read(join(workspaceOf(own), 'мои-заметки.txt'))).toBe('важное\n');
  });

  it('ignored-файл пользователя в созданном worktree не удаляется при компенсации', async () => {
    const own = stand();
    own.commit({ '.gitignore': 'local-data.txt\n' }, 'Ignore-правило');
    const storage = openStorage(own);
    const adapter = createGitAdapter({
      store: storage.gitOperationStore,
      faultInjector: point => {
        if (point === 'create_after_worktree') writeFileSync(join(gitDir(own), 'config.lock'), '');
        // git status без --ignored считает такое дерево чистым, а worktree remove без --force удалил бы файл.
        if (point === 'create_before_cleanup') {
          writeFileSync(join(workspaceOf(own), 'local-data.txt'), 'локальные данные\n');
          expect(own.run(workspaceOf(own), 'status', '--porcelain=v1', '--untracked-files=all')).toBe('');
        }
      },
    });
    await expect(adapter.createWorkspace(request(own))).rejects.toMatchObject({ code: 'git_failed' });
    expect(own.read(join(workspaceOf(own), 'local-data.txt'))).toBe('локальные данные\n');
    expect(refsOf(own).split('\n').sort()).toEqual(['refs/heads/vs/s1', 'refs/vibestudio/s1/base']);
    expect(await operationOf(storage.gitOperationStore)).toMatchObject({
      cleanupError: { code: 'dirty_tree', files: ['local-data.txt'] }, creation: { cleanup: 'preserved' },
    });
  });

  it('новые коммиты пользователя в созданной ветке не теряются при компенсации', async () => {
    const own = stand();
    const storage = openStorage(own);
    const adapter = createGitAdapter({
      store: storage.gitOperationStore,
      faultInjector: point => {
        if (point === 'create_after_worktree') writeFileSync(join(gitDir(own), 'config.lock'), '');
        if (point === 'create_before_cleanup') {
          writeFileSync(join(workspaceOf(own), 'работа.txt'), 'коммит\n');
          own.run(workspaceOf(own), 'add', 'работа.txt');
          own.run(workspaceOf(own), 'commit', '-m', 'Работа пользователя');
        }
      },
    });
    await expect(adapter.createWorkspace(request(own))).rejects.toMatchObject({ code: 'git_failed' });
    expect(own.run(workspaceOf(own), 'log', '-1', '--format=%s')).toBe('Работа пользователя');
    // Дерево чистое, но HEAD ушёл с базового коммита: это изменение рабочей области, а не «грязные» файлы.
    expect(await operationOf(storage.gitOperationStore)).toMatchObject({ creation: { cleanup: 'preserved' }, cleanupError: { code: 'invalid_workspace' } });
    expect(refsOf(own).split('\n').sort()).toEqual(['refs/heads/vs/s1', 'refs/vibestudio/s1/base']);
  });

  it('сбой самой компенсации сохраняет обе ошибки и оставляет ресурсы для ручной сверки', async () => {
    const own = stand();
    const storage = openStorage(own);
    const adapter = createGitAdapter({
      store: storage.gitOperationStore,
      faultInjector: point => {
        if (point === 'create_after_worktree') writeFileSync(join(gitDir(own), 'config.lock'), '');
        // Заблокированный worktree git удалить не даёт: настоящий отказ cleanup.
        if (point === 'create_before_cleanup') own.run(own.project, 'worktree', 'lock', '--reason', 'тест', workspaceOf(own));
      },
    });
    await expect(adapter.createWorkspace(request(own))).rejects.toMatchObject({ code: 'git_failed' });

    const record = await operationOf(storage.gitOperationStore);
    expect(record.error).toMatchObject({ code: 'git_failed' });
    expect(record.cleanupError).toMatchObject({ code: 'git_failed' });
    expect(record.cleanupError?.message).toMatch(/locked|заблок|git/i);
    expect(record.creation?.cleanup).toBe('failed');
    expect(refsOf(own).split('\n').sort()).toEqual(['refs/heads/vs/s1', 'refs/vibestudio/s1/base']);
    expect(existsSync(workspaceOf(own))).toBe(true);
    own.run(own.project, 'worktree', 'unlock', workspaceOf(own));
  });

  it('чужие ресурсы не удаляются: существующая ветка сессии и существующая точка возврата', async () => {
    const own = stand();
    const storage = openStorage(own);
    const adapter = createGitAdapter({ store: storage.gitOperationStore });

    own.run(own.project, 'branch', 'vs/s1', 'main');
    const branchSha = own.run(own.project, 'rev-parse', 'refs/heads/vs/s1');
    await expect(adapter.createWorkspace(request(own))).rejects.toMatchObject({ code: 'git_failed' });
    expect(own.run(own.project, 'rev-parse', 'refs/heads/vs/s1')).toBe(branchSha);
    expect(refsOf(own)).toBe('refs/heads/vs/s1');
    expect(await operationOf(storage.gitOperationStore)).toMatchObject({ creation: { baseRefCreated: true, branchCreated: false, cleanup: 'completed' } });
    own.run(own.project, 'branch', '-D', 'vs/s1');

    own.run(own.project, 'update-ref', 'refs/vibestudio/s2/base', branchSha);
    await expect(adapter.createWorkspace(request(own, { requestId: 'create-2', sessionId: 's2', branch: 'vs/s2', workspacePath: workspaceOf(own, 's2') })))
      .rejects.toMatchObject({ code: 'request_conflict' });
    expect(own.run(own.project, 'rev-parse', 'refs/vibestudio/s2/base')).toBe(branchSha);
    expect(await operationOf(storage.gitOperationStore, 'create-2')).toMatchObject({ creation: { baseRefCreated: false, cleanup: 'completed' } });
  });

  it('ресурс, появившийся во время неподтверждённой команды, не присваивается и не удаляется', async () => {
    const own = stand();
    const storage = openStorage(own);
    const adapter = createGitAdapter({
      store: storage.gitOperationStore,
      // Другой процесс создаёт ветку сессии между проверкой и нашей командой worktree add.
      faultInjector: point => { if (point === 'create_after_base_ref') own.run(own.project, 'branch', 'vs/s1', 'main'); },
    });
    await expect(adapter.createWorkspace(request(own))).rejects.toMatchObject({ code: 'git_failed' });

    // Чужая ветка осталась, а точка возврата, на которую она может опираться, не удалена.
    expect(refsOf(own).split('\n').sort()).toEqual(['refs/heads/vs/s1', 'refs/vibestudio/s1/base']);
    expect(await operationOf(storage.gitOperationStore)).toMatchObject({
      error: { code: 'git_failed' }, cleanupError: { code: 'invalid_workspace' },
      creation: { baseRefCreated: true, branchCreated: false, worktreeCreated: false, cleanup: 'preserved' },
    });
    await expect(adapter.createWorkspace(request(own))).rejects.toMatchObject({ code: 'operation_in_progress' });
  });

  it('worktree удаляется только если ветка и HEAD остались созданными операцией', async () => {
    const own = stand();
    const storage = openStorage(own);
    const adapter = createGitAdapter({
      store: storage.gitOperationStore,
      faultInjector: point => {
        if (point === 'create_after_worktree') writeFileSync(join(gitDir(own), 'config.lock'), '');
        // Рабочая область переключена на другую ветку без новых коммитов и без изменённых файлов.
        if (point === 'create_before_cleanup') own.run(workspaceOf(own), 'checkout', '-q', '-b', 'vs/другая');
      },
    });
    await expect(adapter.createWorkspace(request(own))).rejects.toMatchObject({ code: 'git_failed' });
    expect(own.run(workspaceOf(own), 'branch', '--show-current')).toBe('vs/другая');
    expect(refsOf(own).split('\n').sort()).toEqual(['refs/heads/vs/s1', 'refs/heads/vs/другая', 'refs/vibestudio/s1/base']);
    expect(await operationOf(storage.gitOperationStore)).toMatchObject({
      cleanupError: { code: 'invalid_workspace' }, creation: { cleanup: 'preserved', worktreeCreated: true },
    });
  });

  it('имитация падения процесса не компенсируется: запись остаётся, повтор не выполняет скрытых действий', async () => {
    const own = stand();
    const storage = openStorage(own);
    class Crash extends Error {}
    const adapter = createGitAdapter({
      store: storage.gitOperationStore,
      faultInjector: point => { if (point === 'create_after_worktree') throw new Crash('процесс завершён'); },
    });
    await expect(adapter.createWorkspace(request(own))).rejects.toBeInstanceOf(Crash);
    expect(existsSync(workspaceOf(own))).toBe(true);
    expect(await operationOf(storage.gitOperationStore)).toMatchObject({
      phase: 'intent_saved', creation: { baseRefCreated: true, branchCreated: true, worktreeCreated: true, cleanup: 'not_needed' },
    });
    const refs = refsOf(own);
    storage.close();
    const next = openStorage(own);
    await expect(createGitAdapter({ store: next.gitOperationStore }).createWorkspace(request(own))).rejects.toMatchObject({ code: 'operation_in_progress' });
    expect(refsOf(own)).toBe(refs);
  });

  it.each([
    ['create_after_intent', { baseRefCreated: false, branchCreated: false, worktreeCreated: false }],
    ['create_after_base_ref', { baseRefCreated: true, branchCreated: false, worktreeCreated: false }],
    ['create_after_worktree', { baseRefCreated: true, branchCreated: true, worktreeCreated: true }],
  ] as const)('SIGKILL процесса на %s: новый процесс видит намерение и признаки, ничего не удаляя и не повторяя', (point, flags) => {
    const own = stand();
    const script = fileURLToPath(new URL('./helpers/git-crash-child.ts', import.meta.url));
    const child = spawnSync(process.execPath, ['--experimental-transform-types', script, dbPathOf(own), own.project, workspaceOf(own), 's1', point], {
      encoding: 'utf8', timeout: 30_000,
    });
    expect(child.signal, child.stderr).toBe('SIGKILL');

    const reopened = openStorage(own);
    return operationOf(reopened.gitOperationStore, 'create-crash').then(async record => {
      expect(record).toMatchObject({ kind: 'create', phase: 'intent_saved', creation: { ...flags, cleanup: 'not_needed' } });
      const refs = refsOf(own);
      const adapter = createGitAdapter({ store: reopened.gitOperationStore });
      await expect(adapter.createWorkspace({ ...request(own), requestId: 'create-crash' })).rejects.toMatchObject({ code: 'operation_in_progress' });
      // Новая операция для той же сессии не затирает точку возврата, оставленную неопределённой операцией.
      if (flags.baseRefCreated) {
        await expect(adapter.createWorkspace(request(own, { requestId: 'create-new' }))).rejects.toMatchObject({ code: 'request_conflict' });
      }
      expect(refsOf(own)).toBe(refs);
    });
  });

  it('отказ хранилища до первого эффекта не оставляет следов; отказ SQLite позже не мешает убрать своё', async () => {
    const own = stand();
    const dead: GitOperationStore = {
      get: async () => undefined, list: async () => [],
      save: async () => { throw new Error('хранилище недоступно'); },
    };
    await expect(createGitAdapter({ store: dead }).createWorkspace(request(own))).rejects.toThrowError('хранилище недоступно');
    expectPristine(own);

    // SQLite отказывает на третьей записи Git (после worktree add): все признаки владения уже в памяти операции.
    let saves = 0;
    const storage = openStorage(own, (point, context) => {
      if (point === 'before_commit' && context.operation === 'git_operation' && ++saves === 3) throw new Error('диск недоступен');
    });
    await expect(createGitAdapter({ store: storage.gitOperationStore }).createWorkspace(request(own, { requestId: 'create-2' })))
      .rejects.toMatchObject({ code: 'store_failed' });
    expectPristine(own);
    // Хранилище больше не принимает записей, значит и новых эффектов Git нет.
    await expect(createGitAdapter({ store: storage.gitOperationStore }).createWorkspace(request(own, { requestId: 'create-3' })))
      .rejects.toMatchObject({ code: 'store_failed' });
    expectPristine(own);
  });
});

function rmLock(own: WorkspaceStand): void {
  rmSync(join(gitDir(own), 'config.lock'), { force: true });
}
