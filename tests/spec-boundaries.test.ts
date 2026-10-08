import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CreateGitAdapter, GitBoundaryAdapter } from './contracts/git-boundaries';

const root = fileURLToPath(new URL('../', import.meta.url));
const implementation = join(root, 'src/adapters/git/index.ts');
const gitEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Spec Test',
  GIT_AUTHOR_EMAIL: 'spec@example.invalid',
  GIT_COMMITTER_NAME: 'Spec Test',
  GIT_COMMITTER_EMAIL: 'spec@example.invalid',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function adapter(): Promise<GitBoundaryAdapter> {
  // Отдельный assertion: отсутствие реализации не маскируется ошибкой импорта suite.
  expect(existsSync(implementation),
    'RED_MISSING_IMPLEMENTATION: требуется src/adapters/git/index.ts; поведение ещё не проверено',
  ).toBe(true);
  const module = await import(/* @vite-ignore */ pathToFileURL(implementation).href) as {
    createGitAdapter: CreateGitAdapter;
  };
  expect(module.createGitAdapter, 'Адаптер должен экспортировать createGitAdapter').toBeTypeOf('function');
  return module.createGitAdapter();
}

let sandbox: string;
let project: string;
let workspace: string;

async function initRepository(path: string, commit = true): Promise<void> {
  await mkdir(path, { recursive: true });
  git(path, 'init', '--initial-branch=main');
  if (commit) {
    await writeFile(join(path, 'tracked.txt'), 'base\n');
    git(path, 'add', 'tracked.txt');
    git(path, 'commit', '-m', 'Базовый коммит');
  }
}

function snapshot(path: string) {
  return {
    head: git(path, 'rev-parse', 'HEAD'),
    status: git(path, 'status', '--porcelain=v1', '--untracked-files=all'),
    diff: git(path, 'diff', 'HEAD'),
  };
}

function createRequest(baseRef = 'main') {
  return { projectPath: project, workspacePath: workspace, sessionId: 'boundary',
    branch: 'vs/boundary-task', baseRef };
}

function applyRequest(baseRef = 'main') {
  return { projectPath: project, workspacePath: workspace, baseRef };
}

async function committedWorkspace(): Promise<void> {
  git(project, 'worktree', 'add', '-b', 'vs/boundary-task', workspace, 'main');
  await writeFile(join(workspace, 'session.txt'), 'session\n');
  git(workspace, 'add', 'session.txt');
  git(workspace, 'commit', '-m', 'Изменение сессии');
}

beforeEach(async () => {
  await mkdir(join(root, '.tmp'), { recursive: true });
  sandbox = await mkdtemp(join(root, '.tmp/git-boundaries-'));
  project = join(sandbox, 'project with spaces');
  workspace = join(sandbox, 'session worktree');
});

afterEach(async () => {
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
});

describe('Этап 2: крайние случаи Git', () => {
  it('S2-B01: каталог без Git отклоняется без автоматического git init', async () => {
    await mkdir(project);
    await writeFile(join(project, 'user.txt'), 'keep\n');
    const sut = await adapter();
    await expect(sut.inspectRepository(project)).rejects.toMatchObject({ code: 'not_git_repository' });
    expect(existsSync(join(project, '.git'))).toBe(false);
    expect(await readFile(join(project, 'user.txt'), 'utf8')).toBe('keep\n');
  });

  it('S2-B02: репозиторий без коммитов не допускает запуск сессии', async () => {
    await initRepository(project, false);
    const sut = await adapter();
    await expect(sut.createWorkspace(createRequest())).rejects.toMatchObject({ code: 'no_commits' });
    expect(existsSync(workspace)).toBe(false);
    expect(git(project, 'for-each-ref', '--format=%(refname)', 'refs/heads/vs/boundary-task')).toBe('');
  });

  it('S2-B03: грязный старт использует HEAD и сохраняет изменения основной копии', async () => {
    await initRepository(project);
    await writeFile(join(project, 'tracked.txt'), 'staged\n');
    git(project, 'add', 'tracked.txt');
    await writeFile(join(project, 'tracked.txt'), 'unstaged\n');
    await writeFile(join(project, 'untracked.txt'), 'private\n');
    const before = snapshot(project);
    const sut = await adapter();
    const result = await sut.createWorkspace(createRequest());
    expect(result.baseSha).toBe(before.head);
    expect(result.warnings).toContain('dirty_tree');
    expect(await readFile(join(workspace, 'tracked.txt'), 'utf8')).toBe('base\n');
    expect(existsSync(join(workspace, 'untracked.txt'))).toBe(false);
    expect(snapshot(project)).toEqual(before);
    expect(await readFile(join(project, 'untracked.txt'), 'utf8')).toBe('private\n');
    expect(git(project, 'show', ':tracked.txt')).toBe('staged');
  });

  it.each(['staged', 'unstaged', 'untracked'] as const)(
    'S2-B04/%s: применение блокируется с перечнем грязных файлов', async (kind) => {
      await initRepository(project);
      await committedWorkspace();
      const file = kind === 'untracked' ? 'untracked.txt' : 'tracked.txt';
      await writeFile(join(project, file), 'local changes\n');
      if (kind === 'staged') git(project, 'add', file);
      const before = snapshot(project);
      const sut = await adapter();
      await expect(sut.applyWorkspace(applyRequest())).rejects.toMatchObject({
        code: 'dirty_tree', files: expect.arrayContaining([file]),
      });
      expect(snapshot(project)).toEqual(before);
      expect(await readFile(join(project, file), 'utf8')).toBe('local changes\n');
      expect(existsSync(join(project, 'session.txt'))).toBe(false);
    },
  );

  it('S2-B05: detached HEAD разрешает worktree от SHA и оставление ветки', async () => {
    await initRepository(project);
    git(project, 'checkout', '--detach');
    const before = snapshot(project);
    const sut = await adapter();
    const result = await sut.createWorkspace(createRequest(before.head));
    expect(result.baseSha).toBe(before.head);
    expect(result.applyMode).toBe('keep_branch');
    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(before.head);
    expect(git(workspace, 'branch', '--show-current')).toBe('vs/boundary-task');
    expect(snapshot(project)).toEqual(before);
    expect(git(project, 'branch', '--show-current')).toBe('');
  });

  it('S2-B06: применение при detached HEAD отклоняется без потери ветки', async () => {
    await initRepository(project);
    await committedWorkspace();
    git(project, 'checkout', '--detach');
    const before = snapshot(project);
    const sessionHead = git(workspace, 'rev-parse', 'HEAD');
    const sut = await adapter();
    await expect(sut.applyWorkspace(applyRequest())).rejects.toMatchObject({ code: 'detached_head' });
    expect(snapshot(project)).toEqual(before);
    expect(git(workspace, 'rev-parse', 'vs/boundary-task')).toBe(sessionHead);
  });

  it('S2-B07: исчезнувшая базовая ветка требует выбора другой цели', async () => {
    await initRepository(project);
    await committedWorkspace();
    git(project, 'checkout', '-b', 'replacement');
    git(project, 'branch', '-D', 'main');
    const before = snapshot(project);
    const sessionHead = git(workspace, 'rev-parse', 'HEAD');
    const sut = await adapter();
    await expect(sut.applyWorkspace(applyRequest())).rejects.toMatchObject({ code: 'base_branch_missing' });
    expect(snapshot(project)).toEqual(before);
    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(sessionHead);
  });

  it('S2-B08: push воссоздаёт удалённую remote-ветку', async () => {
    await initRepository(project);
    await committedWorkspace();
    const remote = join(sandbox, 'remote.git');
    git(sandbox, 'init', '--bare', remote);
    git(workspace, 'remote', 'add', 'origin', remote);
    git(workspace, 'push', 'origin', 'vs/boundary-task');
    git(sandbox, '--git-dir', remote, 'update-ref', '-d', 'refs/heads/vs/boundary-task');
    const sut = await adapter();
    await sut.pushWorkspace({ workspacePath: workspace, remote: 'origin', branch: 'vs/boundary-task' });
    expect(git(sandbox, '--git-dir', remote, 'rev-parse', 'refs/heads/vs/boundary-task'))
      .toBe(git(workspace, 'rev-parse', 'HEAD'));
  });

  it('S2-B09: расходящиеся ветки не перезаписываются force-push', async () => {
    await initRepository(project);
    await committedWorkspace();
    const remote = join(sandbox, 'remote.git');
    git(sandbox, 'init', '--bare', remote);
    git(workspace, 'remote', 'add', 'origin', remote);
    git(workspace, 'push', 'origin', 'vs/boundary-task');
    const other = join(sandbox, 'other');
    git(sandbox, 'clone', '--branch', 'vs/boundary-task', remote, other);
    await writeFile(join(other, 'other.txt'), 'remote changes\n');
    git(other, 'add', 'other.txt');
    git(other, 'commit', '-m', 'Изменение удалённой ветки');
    git(other, 'push', 'origin', 'vs/boundary-task');
    const remoteHead = git(other, 'rev-parse', 'HEAD');
    await writeFile(join(workspace, 'local.txt'), 'local changes\n');
    git(workspace, 'add', 'local.txt');
    git(workspace, 'commit', '-m', 'Расходящаяся локальная ветка');
    const localHead = git(workspace, 'rev-parse', 'HEAD');
    const sut = await adapter();
    await expect(sut.pushWorkspace({ workspacePath: workspace, remote: 'origin', branch: 'vs/boundary-task' }))
      .rejects.toMatchObject({ code: 'non_fast_forward' });
    expect(git(sandbox, '--git-dir', remote, 'rev-parse', 'refs/heads/vs/boundary-task')).toBe(remoteHead);
    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(localHead);
  });

  it('S2-B10: настоящий подмодуль вызывает предупреждение о неподдерживаемом формате', async () => {
    await initRepository(project);
    const dependency = join(sandbox, 'dependency');
    await initRepository(dependency);
    git(project, '-c', 'protocol.file.allow=always', 'submodule', 'add', dependency, 'dependency');
    git(project, 'commit', '-am', 'Добавление подмодуля');
    const before = snapshot(project);
    const sut = await adapter();
    expect((await sut.inspectRepository(project)).warnings).toContain('submodules_unsupported');
    expect(snapshot(project)).toEqual(before);
  });

  it('S2-B11: Git LFS в атрибутах вызывает предупреждение', async () => {
    await initRepository(project);
    await writeFile(join(project, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n');
    git(project, 'add', '.gitattributes');
    git(project, 'commit', '-m', 'Настройка LFS');
    const before = snapshot(project);
    const sut = await adapter();
    expect((await sut.inspectRepository(project)).warnings).toContain('lfs_unsupported');
    expect(snapshot(project)).toEqual(before);
  });

  it('S2-B12: конфликт остаётся внутри worktree, основная копия не меняется', async () => {
    await initRepository(project);
    git(project, 'worktree', 'add', '-b', 'vs/boundary-task', workspace, 'main');
    await writeFile(join(workspace, 'tracked.txt'), 'session version\n');
    git(workspace, 'commit', '-am', 'Версия сессии');
    await writeFile(join(project, 'tracked.txt'), 'base version\n');
    git(project, 'commit', '-am', 'Версия базовой ветки');
    const before = snapshot(project);
    const sut = await adapter();
    await expect(sut.applyWorkspace(applyRequest())).rejects.toMatchObject({ code: 'merge_conflict' });
    expect(snapshot(project)).toEqual(before);
    expect(await readFile(join(project, 'tracked.txt'), 'utf8')).toBe('base version\n');
    expect(git(workspace, 'diff', '--name-only', '--diff-filter=U')).toBe('tracked.txt');
  });
});
