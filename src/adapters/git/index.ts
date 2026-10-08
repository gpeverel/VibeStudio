import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { ApplyWorkspaceRequest, CreateWorkspaceRequest, GitPort, GitWarning } from '../../core/ports/git.ts';

const execute = promisify(execFile);

export class GitError extends Error {
  readonly code: string;
  readonly files: string[];

  constructor(code: string, message: string, files: string[] = [], cause?: unknown) {
    super(message, { cause });
    this.name = 'GitError';
    this.code = code;
    this.files = files;
  }
}

interface CommandError extends Error {
  code?: string | number;
  stdout?: string;
  stderr?: string;
}

/** Git получает аргументы напрямую, без shell и без интерактивных запросов. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const env: Record<string, string | undefined> = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
  // Наследуемый GIT_DIR/INDEX_FILE не должен направить операцию в чужой репозиторий.
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_') && key !== 'GIT_TERMINAL_PROMPT') delete env[key];
  }
  const { stdout } = await execute('git', [
    '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false',
    '-c', 'merge.autoStash=false', ...args,
  ], { cwd, env, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

async function optionalGit(cwd: string, ...args: string[]): Promise<string | undefined> {
  try {
    return (await git(cwd, ...args)).trim();
  } catch (error) {
    const failure = error as CommandError;
    if (typeof failure.code === 'number' && failure.code > 0) return undefined;
    throw error;
  }
}

async function assertRepository(path: string): Promise<void> {
  let top: string;
  try {
    top = (await git(path, 'rev-parse', '--show-toplevel')).trim();
  } catch (error) {
    if ((error as CommandError).code === 'ENOENT') {
      throw new GitError('git_unavailable', 'Git или каталог проекта недоступен.', [], error);
    }
    throw new GitError('not_git_repository', 'Выберите Git-репозиторий или подтвердите git init.', [], error);
  }
  if (await realpath(path) !== await realpath(top)) {
    throw new GitError('not_git_repository', 'Выберите корень Git-репозитория.');
  }
}

async function commitSha(path: string, ref: string): Promise<string> {
  const sha = await optionalGit(path, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`);
  if (!sha) throw new GitError('invalid_reference', 'Не найдена указанная точка возврата.');
  return sha;
}

async function dirtyFiles(path: string): Promise<string[]> {
  const entries = (await git(path, 'status', '--porcelain=v1', '-z', '--untracked-files=all')).split('\0');
  const files = new Set<string>();
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    files.add(entry.slice(3));
    if (/[RC]/.test(entry.slice(0, 2)) && entries[i + 1]) files.add(entries[++i]!);
  }
  return [...files];
}

async function requireClean(path: string): Promise<void> {
  const files = await dirtyFiles(path);
  if (files.length) throw new GitError('dirty_tree', 'Сохраните изменения перед применением.', files);
}

async function validateBranch(path: string, branch: string): Promise<void> {
  if (branch.startsWith('-') || !await optionalGit(path, 'check-ref-format', '--branch', branch)) {
    throw new GitError('invalid_branch', 'Недопустимое имя ветки.');
  }
}

function validateSessionId(id: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) {
    throw new GitError('invalid_session_id', 'Недопустимый идентификатор сессии.');
  }
}

export function createGitAdapter(): GitPort {
  async function inspectRepository(projectPath: string) {
    await assertRepository(projectPath);
    const head = await optionalGit(projectPath, 'rev-parse', '--verify', 'HEAD');
    if (!head) throw new GitError('no_commits', 'Для запуска сессии нужен хотя бы один коммит.');
    const warnings: GitWarning[] = [];
    if ((await dirtyFiles(projectPath)).length) warnings.push('dirty_tree');
    const entries = (await git(projectPath, 'ls-files', '--stage', '-z')).split('\0');
    if (entries.some((entry) => entry.startsWith('160000 '))) warnings.push('submodules_unsupported');
    const paths = (await git(projectPath, 'ls-files', '-z')).split('\0');
    for (const path of paths.filter((name) => name === '.gitattributes' || name.endsWith('/.gitattributes'))) {
      const attributes = await optionalGit(projectPath, 'show', `:${path}`);
      if (attributes?.split('\n').some((line) => !line.trimStart().startsWith('#') && /\sfilter=lfs(?:\s|$)/.test(line))) {
        warnings.push('lfs_unsupported');
        break;
      }
    }
    return { head, warnings };
  }

  async function createWorkspace(request: CreateWorkspaceRequest) {
    const { projectPath, workspacePath, sessionId, branch, baseRef } = request;
    const repository = await inspectRepository(projectPath);
    validateSessionId(sessionId);
    await validateBranch(projectPath, branch);
    if (!branch.startsWith('vs/')) throw new GitError('invalid_branch', 'Ветка сессии должна начинаться с vs/.');
    const baseSha = await commitSha(projectPath, baseRef);
    const currentBranch = (await git(projectPath, 'branch', '--show-current')).trim();
    const baseCheckpoint = `refs/vibestudio/${sessionId}/base`;
    // Нулевой old-value не позволяет затереть точку возврата существующей сессии.
    await git(projectPath, 'update-ref', baseCheckpoint, baseSha, '');
    try {
      await git(projectPath, 'worktree', 'add', '-b', branch, '--', resolve(workspacePath), baseSha);
    } catch (error) {
      await git(projectPath, 'update-ref', '-d', baseCheckpoint, baseSha);
      throw error;
    }
    await git(projectPath, 'config', '--local', `branch.${branch}.vibestudio-session-id`, sessionId);
    return { baseSha, warnings: repository.warnings, applyMode: currentBranch ? 'apply' as const : 'keep_branch' as const };
  }

  async function applyWorkspace(request: ApplyWorkspaceRequest) {
    const { projectPath, workspacePath, baseRef } = request;
    await assertRepository(projectPath);
    await requireClean(projectPath);
    const currentBranch = (await git(projectPath, 'branch', '--show-current')).trim();
    if (!currentBranch) throw new GitError('detached_head', 'HEAD отсоединён: оставьте ветку сессии.');
    await validateBranch(projectPath, baseRef);
    const baseSha = await optionalGit(projectPath, 'rev-parse', '--verify', `refs/heads/${baseRef}`);
    if (!baseSha) throw new GitError('base_branch_missing', 'Базовая ветка удалена: выберите другую цель или оставьте ветку.');
    if (currentBranch !== baseRef) throw new GitError('base_branch_not_checked_out', 'Переключите основную копию на выбранную базовую ветку.');
    await assertRepository(workspacePath);
    if (await realpath(projectPath) === await realpath(workspacePath)) {
      throw new GitError('invalid_workspace', 'Рабочая область должна быть отдельной worktree.');
    }
    const mainCommon = (await git(projectPath, 'rev-parse', '--path-format=absolute', '--git-common-dir')).trim();
    const workCommon = (await git(workspacePath, 'rev-parse', '--path-format=absolute', '--git-common-dir')).trim();
    if (await realpath(mainCommon) !== await realpath(workCommon)) {
      throw new GitError('invalid_workspace', 'Worktree принадлежит другому репозиторию.');
    }
    await requireClean(workspacePath);
    const branch = (await git(workspacePath, 'branch', '--show-current')).trim();
    if (!branch.startsWith('vs/')) throw new GitError('invalid_workspace', 'Не найдена ветка сессии.');
    const sessionId = request.sessionId
      ?? await optionalGit(projectPath, 'config', '--get', `branch.${branch}.vibestudio-session-id`)
      ?? branch.slice(3);
    validateSessionId(sessionId);
    const preApplyRef = `refs/vibestudio/${sessionId}/pre-apply`;
    await git(projectPath, 'update-ref', preApplyRef, baseSha);
    try {
      await git(workspacePath, 'merge', '--no-edit', baseSha);
    } catch (error) {
      const files = (await git(workspacePath, 'diff', '--name-only', '--diff-filter=U', '-z')).split('\0').filter(Boolean);
      if (files.length) throw new GitError('merge_conflict', 'Разрешите конфликты в рабочей области сессии.', files, error);
      throw error;
    }
    // За время подготовки пользователь мог изменить основную копию.
    await requireClean(projectPath);
    if (await commitSha(projectPath, 'HEAD') !== baseSha
      || (await git(projectPath, 'branch', '--show-current')).trim() !== baseRef) {
      throw new GitError('base_changed', 'Базовая ветка изменилась во время подготовки. Повторите применение.');
    }
    const sessionSha = await commitSha(workspacePath, 'HEAD');
    await git(projectPath, 'merge', '--squash', '--', sessionSha);
    if ((await git(projectPath, 'diff', '--cached', '--name-only', '-z')).length) {
      await git(projectPath, 'commit', '-m', `Применение сессии ${sessionId}`);
    }
    return { appliedSha: await commitSha(projectPath, 'HEAD'), preApplyRef };
  }

  async function pushWorkspace(request: { workspacePath: string; remote: string; branch: string }) {
    const { workspacePath, remote, branch } = request;
    await assertRepository(workspacePath);
    await validateBranch(workspacePath, branch);
    // Явный refspec и --no-force исключают force-настройки remote.<name>.push.
    try {
      await git(workspacePath, 'push', '--porcelain', '--no-force', '--', remote, `refs/heads/${branch}:refs/heads/${branch}`);
    } catch (error) {
      const failure = error as CommandError;
      const output = `${failure.stdout ?? ''}\n${failure.stderr ?? ''}`;
      if (/\[rejected\].*\((?:non-fast-forward|fetch first)\)/.test(output)) {
        throw new GitError('non_fast_forward', 'Удалённая ветка содержит новые коммиты. Force-push не поддерживается.', [], error);
      }
      throw new GitError('push_failed', 'Не удалось отправить ветку. Проверьте доступ к удалённому репозиторию.', [], error);
    }
  }

  return { inspectRepository, createWorkspace, applyWorkspace, pushWorkspace };
}
