import { appendFileSync, chmodSync, existsSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkspaceFiles, WorkspaceFilesError, type WorkspaceFilesOptions } from '../../src/adapters/workspace-files/index.ts';
import { GitError } from '../../src/core/ports/git.ts';
import { WorkspaceStand } from './stand.ts';

const stands: WorkspaceStand[] = [];
afterEach(() => { for (const stand of stands.splice(0)) stand.cleanup(); });

function stand(): WorkspaceStand {
  const own = new WorkspaceStand();
  stands.push(own);
  return own;
}

function filesFor(own: WorkspaceStand, extra: Partial<WorkspaceFilesOptions> = {}) {
  return createWorkspaceFiles({ workspacesRoot: own.workspacesRoot, git: own.git, ...extra });
}

const SECRET = 'TOPSECRET-значение-из-env';

/** Проект с ignore-правилами для .env и локальных конфигураций, как в обычном репозитории. */
function envProject(own: WorkspaceStand): void {
  own.commit({ '.gitignore': '.env\n*.local\ndir1/*.env\ndir2/*.env\nsub/*.env\n', 'tracked.txt': 'tracked\n', 'dir1/keep.txt': 'k\n', 'dir2/keep.txt': 'k\n' });
  own.write(join(own.project, '.env'), `TOKEN=${SECRET}\n`);
  own.write(join(own.project, 'app.local'), 'local\n');
}

async function failure(action: () => Promise<unknown>): Promise<WorkspaceFilesError> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceFilesError);
    return error as WorkspaceFilesError;
  }
  throw new Error('Ожидался отказ WorkspaceFiles.');
}

describe('WorkspaceFiles.inspectProject', () => {
  it('определяет setup из закоммиченного package.json и не копирует файлы по умолчанию', async () => {
    const own = stand();
    own.commit({ 'package.json': JSON.stringify({ name: 'p', scripts: { setup: 'node scripts/setup.js', test: 'x' } }) });
    own.write(join(own.project, 'package.json'), JSON.stringify({ name: 'p', scripts: {} }));
    const record = await filesFor(own).inspectProject(own.project);
    expect(record).toMatchObject({
      canonicalPath: own.project, name: 'project with spaces', defaultBranch: 'main', configVersion: 1,
      config: { setup: { kind: 'npm-script', script: 'setup', args: [] }, copyFiles: [], setupTimeoutMs: 300_000 },
    });
  });

  it('setup не настроен без package.json или scripts.setup', async () => {
    const own = stand();
    own.commit({ 'README.md': 'x\n' });
    expect((await filesFor(own).inspectProject(own.project)).config.setup).toBeNull();
    own.commit({ 'package.json': JSON.stringify({ scripts: { test: 'x' } }) });
    expect((await filesFor(own).inspectProject(own.project)).config.setup).toBeNull();
    own.commit({ 'package.json': JSON.stringify({ scripts: { setup: '   ' } }) });
    expect((await filesFor(own).inspectProject(own.project)).config.setup).toBeNull();
  });

  it('повреждённый package.json — типизированный отказ, а не молчаливое отсутствие setup', async () => {
    const own = stand();
    own.commit({ 'package.json': '{ нет' });
    expect((await failure(() => filesFor(own).inspectProject(own.project))).code).toBe('invalid_project');
  });

  it('канонизирует путь и отклоняет не-каталоги, не-репозитории, пустую историю и отсоединённый HEAD', async () => {
    const own = stand();
    await expect(filesFor(own).inspectProject(own.project)).rejects.toMatchObject({ code: 'no_commits' });
    own.commit({ 'a.txt': 'a\n' });
    const link = join(own.root, 'link-to-project');
    symlinkSync(own.project, link);
    expect((await filesFor(own).inspectProject(link)).canonicalPath).toBe(own.project);

    expect((await failure(() => filesFor(own).inspectProject(join(own.root, 'нет-такого')))).code).toBe('invalid_project');
    expect((await failure(() => filesFor(own).inspectProject(join(own.project, 'a.txt')))).code).toBe('invalid_project');
    const plain = join(own.root, 'plain');
    mkdirSync(plain);
    await expect(filesFor(own).inspectProject(plain)).rejects.toMatchObject({ code: 'not_git_repository' });

    own.run(own.project, 'checkout', '--detach');
    await expect(filesFor(own).inspectProject(own.project)).rejects.toBeInstanceOf(GitError);
    await expect(filesFor(own).inspectProject(own.project)).rejects.toMatchObject({ code: 'detached_head' });
  });
});

describe('WorkspaceFiles.allocatePath', () => {
  it('отдаёт путь внутри корня приложения и отклоняет небезопасные идентификаторы', () => {
    const own = stand();
    const files = filesFor(own);
    expect(files.allocatePath('session-1_a')).toBe(join(own.workspacesRoot, 'session-1_a'));
    for (const bad of ['', '..', '../x', 'a/b', '.hidden', 'a b', 'a\0b', '-flag', 'a:b']) {
      expect(() => files.allocatePath(bad), bad).toThrowError(expect.objectContaining({ code: 'invalid_session_id' }));
    }
    expect(() => createWorkspaceFiles({ workspacesRoot: 'относительный/путь', git: own.git }))
      .toThrowError(expect.objectContaining({ code: 'unsafe_workspace_path' }));
  });
});

describe('WorkspaceFiles.copyFiles', () => {
  it('без явных правил ничего не копирует, в том числе .env', async () => {
    const own = stand();
    envProject(own);
    const workspace = await own.createWorkspace();
    await filesFor(own).copyFiles(own.projectRecord([]), workspace);
    expect(existsSync(join(workspace.path, '.env'))).toBe(false);
    expect(existsSync(join(workspace.path, 'app.local'))).toBe(false);
  });

  it('копирует только перечисленные ignored-файлы без изменения Git-состояния workspace', async () => {
    const own = stand();
    envProject(own);
    own.write(join(own.project, 'sub/deep.env'), 'DEEP=1\n');
    const workspace = await own.createWorkspace();
    await filesFor(own).copyFiles(own.projectRecord(['.env', 'sub/deep.env']), workspace);
    expect(own.read(join(workspace.path, '.env'))).toBe(`TOKEN=${SECRET}\n`);
    expect(own.read(join(workspace.path, 'sub/deep.env'))).toBe('DEEP=1\n');
    expect(existsSync(join(workspace.path, 'app.local'))).toBe(false);
    expect(statSync(join(workspace.path, '.env')).mode & 0o077).toBe(0);
    expect(own.run(workspace.path, 'status', '--porcelain=v1', '--untracked-files=all')).toBe('');
    expect(own.run(workspace.path, 'ls-files')).not.toMatch(/\.env/);
  });

  it('отказывает для tracked, не-ignored файлов и существующего назначения, ничего не перезаписывая', async () => {
    const own = stand();
    envProject(own);
    own.write(join(own.project, 'plain.txt'), 'untracked, not ignored\n');
    const workspace = await own.createWorkspace();
    const files = filesFor(own);

    expect((await failure(() => files.copyFiles(own.projectRecord(['tracked.txt']), workspace))).code).toBe('copy_tracked');
    expect((await failure(() => files.copyFiles(own.projectRecord(['plain.txt']), workspace))).code).toBe('copy_not_ignored');
    expect(existsSync(join(workspace.path, 'plain.txt'))).toBe(false);

    own.write(join(workspace.path, '.env'), 'ПОЛЬЗОВАТЕЛЬСКОЕ\n');
    const collision = await failure(() => files.copyFiles(own.projectRecord(['.env']), workspace));
    expect(collision.code).toBe('copy_collision');
    expect(own.read(join(workspace.path, '.env'))).toBe('ПОЛЬЗОВАТЕЛЬСКОЕ\n');
    expect(own.read(join(workspace.path, 'tracked.txt'))).toBe('tracked\n');
  });

  it('сбой Git при проверке «tracked» не считается ответом «не отслеживается»: копирование не начинается', async () => {
    const own = stand();
    envProject(own);
    const workspace = await own.createWorkspace();
    // Индекс worktree повреждён: ls-files завершается ошибкой, а не кодом 1.
    const index = own.run(workspace.path, 'rev-parse', '--absolute-git-dir');
    writeFileSync(join(index, 'index'), 'повреждённый индекс');
    const error = await failure(() => filesFor(own).copyFiles(own.projectRecord(['.env']), workspace));
    expect(error.code).toBe('copy_failed');
    expect(existsSync(join(workspace.path, '.env'))).toBe(false);
  });

  it('проверяет реальные пути: symlink-файл, symlink-каталог и выход за корень проекта', async () => {
    const own = stand();
    envProject(own);
    own.write(join(own.root, 'outside.local'), 'outside\n');
    symlinkSync(join(own.root, 'outside.local'), join(own.project, 'link.local'));
    mkdirSync(join(own.root, 'outside-dir'));
    own.write(join(own.root, 'outside-dir/x.local'), 'x\n');
    symlinkSync(join(own.root, 'outside-dir'), join(own.project, 'linkdir'));
    const workspace = await own.createWorkspace();
    const files = filesFor(own);

    expect((await failure(() => files.copyFiles(own.projectRecord(['link.local']), workspace))).code).toBe('copy_symlink');
    expect((await failure(() => files.copyFiles(own.projectRecord(['linkdir/x.local']), workspace))).code).toBe('copy_symlink');
    for (const bad of ['../outside.local', 'a/../app.local', '/etc/hosts', './app.local', 'a//b', 'dir1/', 'C:\\x', '*.local', 'app.loc?l']) {
      expect((await failure(() => files.copyFiles(own.projectRecord([bad]), workspace))).code, bad).toBe('invalid_copy_rule');
    }
    expect(existsSync(join(workspace.path, 'link.local'))).toBe(false);
    expect(existsSync(join(workspace.path, 'linkdir'))).toBe(false);
  });

  it('служебные каталоги и node_modules не копируются; общий изменяемый node_modules не создаётся', async () => {
    const own = stand();
    envProject(own);
    mkdirSync(join(own.project, 'node_modules/pkg'), { recursive: true });
    own.write(join(own.project, 'node_modules/pkg/index.js'), 'x\n');
    const workspace = await own.createWorkspace();
    for (const rule of ['node_modules/pkg/index.js', 'sub/Node_Modules/x', '.git/config', '.GIT/HEAD']) {
      expect((await failure(() => filesFor(own).copyFiles(own.projectRecord([rule]), workspace))).code, rule).toBe('copy_forbidden_path');
    }
    expect(existsSync(join(workspace.path, 'node_modules'))).toBe(false);
  });

  it('повторы, лимиты и отсутствие источника отклоняются до первой записи', async () => {
    const own = stand();
    envProject(own);
    own.write(join(own.project, 'big.local'), 'x'.repeat(2_000));
    const workspace = await own.createWorkspace();
    const files = filesFor(own, { maxCopyBytes: 1_000, maxCopyRules: 2 });

    expect((await failure(() => files.copyFiles(own.projectRecord(['app.local', 'APP.local']), workspace))).code).toBe('copy_collision');
    expect((await failure(() => files.copyFiles(own.projectRecord(['big.local']), workspace))).code).toBe('copy_limit_exceeded');
    expect((await failure(() => files.copyFiles(own.projectRecord(['a.local', 'b.local', 'c.local']), workspace))).code).toBe('copy_limit_exceeded');
    const partial = await failure(() => files.copyFiles(own.projectRecord(['app.local', 'нет.local']), workspace));
    expect(partial.code).toBe('copy_source_missing');
    expect(existsSync(join(workspace.path, 'app.local'))).toBe(false);
  });

  it('workspace вне корня приложения или внутри проекта отклоняется', async () => {
    const own = stand();
    envProject(own);
    const workspace = await own.createWorkspace();
    const files = filesFor(own);
    const outside = join(own.root, 'foreign');
    mkdirSync(outside);
    expect((await failure(() => files.copyFiles(own.projectRecord(['.env']), { ...workspace, path: outside }))).code).toBe('unsafe_workspace_path');
    expect((await failure(() => files.copyFiles(own.projectRecord(['.env']), { ...workspace, path: join(own.workspacesRoot, 'нет-такого') }))).code)
      .toBe('unsafe_workspace_path');
    const nested = filesFor(own, { workspacesRoot: own.root });
    expect((await failure(() => nested.copyFiles(own.projectRecord(['.env']), { ...workspace, path: join(own.project, '..') }))).code)
      .toBe('unsafe_workspace_path');
    expect(existsSync(join(outside, '.env'))).toBe(false);
  });

  it('сбой посреди копирования удаляет созданное этим вызовом и сохраняет исходную ошибку', async () => {
    const own = stand();
    envProject(own);
    own.write(join(own.project, 'dir1/a.env'), 'A\n');
    own.write(join(own.project, 'dir2/b.env'), 'B\n');
    const workspace = await own.createWorkspace();
    let failureOnSecond = false;
    const files = filesFor(own, {
      faultInjector: (_point, destination) => {
        if (failureOnSecond) throw new Error(`синтетический сбой после ${destination.split('/').at(-1)}`);
        failureOnSecond = true;
      },
    });
    const error = await failure(() => files.copyFiles(own.projectRecord(['dir1/a.env', 'dir2/b.env']), workspace));
    expect(error.code).toBe('copy_failed');
    expect((error.cause as Error).message).toContain('синтетический сбой');
    expect(error.cleanupFailure).toBeUndefined();
    expect(existsSync(join(workspace.path, 'dir1/a.env'))).toBe(false);
    expect(existsSync(join(workspace.path, 'dir2/b.env'))).toBe(false);
    expect(own.read(join(workspace.path, 'dir1/keep.txt'))).toBe('k\n');
  });

  it('при сбое отката исходная ошибка и ошибка cleanup сохраняются, пользовательские данные не удаляются', async () => {
    const own = stand();
    envProject(own);
    own.write(join(own.project, 'dir1/a.env'), 'A\n');
    own.write(join(own.project, 'dir2/b.env'), 'B\n');
    const workspace = await own.createWorkspace();
    const locked = join(workspace.path, 'dir1');
    let copied = 0;
    const files = filesFor(own, {
      faultInjector: () => {
        if (++copied === 2) throw new Error('синтетический сбой копирования');
        // Каталог первого файла становится недоступным для записи: удаление не сможет пройти.
        chmodSync(locked, 0o500);
      },
    });
    try {
      const error = await failure(() => files.copyFiles(own.projectRecord(['dir1/a.env', 'dir2/b.env']), workspace));
      expect(error.code).toBe('copy_failed');
      expect((error.cause as Error).message).toContain('синтетический сбой');
      expect(error.cleanupFailure).toMatch(/EACCES|EPERM/);
      // Файл остался: приложение не обещает удаления, которого не смогло выполнить, и не трогает чужое.
      expect(existsSync(join(locked, 'a.env'))).toBe(true);
      expect(own.read(join(locked, 'keep.txt'))).toBe('k\n');
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  it('откат не удаляет файл, который пользователь заменил или изменил после создания', async () => {
    const own = stand();
    envProject(own);
    own.write(join(own.project, 'dir1/a.env'), 'A\n');
    own.write(join(own.project, 'dir2/b.env'), 'B\n');
    const workspace = await own.createWorkspace();
    const failing = (tamper: (destination: string) => void) => filesFor(own, {
      faultInjector: (_point, destination) => {
        if (destination.endsWith('b.env')) throw new Error('синтетический сбой копирования');
        tamper(destination);
      },
    });
    const rules = own.projectRecord(['dir1/a.env', 'dir2/b.env']);

    // Тот же файл дописан пользователем: идентичность совпадает, содержимое — нет.
    const modified = await failure(() => failing(destination => appendFileSync(destination, 'правка пользователя\n')).copyFiles(rules, workspace));
    expect(modified.code).toBe('copy_failed');
    expect(modified.cleanupFailure).toBe('modified');
    expect(own.read(join(workspace.path, 'dir1/a.env'))).toBe('A\nправка пользователя\n');
    expect(existsSync(join(workspace.path, 'dir2/b.env'))).toBe(false);
    rmSync(join(workspace.path, 'dir1/a.env'));

    // Файл удалён и создан заново пользователем.
    const replaced = await failure(() => failing(destination => {
      rmSync(destination);
      writeFileSync(destination, 'новый файл пользователя\n');
    }).copyFiles(rules, workspace));
    expect((replaced.cause as Error).message).toContain('синтетический сбой');
    expect(replaced.cleanupFailure).toMatch(/replaced|modified/);
    expect(own.read(join(workspace.path, 'dir1/a.env'))).toBe('новый файл пользователя\n');
    rmSync(join(workspace.path, 'dir1/a.env'));

    // Файл, который уже убрали сами, не считается сбоем отката.
    const gone = await failure(() => failing(destination => rmSync(destination)).copyFiles(rules, workspace));
    expect(gone.cleanupFailure).toBeUndefined();
  });

  it('ошибки не содержат содержимого файлов', async () => {
    const own = stand();
    envProject(own);
    const workspace = await own.createWorkspace();
    own.write(join(workspace.path, '.env'), 'ДРУГОЕ\n');
    const error = await failure(() => filesFor(own).copyFiles(own.projectRecord(['.env']), workspace));
    const text = JSON.stringify({ message: error.message, code: error.code, cause: String(error.cause) });
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('ДРУГОЕ');
  });
});

describe('WorkspaceFiles.inspect', () => {
  it('различает present, missing и uncertain', async () => {
    const own = stand();
    envProject(own);
    const workspace = await own.createWorkspace();
    const files = filesFor(own);
    expect(await files.inspect(workspace)).toBe('present');

    // Чужая ветка в worktree: связь с сессией нарушена.
    own.run(workspace.path, 'checkout', '-q', '-b', 'vs/другая');
    expect(await files.inspect(workspace)).toBe('uncertain');
    own.run(workspace.path, 'checkout', '-q', workspace.branch);
    expect(await files.inspect(workspace)).toBe('present');

    // Workspace вне корня приложения не считается нашим.
    expect(await files.inspect({ ...workspace, path: own.project })).toBe('uncertain');

    // Каталог подменён обычной папкой без Git.
    const copy = `${workspace.path}-moved`;
    own.run(own.project, 'worktree', 'prune');
    rmSync(workspace.path, { recursive: true, force: true });
    expect(await files.inspect(workspace)).toBe('missing');
    mkdirSync(workspace.path);
    writeFileSync(join(workspace.path, 'file.txt'), 'x');
    expect(await files.inspect(workspace)).toBe('uncertain');
    expect(copy).not.toBe(workspace.path);
  });
});
