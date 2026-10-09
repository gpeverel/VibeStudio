import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  GitError,
  type ApplyWorkspaceRequest, type ApplyWorkspaceResult, type CreateWorkspaceRequest, type CreateWorkspaceResult,
  type GitAdapterOptions, type GitApplyPhase, type GitFaultPoint, type GitOperation, type GitOperationStore,
  type GitPort, type GitWarning, type PrepareWorkspaceRequest, type PreparedCandidate,
  type ReconcileApplyRequest, type WorkspaceIdentity,
} from '../../core/ports/git.ts';

const execute = promisify(execFile);

interface CommandError extends Error {
  code?: string | number;
  cmd?: string;
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

/** Ошибка запуска или выполнения git (а не доменный отказ и не сбой, внесённый тестовой инъекцией). */
function isCommandError(error: unknown): error is CommandError {
  return error instanceof Error && !(error instanceof GitError) && 'cmd' in error;
}

/** Необработанные ошибки git превращаются в доменную ошибку; прочие исключения проходят как есть. */
async function domain<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (isCommandError(error)) {
      if (error.code === 'ENOENT') throw new GitError('git_unavailable', 'Git или каталог проекта недоступен.', [], error);
      throw new GitError('git_failed', `Команда git завершилась ошибкой: ${firstLine(error)}`, [], error);
    }
    throw error;
  }
}

function firstLine(error: CommandError): string {
  const text = (error.stderr || error.message || '').trim();
  return text.split('\n')[0] ?? '';
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

/** Идентификатор репозитория — реальный путь общего каталога Git (одинаков для всех его worktree). */
async function repositoryIdOf(path: string): Promise<string> {
  const common = (await git(path, 'rev-parse', '--path-format=absolute', '--git-common-dir')).trim();
  return realpath(common);
}

const UNFINISHED_GIT_STATE = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'SQUASH_MSG'];

async function unfinishedGitState(path: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of UNFINISHED_GIT_STATE) {
    const location = (await git(path, 'rev-parse', '--git-path', name)).trim();
    if (existsSync(resolve(path, location))) found.push(name);
  }
  return found;
}

async function requireAuthor(path: string): Promise<void> {
  try {
    await git(path, 'var', 'GIT_AUTHOR_IDENT');
    await git(path, 'var', 'GIT_COMMITTER_IDENT');
  } catch (error) {
    if (!isCommandError(error) || error.code === 'ENOENT') throw error;
    throw new GitError('author_missing', 'Не настроены имя и email автора коммита (user.name, user.email).', [], error);
  }
}

function sessionRefs(sessionId: string) {
  return { base: `refs/vibestudio/${sessionId}/base`, checkpoint: (operationId: string) => `refs/vibestudio/${sessionId}/operations/${operationId}/pre-apply` };
}

function revisionIdOf(parts: Omit<PreparedCandidate, 'revisionId'>): string {
  return createHash('sha256').update([
    parts.repositoryId, parts.sessionId, parts.branch, parts.baseRef,
    parts.expectedBaseSha, parts.candidateSha, parts.candidateTree,
  ].join('\0')).digest('hex').slice(0, 40);
}

function fingerprintOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function memoryStore(): GitOperationStore {
  const operations = new Map<string, GitOperation>();
  return {
    async get(requestId) {
      const found = operations.get(requestId);
      return found ? structuredClone(found) : undefined;
    },
    async save(operation) {
      operations.set(operation.requestId, structuredClone(operation));
    },
    async list() {
      return [...operations.values()].map((operation) => structuredClone(operation));
    },
  };
}

export function createGitAdapter(options: GitAdapterOptions = {}): GitPort {
  const store = options.store ?? memoryStore();
  const locks = new Map<string, Promise<unknown>>();

  /** Сериализация писателей внутри приложения; внешний Git и редакторы этой блокировкой не охвачены. */
  async function withLock<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve();
    const run = previous.then(action, action);
    const tail = run.catch(() => undefined);
    locks.set(key, tail);
    try {
      return await run;
    } finally {
      if (locks.get(key) === tail) locks.delete(key);
    }
  }

  async function inject(point: GitFaultPoint, operation: GitOperation): Promise<void> {
    await options.faultInjector?.(point, structuredClone(operation));
  }

  async function existingOperation(requestId: string, kind: GitOperation['kind'], fingerprint: string) {
    const found = await store.get(requestId);
    if (!found) return undefined;
    if (found.kind !== kind || found.fingerprint !== fingerprint) {
      throw new GitError('request_conflict', 'Этот requestId уже использован для другого запроса.');
    }
    return found;
  }

  /** Связь session/workspace/branch сохраняется при создании; из имени ветки она не выводится. */
  async function assertWorkspaceBinding(identity: WorkspaceIdentity): Promise<string> {
    const { projectPath, workspacePath, sessionId, branch } = identity;
    validateSessionId(sessionId);
    await assertRepository(workspacePath);
    if (await realpath(projectPath) === await realpath(workspacePath)) {
      throw new GitError('invalid_workspace', 'Рабочая область должна быть отдельной worktree.');
    }
    const repositoryId = await repositoryIdOf(projectPath);
    if (repositoryId !== await repositoryIdOf(workspacePath)) {
      throw new GitError('invalid_workspace', 'Worktree принадлежит другому репозиторию.');
    }
    const current = (await git(workspacePath, 'branch', '--show-current')).trim();
    if (!branch.startsWith('vs/') || current !== branch) {
      throw new GitError('invalid_workspace', 'Не найдена ветка сессии.');
    }
    const savedSession = await optionalGit(projectPath, 'config', '--local', '--get', `branch.${branch}.vibestudio-session-id`);
    const savedWorkspace = await optionalGit(projectPath, 'config', '--local', '--get', `branch.${branch}.vibestudio-workspace`);
    if (savedSession !== sessionId || !savedWorkspace || savedWorkspace !== await realpath(workspacePath)) {
      throw new GitError('invalid_workspace', 'Рабочая область не связана с этой сессией.');
    }
    return repositoryId;
  }

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

  async function createWorkspace(request: CreateWorkspaceRequest): Promise<CreateWorkspaceResult> {
    const { requestId, projectPath, workspacePath, sessionId, branch, baseRef } = request;
    const identity: WorkspaceIdentity = { projectPath, workspacePath, sessionId, branch, baseRef };
    const fingerprint = fingerprintOf(identity);
    const repeated = await existingOperation(requestId, 'create', fingerprint);
    if (repeated?.workspaceResult) return repeated.workspaceResult;
    const repository = await inspectRepository(projectPath);
    const repositoryId = await repositoryIdOf(projectPath);
    return withLock(repositoryId, async () => {
      validateSessionId(sessionId);
      await validateBranch(projectPath, branch);
      if (!branch.startsWith('vs/')) throw new GitError('invalid_branch', 'Ветка сессии должна начинаться с vs/.');
      const baseSha = await commitSha(projectPath, baseRef);
      const currentBranch = (await git(projectPath, 'branch', '--show-current')).trim();
      const baseCheckpoint = sessionRefs(sessionId).base;
      // Нулевой old-value не позволяет затереть точку возврата существующей сессии.
      try {
        await git(projectPath, 'update-ref', baseCheckpoint, baseSha, '');
      } catch (error) {
        if (!isCommandError(error)) throw error;
        throw new GitError('request_conflict', 'Для этой сессии точка возврата уже создана.', [], error);
      }
      try {
        await git(projectPath, 'worktree', 'add', '-b', branch, '--', resolve(workspacePath), baseSha);
      } catch (error) {
        await git(projectPath, 'update-ref', '-d', baseCheckpoint, baseSha);
        throw error;
      }
      await git(projectPath, 'config', '--local', `branch.${branch}.vibestudio-session-id`, sessionId);
      await git(projectPath, 'config', '--local', `branch.${branch}.vibestudio-workspace`, await realpath(workspacePath));
      const workspaceResult: CreateWorkspaceResult = {
        baseSha,
        warnings: repository.warnings,
        applyMode: currentBranch && currentBranch === baseRef ? 'apply' : 'keep_branch',
      };
      await store.save({
        kind: 'create', operationId: randomUUID(), requestId, repositoryId, fingerprint,
        phase: 'completed', identity, workspaceResult,
      });
      return workspaceResult;
    });
  }

  async function prepareWorkspace(request: PrepareWorkspaceRequest): Promise<PreparedCandidate> {
    const { requestId, projectPath, workspacePath, sessionId, branch, baseRef } = request;
    const identity: WorkspaceIdentity = { projectPath, workspacePath, sessionId, branch, baseRef };
    const fingerprint = fingerprintOf(identity);
    const repeated = await existingOperation(requestId, 'prepare', fingerprint);
    if (repeated?.candidate) return repeated.candidate;
    await assertRepository(projectPath);
    const repositoryId = await repositoryIdOf(projectPath);
    return withLock(repositoryId, async () => {
      await assertWorkspaceBinding(identity);
      await requireClean(workspacePath);
      await validateBranch(projectPath, baseRef);
      const baseSha = await optionalGit(projectPath, 'rev-parse', '--verify', `refs/heads/${baseRef}`);
      if (!baseSha) throw new GitError('base_branch_missing', 'Базовая ветка удалена: выберите другую цель или оставьте ветку.');
      try {
        await git(workspacePath, 'merge', '--no-edit', baseSha);
      } catch (error) {
        const files = (await git(workspacePath, 'diff', '--name-only', '--diff-filter=U', '-z')).split('\0').filter(Boolean);
        if (files.length) throw new GitError('merge_conflict', 'Разрешите конфликты в рабочей области сессии.', files, error);
        throw error;
      }
      const parts = {
        ...identity, repositoryId, expectedBaseSha: baseSha,
        candidateSha: await commitSha(workspacePath, 'HEAD'),
        candidateTree: (await git(workspacePath, 'rev-parse', 'HEAD^{tree}')).trim(),
      };
      const candidate: PreparedCandidate = { ...parts, revisionId: revisionIdOf(parts) };
      await store.save({
        kind: 'prepare', operationId: randomUUID(), requestId, repositoryId, fingerprint,
        phase: 'completed', identity, candidate,
      });
      return candidate;
    });
  }

  /** Файлы, которые меняет применение; по ним проверяется согласованность дерева и индекса. */
  async function changedPaths(path: string, base: string, planned: string): Promise<string[]> {
    return (await git(path, 'diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--no-renames', base, planned))
      .split('\0').filter(Boolean);
  }

  async function pathsMatch(path: string, paths: string[]): Promise<boolean> {
    if (!paths.length) return true;
    for (const args of [['diff', '--quiet', 'HEAD'], ['diff', '--cached', '--quiet']]) {
      try {
        await git(path, '--literal-pathspecs', ...args, '--', ...paths);
      } catch (error) {
        if (isCommandError(error) && error.code === 1) return false;
        throw error;
      }
    }
    return true;
  }

  /**
   * «Применено» — это согласованность HEAD, индекса и файлов изменённых путей без незавершённых операций.
   * Если пользователь позже добавил коммиты, достаточно того, что squash-коммит остаётся предком HEAD.
   */
  async function appliedStateDiagnostic(operation: GitOperation): Promise<string | undefined> {
    const { candidate, plannedSha, identity } = operation;
    if (!candidate || !plannedSha) return 'Итоговый коммит применения не был создан.';
    const projectPath = identity.projectPath;
    const head = await commitSha(projectPath, 'HEAD');
    if (await optionalGit(projectPath, 'cat-file', '-e', `${plannedSha}^{commit}`) === undefined) {
      return 'Итоговый коммит применения не найден.';
    }
    const parents = (await git(projectPath, 'rev-list', '--parents', '-n', '1', plannedSha)).trim().split(' ').slice(1);
    const tree = (await git(projectPath, 'rev-parse', `${plannedSha}^{tree}`)).trim();
    if (parents.length !== 1 || parents[0] !== candidate.expectedBaseSha || tree !== candidate.candidateTree) {
      return 'Итоговый коммит не соответствует кандидату.';
    }
    const unfinished = await unfinishedGitState(projectPath);
    if (unfinished.length) return `Есть незавершённая операция Git: ${unfinished.join(', ')}.`;
    if (head === plannedSha) {
      if (!await pathsMatch(projectPath, await changedPaths(projectPath, candidate.expectedBaseSha, plannedSha))) {
        return 'Индекс или файлы не соответствуют итоговому коммиту.';
      }
      return undefined;
    }
    const descendant = await optionalGit(projectPath, 'merge-base', '--is-ancestor', plannedSha, head);
    return descendant === undefined ? `HEAD находится на ${head.slice(0, 8)}, итоговый коммит применения не достигнут.` : undefined;
  }

  async function reconcileOperation(operation: GitOperation): Promise<ApplyWorkspaceResult> {
    if (operation.result && operation.result.status !== 'interrupted') return operation.result;
    const diagnostic = await appliedStateDiagnostic(operation);
    if (diagnostic === undefined && operation.plannedSha && operation.preApplyRef) {
      const result: ApplyWorkspaceResult = {
        status: 'applied', operationId: operation.operationId,
        appliedSha: operation.plannedSha, preApplyRef: operation.preApplyRef,
      };
      await store.save({ ...operation, phase: 'completed', result });
      return result;
    }
    return {
      status: 'interrupted', operationId: operation.operationId, phase: operation.phase,
      diagnostic: diagnostic ?? 'Состояние применения не удалось подтвердить.',
    };
  }

  async function reconcileApply(request: ReconcileApplyRequest): Promise<ApplyWorkspaceResult> {
    await assertRepository(request.projectPath);
    const repositoryId = await repositoryIdOf(request.projectPath);
    return withLock(repositoryId, async () => {
      const operation = (await store.list()).find((item) => item.kind === 'apply' && item.operationId === request.operationId);
      if (!operation) throw new GitError('operation_not_found', 'Операция применения не найдена.');
      if (operation.repositoryId !== repositoryId) throw new GitError('invalid_workspace', 'Операция относится к другому репозиторию.');
      return reconcileOperation(operation);
    });
  }

  async function assertApplyPreconditions(request: ApplyWorkspaceRequest, repositoryId: string): Promise<void> {
    const { candidate, verification } = request;
    const { projectPath, baseRef } = candidate;
    if (verification.revisionId !== candidate.revisionId || verification.checksFingerprint !== request.checksFingerprint) {
      throw new GitError('checks_stale', 'Проверки относятся к другой ревизии или конфигурации. Повторите проверки.');
    }
    if (verification.status === 'bypassed' && !verification.reason.trim()) {
      throw new GitError('invalid_request', 'Для пропуска проверок нужна причина.');
    }
    if (candidate.repositoryId !== repositoryId) {
      throw new GitError('invalid_workspace', 'Кандидат относится к другому репозиторию.');
    }
    await assertWorkspaceBinding(candidate);
    const operations = await store.list();
    const siblings = operations.filter((item) => item.kind === 'apply' && item.repositoryId === repositoryId
      && item.requestId !== request.requestId);
    if (siblings.some((item) => item.identity.sessionId === candidate.sessionId && item.result?.status === 'applied')) {
      throw new GitError('session_applied', 'Сессия уже применена. Для нового изменения создайте новую сессию.');
    }
    if (siblings.some((item) => !item.result || item.result.status === 'interrupted')) {
      throw new GitError('operation_in_progress', 'Предыдущее применение не завершено: сверьте его состояние.');
    }
    const unfinished = await unfinishedGitState(projectPath);
    if (unfinished.length) {
      throw new GitError('git_operation_in_progress', 'В основной копии не завершена операция Git.', unfinished);
    }
    await requireClean(projectPath);
    const currentBranch = (await git(projectPath, 'branch', '--show-current')).trim();
    if (!currentBranch) throw new GitError('detached_head', 'HEAD отсоединён: оставьте ветку сессии.');
    await validateBranch(projectPath, baseRef);
    const baseSha = await optionalGit(projectPath, 'rev-parse', '--verify', `refs/heads/${baseRef}`);
    if (!baseSha) throw new GitError('base_branch_missing', 'Базовая ветка удалена: выберите другую цель или оставьте ветку.');
    if (currentBranch !== baseRef) throw new GitError('base_branch_not_checked_out', 'Переключите основную копию на выбранную базовую ветку.');
    if (baseSha !== candidate.expectedBaseSha || await commitSha(projectPath, 'HEAD') !== candidate.expectedBaseSha) {
      throw new GitError('base_changed', 'Базовая ветка изменилась после подготовки. Подготовьте кандидата заново.');
    }
    if (revisionIdOf(candidate) !== candidate.revisionId
      || await commitSha(candidate.workspacePath, 'HEAD') !== candidate.candidateSha
      || (await git(candidate.workspacePath, 'rev-parse', 'HEAD^{tree}')).trim() !== candidate.candidateTree) {
      throw new GitError('candidate_changed', 'Рабочая область изменилась после подготовки. Подготовьте кандидата заново.');
    }
    await requireAuthor(projectPath);
  }

  async function applyWorkspace(request: ApplyWorkspaceRequest): Promise<ApplyWorkspaceResult> {
    const { requestId, candidate } = request;
    const fingerprint = fingerprintOf({ candidate, verification: request.verification, checksFingerprint: request.checksFingerprint });
    await assertRepository(candidate.projectPath);
    const repositoryId = await repositoryIdOf(candidate.projectPath);
    return withLock(repositoryId, async () => {
      const repeated = await existingOperation(requestId, 'apply', fingerprint);
      if (repeated) return reconcileOperation(repeated);
      await assertApplyPreconditions(request, repositoryId);

      const { projectPath, sessionId, baseRef, expectedBaseSha } = candidate;
      const operation: GitOperation = {
        kind: 'apply', operationId: randomUUID(), requestId, repositoryId, fingerprint,
        phase: 'intent_saved',
        identity: { projectPath, workspacePath: candidate.workspacePath, sessionId, branch: candidate.branch, baseRef },
        candidate, verification: request.verification,
      };
      const save = async (phase: GitApplyPhase, patch: Partial<GitOperation> = {}) => {
        Object.assign(operation, patch, { phase });
        await store.save(operation);
      };

      if (candidate.candidateTree === (await git(projectPath, 'rev-parse', 'HEAD^{tree}')).trim()) {
        const result: ApplyWorkspaceResult = { status: 'no_changes', operationId: operation.operationId };
        await save('completed', { result });
        return result;
      }

      await save('intent_saved');
      await inject('after_intent', operation);
      const interrupted = async (diagnostic: string): Promise<ApplyWorkspaceResult> => {
        const result: ApplyWorkspaceResult = {
          status: 'interrupted', operationId: operation.operationId, phase: operation.phase, diagnostic,
        };
        await save(operation.phase, { result });
        return result;
      };
      const stillOnBase = async (): Promise<boolean> => (await commitSha(projectPath, 'HEAD')) === expectedBaseSha
        && (await git(projectPath, 'branch', '--show-current')).trim() === baseRef;

      try {
        await inject('before_checkpoint', operation);
        const preApplyRef = sessionRefs(sessionId).checkpoint(operation.operationId);
        // Пустой old-value: checkpoint операции создаётся один раз и не перезаписывается.
        await git(projectPath, 'update-ref', preApplyRef, expectedBaseSha, '');
        await save('checkpoint_created', { preApplyRef });
        await inject('after_checkpoint', operation);

        await inject('before_commit', operation);
        if (!await stillOnBase()) return await interrupted('База изменилась после создания checkpoint: основная копия не тронута.');
        const plannedSha = (await git(projectPath, 'commit-tree', candidate.candidateTree, '-p', expectedBaseSha,
          '-m', `Применение сессии ${sessionId}`)).trim();
        await save('commit_created', { plannedSha });
        await inject('after_commit', operation);

        await inject('before_files', operation);
        if (!await stillOnBase()) return await interrupted('База изменилась перед обновлением файлов: основная копия не тронута.');
        // Двустороннее слияние деревьев обновляет индекс и файлы и отказывает при пересекающихся правках пользователя.
        await git(projectPath, 'read-tree', '-m', '-u', expectedBaseSha, plannedSha);
        await save('files_updated');
        await inject('after_files', operation);

        await inject('before_ref', operation);
        await git(projectPath, 'update-ref', '-m', `Применение сессии ${sessionId}`, `refs/heads/${baseRef}`, plannedSha, expectedBaseSha);
        await save('ref_updated');
        await inject('after_ref', operation);

        const diagnostic = await appliedStateDiagnostic(operation);
        if (diagnostic !== undefined) return await interrupted(diagnostic);
        const result: ApplyWorkspaceResult = { status: 'applied', operationId: operation.operationId, appliedSha: plannedSha, preApplyRef };
        await inject('before_result', operation);
        await save('completed', { result });
        await inject('after_result', operation);
        return result;
      } catch (error) {
        if (!isCommandError(error)) throw error;
        return interrupted(`Команда git завершилась ошибкой: ${firstLine(error)}`);
      }
    });
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

  return {
    inspectRepository: (projectPath) => domain(() => inspectRepository(projectPath)),
    createWorkspace: (request) => domain(() => createWorkspace(request)),
    prepareWorkspace: (request) => domain(() => prepareWorkspace(request)),
    applyWorkspace: (request) => domain(() => applyWorkspace(request)),
    reconcileApply: (request) => domain(() => reconcileApply(request)),
    pushWorkspace: (request) => domain(() => pushWorkspace(request)),
  };
}
