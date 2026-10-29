import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createProductionComposition } from '../../src/main/composition.ts';
import { createIpcHandlers } from '../../src/main/ipc.ts';
import { openEngineStand } from '../helpers/p5-engine.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const clean of cleanup.splice(0)) await clean(); });

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'solo-select-project-')));
  const project = join(root, 'Мой проект с пробелами'), data = join(root, 'data');
  await mkdir(project);
  let app = await createProductionComposition(data);
  cleanup.push(async () => { await app.engine.shutdown(); app.close(); await rm(root, { recursive: true, force: true }); });
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
    { cwd: project, stdio: 'pipe', timeout: 10_000 });
  async function repository(manifest = '{"private":true}') {
    git('init', '-b', 'main');
    await writeFile(join(project, 'package.json'), manifest);
    git('add', '.');
    git('-c', 'user.name=Selection Fixture', '-c', 'user.email=selection@example.invalid', 'commit', '-m', 'fixture');
  }
  const source = {};
  const ipc = (choose: () => Promise<string | null>) => createIpcHandlers({ engine: app.engine, authorize: origin => origin === source, selectProject: choose });
  return { root, project, git, repository, source, ipc,
    restart: async () => { await app.engine.shutdown(); app.close(); app = await createProductionComposition(data); } };
}

it.each([
  ['plain', 'not_git_repository', 'корневую папку Git-репозитория'],
  ['empty', 'no_commits', 'коммит'],
  ['nested', 'not_git_repository', 'корневую папку Git-репозитория'],
  ['detached', 'detached_head', 'ветку'],
  ['manifest', 'invalid_project', 'package.json'],
  ['missing', 'invalid_project', 'каталог'],
  ['corrupt_index', 'git_failed', 'целостность репозитория'],
] as const)('выбор проекта: %s возвращает причину и сохраняет её при повторе/restart', async (mode, code, message) => {
  const f = await fixture();
  let path = f.project;
  if (mode === 'empty') f.git('init', '-b', 'main');
  else if (!['plain', 'missing'].includes(mode)) await f.repository(mode === 'manifest' ? '{ SYNTHETIC_SECRET' : undefined);
  if (mode === 'nested') { path = join(f.project, 'nested'); await mkdir(path); }
  if (mode === 'missing') path = join(f.root, 'нет папки');
  if (mode === 'detached') f.git('checkout', '--detach');
  if (mode === 'corrupt_index') await writeFile(join(f.project, '.git', 'index'), 'SYNTHETIC_SECRET');
  const choose = vi.fn(async () => path), request = { requestId: randomUUID() };
  const result = await f.ipc(choose).selectProject(f.source, request);
  expect(result).toMatchObject({ ok: false, error: { code, message: expect.stringContaining(message) } });
  expect(JSON.stringify(result)).not.toContain('SYNTHETIC_SECRET');
  expect(await f.ipc(choose).listProjects(f.source, {})).toEqual({ ok: true, value: [] });
  expect(await f.ipc(choose).selectProject(f.source, request)).toEqual(result);
  await f.restart();
  expect(await f.ipc(choose).selectProject(f.source, request)).toEqual(result);
  expect(choose).toHaveBeenCalledTimes(1);
});

it.each([false, true])('ошибка записи SQLite при выборе (cancel=%s) не маскируется отказом проекта', async cancelled => {
  const root = await mkdtemp(join(tmpdir(), 'solo-select-write-'));
  const f = openEngineStand(root, { storage: { faultInjector: (point, context) => {
    if (point === 'before_commit' && context.operation === 'commit') throw new Error('SYNTHETIC_SECRET write failure');
  } } });
  cleanup.push(async () => { await f.close(); await rm(root, { recursive: true, force: true }); });
  await f.engine.recover();
  const choose = vi.fn(async () => cancelled ? null : f.projectPath);
  const ipc = createIpcHandlers({ engine: f.engine, authorize: source => source === f.source, selectProject: choose });
  const result = await ipc.selectProject(f.source, { requestId: randomUUID() });
  expect(result).toMatchObject({ ok: false, error: { code: 'store_failed' } });
  expect(JSON.stringify(result)).not.toContain('SYNTHETIC_SECRET');
  expect(f.store.failed).toBe(true);
  expect(f.store.listProjects()).toEqual([]);
  expect(await ipc.selectProject(f.source, { requestId: randomUUID() })).toMatchObject({ ok: false, error: { code: 'store_failed' } });
  expect(choose).toHaveBeenCalledTimes(1);
});

it('после отказа новый выбор сохраняет настоящий проект, symlink не создаёт дубликат', async () => {
  const f = await fixture();
  expect(await f.ipc(async () => f.project).selectProject(f.source, { requestId: randomUUID() })).toMatchObject({ ok: false });
  await f.repository();
  const request = { requestId: randomUUID() }, choose = vi.fn(async () => f.project);
  const selected = await f.ipc(choose).selectProject(f.source, request);
  expect(selected).toMatchObject({ ok: true, value: { name: basename(f.project), setup: null, configVersion: 1 } });
  const link = join(f.root, 'ссылка'); await symlink(f.project, link);
  expect(await f.ipc(async () => link).selectProject(f.source, { requestId: randomUUID() })).toEqual(selected);
  await f.restart();
  expect(await f.ipc(choose).selectProject(f.source, request)).toEqual(selected);
  expect(choose).toHaveBeenCalledTimes(1);
  expect(await f.ipc(choose).listProjects(f.source, {})).toMatchObject({ ok: true, value: [selected.ok ? selected.value : undefined] });
});

it('отказ системного выбора имеет устойчивый безопасный ответ без текста исключения', async () => {
  const f = await fixture();
  const choose = vi.fn(async (): Promise<string> => { throw new Error('SYNTHETIC_SECRET dialog failure'); });
  const request = { requestId: randomUUID() };
  const result = await f.ipc(choose).selectProject(f.source, request);
  expect(result).toMatchObject({ ok: false, error: { code: 'workspace_failed', message: expect.stringContaining('окно выбора') } });
  expect(JSON.stringify(result)).not.toContain('SYNTHETIC_SECRET');
  expect(await f.ipc(choose).selectProject(f.source, request)).toEqual(result);
  expect(choose).toHaveBeenCalledTimes(1);
});
