import { execFile } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
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
  killed?: boolean;
  signal?: string | null;
}

/**
 * G9: у каждого класса команд свой конечный предел. Чтение должно отвечать быстро; merge/apply и
 * создание worktree могут занять больше; сеть ограничивается отдельно. Предел относится к одной
 * команде git, а не к операции целиком.
 */
export const DEFAULT_GIT_TIMEOUTS = { readMs: 60_000, writeMs: 180_000, networkMs: 120_000 } as const;
type GitTimeouts = Required<NonNullable<GitAdapterOptions['timeouts']>>;
type CommandClass = 'read' | 'write' | 'network';

/** Пределы текущей операции адаптера; общие помощники читают их, не получая лишний параметр. */
const timeoutScope = new AsyncLocalStorage<GitTimeouts>();

const NETWORK_COMMANDS = new Set(['push', 'fetch', 'ls-remote', 'clone', 'pull']);
const READ_COMMANDS = new Set(['rev-parse', 'status', 'diff', 'ls-files', 'show', 'cat-file', 'rev-list', 'var',
  'check-ref-format', 'for-each-ref', 'log', 'symbolic-ref', 'merge-base']);

/** Неизвестная команда относится к записи: у неё более длинный предел, но он тоже конечен. */
function commandClass(args: readonly string[]): CommandClass {
  const [name, second] = args;
  if (name === undefined) return 'write';
  if (NETWORK_COMMANDS.has(name)) return 'network';
  if (READ_COMMANDS.has(name)) return 'read';
  if (name === 'branch') return args.includes('--show-current') || args.includes('--list') ? 'read' : 'write';
  if (name === 'worktree') return second === 'list' ? 'read' : 'write';
  if (name === 'config') return args.some(arg => arg === '--get' || arg === '--get-regexp' || arg === '--list') ? 'read' : 'write';
  return 'write';
}

function resolveTimeouts(requested: GitAdapterOptions['timeouts']): GitTimeouts {
  const result: GitTimeouts = { ...DEFAULT_GIT_TIMEOUTS };
  for (const key of ['readMs', 'writeMs', 'networkMs'] as const) {
    const value = requested?.[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
      throw new GitError('invalid_request', `Предел ${key} должен быть целым числом от 1 до 2147483647 мс.`);
    }
    result[key] = value;
  }
  return result;
}

function timeoutFor(args: readonly string[]): number {
  const limits = timeoutScope.getStore() ?? DEFAULT_GIT_TIMEOUTS;
  const kind = commandClass(args);
  return kind === 'read' ? limits.readMs : kind === 'network' ? limits.networkMs : limits.writeMs;
}

/**
 * Политика hooks и подписи (G9).
 * Hooks проекта и пользователя отключены для всех команд адаптера: приложение не исполняет чужой код
 * во время внутренних операций Git. Автоматическая подпись отключена: приложение не имеет ключей
 * и не вызывает pinentry. Поэтому, если конфигурация требует подписанных коммитов
 * (commit.gpgSign=true), операции, создающие коммит, отклоняются с signing_required до изменений.
 * Для чтения этой настройки нужна конфигурация без переопределений: `overrides=false`.
 */
const POLICY_OVERRIDES = ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'merge.autoStash=false'];

/** Git получает аргументы напрямую, без shell и без интерактивных запросов. */
async function runGit(cwd: string, args: readonly string[], overrides: boolean): Promise<string> {
  const env: Record<string, string | undefined> = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
  // Наследуемый GIT_DIR/INDEX_FILE не должен направить операцию в чужой репозиторий.
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_') && key !== 'GIT_TERMINAL_PROMPT') delete env[key];
  }
  const { stdout } = await execute('git', [
    // Чтение при сверке не обновляет stat-cache индекса; обязательные блокировки записи сохраняются.
    '--no-optional-locks',
    ...(overrides ? POLICY_OVERRIDES : []), ...args,
  ], {
    cwd, env, encoding: 'utf8', timeout: timeoutFor(args), maxBuffer: 16 * 1024 * 1024,
    // SIGTERM можно игнорировать: execFile тогда продолжает ждать и допускает поздний exit 0.
    // Завершаем только свой дочерний Git, не дерево внешних helpers.
    killSignal: 'SIGKILL',
  });
  return stdout;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return runGit(cwd, args, true);
}

/** Истёк предел собственной команды: execFile завершил Git сигналом SIGKILL. */
function isTimeout(error: unknown): boolean {
  const failure = error as CommandError | undefined;
  return failure instanceof Error && failure.killed === true && failure.signal === 'SIGKILL';
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
      if (isTimeout(error)) throw timeoutError(error);
      throw new GitError('git_failed', `Команда git завершилась ошибкой: ${firstLine(error)}`, [], error);
    }
    throw error;
  }
}

function timeoutError(cause: unknown): GitError {
  return new GitError('git_timeout', 'Команда git не завершилась за отведённое время и была остановлена.', [], cause);
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
    if (isTimeout(error)) throw timeoutError(error);
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

/** includeIgnored добавляет файлы, скрытые ignore-правилами: нужен перед удалением каталога, не для проверки чистоты 0B. */
async function dirtyFiles(path: string, includeIgnored = false): Promise<string[]> {
  const entries = (await git(path, 'status', '--porcelain=v1', '-z', '--untracked-files=all',
    ...(includeIgnored ? ['--ignored'] : []))).split('\0');
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

/** Merge создаёт коммит только когда ни одна сторона не является предком другой. */
async function needsMergeCommit(path: string, target: string): Promise<boolean> {
  const ancestor = async (older: string, newer: string): Promise<boolean> => {
    try {
      await git(path, 'merge-base', '--is-ancestor', older, newer);
      return true;
    } catch (error) {
      if (isCommandError(error) && error.code === 1) return false;
      throw error;
    }
  };
  return !await ancestor(target, 'HEAD') && !await ancestor('HEAD', target);
}

/**
 * Подпись коммитов принудительно отключена (см. POLICY_OVERRIDES). Если пользователь или репозиторий
 * требует подписи, коммит приложения нарушил бы это требование: отказ до любых изменений.
 */
async function requireSigningPolicy(path: string): Promise<void> {
  let required: string | undefined;
  try {
    required = (await runGit(path, ['config', '--type=bool', '--get', 'commit.gpgsign'], false)).trim();
  } catch (error) {
    if (!isCommandError(error) || typeof error.code !== 'number' || error.code !== 1) throw error;
  }
  if (required === 'true') {
    throw new GitError('signing_required', 'Репозиторий требует подписанных коммитов, а VibeStudio их не подписывает. Отключите commit.gpgSign для этого репозитория или создайте коммит вручную.');
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

// Общая очередь всех экземпляров этого модуля; ключ — realpath Git common-dir.
const locks = new Map<string, Promise<unknown>>();
/** Ошибки, брошенные инжектором сбоев; они означают «процесс умер» и не запускают компенсацию. */
const simulatedCrashes = new WeakSet<object>();

/** Безопасное для хранения описание сбоя: код и сообщение домена, без stderr и путей из системных ошибок. */
function describeFailure(error: unknown): { code: GitError['code']; message: string; files: string[] } {
  if (error instanceof GitError) return { code: error.code, message: error.message, files: [...error.files] };
  if (isCommandError(error)) {
    const mapped = isTimeout(error) ? timeoutError(error)
      : new GitError('git_failed', `Команда git завершилась ошибкой: ${firstLine(error)}`, [], error);
    return { code: mapped.code, message: mapped.message, files: [] };
  }
  return { code: 'git_failed', message: error instanceof Error ? error.message : 'Неизвестная ошибка создания рабочей области.', files: [] };
}

export function createGitAdapter(options: GitAdapterOptions = {}): GitPort {
  const store = options.store ?? memoryStore();
  const timeouts = resolveTimeouts(options.timeouts);

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

  /** Исключения инжектора моделируют падение процесса: они не компенсируются и не перехватываются. */
  async function inject(point: GitFaultPoint, operation: GitOperation): Promise<void> {
    try {
      await options.faultInjector?.(point, structuredClone(operation));
    } catch (error) {
      if (typeof error === 'object' && error !== null) simulatedCrashes.add(error);
      throw error;
    }
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

  /** Состояние ссылки: sha либо undefined, если ссылки нет. Чтение, поэтому ошибки git не скрываются. */
  async function refSha(projectPath: string, ref: string): Promise<string | undefined> {
    return optionalGit(projectPath, 'rev-parse', '--verify', '--quiet', '--end-of-options', ref);
  }

  async function isRegisteredWorktree(projectPath: string, target: string): Promise<boolean> {
    const listed = (await git(projectPath, 'worktree', 'list', '--porcelain', '-z')).split('\0')
      .filter(line => line.startsWith('worktree ')).map(line => line.slice('worktree '.length));
    const expected = await realpath(target).catch(() => resolve(target));
    for (const path of listed) {
      if (await realpath(path).catch(() => resolve(path)) === expected) return true;
    }
    return false;
  }

  /**
   * G10. Компенсация частичного createWorkspace удаляет только ресурсы, создание которых подтверждено
   * успешным завершением собственной команды операции (флаги creation.*Created). Ресурс, который
   * появился во время неподтверждённой команды (таймаут, сбой git) и не существовал до операции,
   * не присваивается: он сохраняется, cleanup помечается preserved.
   * Удаление ветки и ссылок — сравнение с ожидаемым значением (update-ref -d <ref> <sha>), поэтому
   * чужие коммиты и перемещённые ссылки не удаляются. Worktree удаляется без --force, только если
   * он зарегистрирован по ожидаемому пути, чист, стоит на ветке сессии и на базовом коммите.
   * Исходная ошибка возвращается вызывающему; ошибка cleanup записывается в операцию.
   */
  async function compensateCreate(
    operation: GitOperation, before: { baseRef: boolean; branch: boolean; worktree: boolean; path: boolean },
    /** Ключи branch.<имя>.*, которые эта операция записала или могла записать (команда оборвана по таймауту). */
    configKeys: readonly string[], original: unknown,
  ): Promise<void> {
    const { identity } = operation;
    const creation = operation.creation!;
    const { projectPath, sessionId, branch } = identity;
    const target = resolve(identity.workspacePath);
    const baseCheckpoint = sessionRefs(sessionId).base;
    const branchRef = `refs/heads/${branch}`;
    const failures: unknown[] = [];
    let preserved = false;
    const attempt = async (action: () => Promise<void>): Promise<boolean> => {
      try {
        await action();
        return true;
      } catch (error) {
        failures.push(error);
        return false;
      }
    };
    const persist = async (): Promise<void> => {
      try {
        await store.save(operation);
      } catch {
        // Store мог отказать первым: ошибка записи видна через его собственное состояние.
      }
    };
    const keep = (what: string): void => {
      preserved = true;
      failures.push(new GitError('invalid_workspace',
        `Исход команды создания не подтверждён: ${what} появился во время операции и сохранён без удаления.`));
    };

    creation.cleanup = 'pending';
    operation.error = describeFailure(original);
    await persist();
    await inject('create_before_cleanup', operation);

    // Неподтверждённый ресурс не принадлежит операции: его только фиксируем, и всё, что от него зависит, остаётся.
    let baseRefAmbiguous = false, branchAmbiguous = false, worktreeAmbiguous = false;
    await attempt(async () => {
      if (!creation.baseRefCreated && !before.baseRef && await refSha(projectPath, baseCheckpoint) !== undefined) {
        baseRefAmbiguous = true; keep('точка возврата');
      }
      if (!creation.branchCreated && !before.branch && await refSha(projectPath, branchRef) !== undefined) {
        branchAmbiguous = true; keep('ветка сессии');
      }
      if (!creation.worktreeCreated && !before.worktree && !before.path
          && (await isRegisteredWorktree(projectPath, target) || existsSync(target))) {
        worktreeAmbiguous = true; keep('каталог рабочей области');
      }
    });

    let worktreeGone = !creation.worktreeCreated && !worktreeAmbiguous;
    if (creation.worktreeCreated) {
      worktreeGone = await attempt(async () => {
        if (!existsSync(target)) {
          throw new GitError('invalid_workspace', 'Каталог созданной рабочей области уже отсутствует: запись worktree и ветка сохранены для сверки.');
        }
        // Фактическое состояние, а не только флаги: путь, ветка и HEAD должны остаться теми, что создала операция.
        const mismatch = !await isRegisteredWorktree(projectPath, target)
          || (await git(target, 'branch', '--show-current')).trim() !== branch
          || await commitSha(target, 'HEAD') !== creation.baseSha;
        // git worktree remove без --force удаляет ignored-файлы, поэтому они проверяются отдельно.
        const files = await dirtyFiles(target, true);
        if (mismatch || files.length) {
          preserved = true;
          throw new GitError(files.length ? 'dirty_tree' : 'invalid_workspace',
            'В созданной рабочей области есть пользовательские данные или она изменилась: она сохранена.', files);
        }
        await git(projectPath, 'worktree', 'remove', '--', target);
      });
    }
    let branchGone = !creation.branchCreated && !branchAmbiguous;
    if (creation.branchCreated && worktreeGone) {
      branchGone = await attempt(async () => {
        await git(projectPath, 'update-ref', '-d', branchRef, creation.baseSha);
        for (const key of configKeys) {
          try {
            await git(projectPath, 'config', '--local', '--unset', key);
          } catch (error) {
            // Код 5: ключа нет, то есть запись конфигурации не дошла до выполнения.
            if (!isCommandError(error) || error.code !== 5) throw error;
          }
        }
      });
    }
    if (creation.baseRefCreated && !baseRefAmbiguous && worktreeGone && branchGone) {
      await attempt(() => git(projectPath, 'update-ref', '-d', baseCheckpoint, creation.baseSha).then(() => undefined));
    }

    if (failures.length) {
      creation.cleanup = preserved ? 'preserved' : 'failed';
      operation.cleanupError = describeFailure(failures[0]);
    } else {
      creation.cleanup = 'completed';
    }
    operation.phase = 'completed';
    await persist();
  }

  async function createWorkspace(request: CreateWorkspaceRequest): Promise<CreateWorkspaceResult> {
    const { requestId, projectPath, workspacePath, sessionId, branch, baseRef } = request;
    const identity: WorkspaceIdentity = { projectPath, workspacePath, sessionId, branch, baseRef };
    const fingerprint = fingerprintOf(identity);
    await assertRepository(projectPath);
    const repositoryId = await repositoryIdOf(projectPath);
    return withLock(repositoryId, async () => {
      const repeated = await existingOperation(requestId, 'create', fingerprint);
      if (repeated?.workspaceResult) return repeated.workspaceResult;
      if (repeated) {
        // Записанный сбой воспроизводится; неопределённый исход (crash, неудачный cleanup) не повторяется молча.
        if (repeated.error && (repeated.creation?.cleanup === 'completed' || repeated.creation?.cleanup === 'not_needed')) {
          throw new GitError(repeated.error.code, repeated.error.message, repeated.error.files);
        }
        throw new GitError('operation_in_progress', 'Предыдущее создание рабочей области не завершено: сверьте её состояние.');
      }
      const repository = await inspectRepository(projectPath);
      validateSessionId(sessionId);
      await validateBranch(projectPath, branch);
      if (!branch.startsWith('vs/')) throw new GitError('invalid_branch', 'Ветка сессии должна начинаться с vs/.');
      const baseSha = await commitSha(projectPath, baseRef);
      const currentBranch = (await git(projectPath, 'branch', '--show-current')).trim();
      const baseCheckpoint = sessionRefs(sessionId).base;
      const target = resolve(workspacePath);
      const before = {
        baseRef: await refSha(projectPath, baseCheckpoint) !== undefined,
        branch: await refSha(projectPath, `refs/heads/${branch}`) !== undefined,
        worktree: await isRegisteredWorktree(projectPath, target),
        path: existsSync(target),
      };

      // Намерение сохраняется до первого эффекта: отказ записи оставляет репозиторий нетронутым.
      const operation: GitOperation = {
        kind: 'create', operationId: randomUUID(), requestId, repositoryId, fingerprint,
        phase: 'intent_saved', identity,
        creation: { baseSha, baseRefCreated: false, branchCreated: false, worktreeCreated: false, cleanup: 'not_needed' },
      };
      const creation = operation.creation!;
      const configKeys: string[] = [];
      /** Ошибка команды git config без таймаута доказывает, что ключ не записан: удалять нечего. */
      const setConfig = async (key: string, value: string): Promise<void> => {
        try {
          await git(projectPath, 'config', '--local', key, value);
          configKeys.push(key);
        } catch (error) {
          if (isTimeout(error)) configKeys.push(key);
          throw error;
        }
      };
      await store.save(operation);
      try {
        await inject('create_after_intent', operation);
        // Нулевой old-value не позволяет затереть точку возврата существующей сессии.
        try {
          await git(projectPath, 'update-ref', baseCheckpoint, baseSha, '');
        } catch (error) {
          if (!isCommandError(error) || isTimeout(error) || error.code === 'ENOENT') throw error;
          throw new GitError('request_conflict', 'Для этой сессии точка возврата уже создана.', [], error);
        }
        creation.baseRefCreated = true;
        await store.save(operation);
        await inject('create_after_base_ref', operation);

        await git(projectPath, 'worktree', 'add', '-b', branch, '--', target, baseSha);
        creation.branchCreated = true;
        creation.worktreeCreated = true;
        await store.save(operation);
        await inject('create_after_worktree', operation);

        await setConfig(`branch.${branch}.vibestudio-session-id`, sessionId);
        await setConfig(`branch.${branch}.vibestudio-workspace`, await realpath(workspacePath));
        await inject('create_after_config', operation);

        const workspaceResult: CreateWorkspaceResult = {
          baseSha,
          warnings: repository.warnings,
          applyMode: currentBranch && currentBranch === baseRef ? 'apply' : 'keep_branch',
        };
        operation.workspaceResult = workspaceResult;
        operation.phase = 'completed';
        await inject('create_before_result', operation);
        await store.save(operation);
        return workspaceResult;
      } catch (error) {
        // Имитация падения процесса из инжектора не компенсируется: после смерти процесса cleanup не выполняется.
        if (simulatedCrashes.has(error as object)) throw error;
        delete operation.workspaceResult;
        await compensateCreate(operation, before, configKeys, error);
        throw error;
      }
    });
  }

  async function prepareWorkspace(request: PrepareWorkspaceRequest): Promise<PreparedCandidate> {
    const { requestId, projectPath, workspacePath, sessionId, branch, baseRef } = request;
    const identity: WorkspaceIdentity = { projectPath, workspacePath, sessionId, branch, baseRef };
    const fingerprint = fingerprintOf(identity);
    await assertRepository(projectPath);
    const repositoryId = await repositoryIdOf(projectPath);
    return withLock(repositoryId, async () => {
      const repeated = await existingOperation(requestId, 'prepare', fingerprint);
      if (repeated?.candidate) return repeated.candidate;
      await assertWorkspaceBinding(identity);
      await requireClean(workspacePath);
      await validateBranch(projectPath, baseRef);
      const baseSha = await optionalGit(projectPath, 'rev-parse', '--verify', `refs/heads/${baseRef}`);
      if (!baseSha) throw new GitError('base_branch_missing', 'Базовая ветка удалена: выберите другую цель или оставьте ветку.');
      // Настоящий merge создаёт коммит: автор и политика подписи проверяются до первого изменения workspace.
      if (await needsMergeCommit(workspacePath, baseSha)) {
        await requireAuthor(workspacePath);
        await requireSigningPolicy(workspacePath);
      }
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

  /** Сравнение всего индекса и файлов, без write-tree и обновления индекса при чтении. */
  async function treeStateDiagnostic(path: string, expected: string): Promise<string | undefined> {
    for (const args of [['diff', '--cached', '--quiet', expected], ['diff', '--quiet']]) {
      try {
        await git(path, ...args, '--');
      } catch (error) {
        if (isCommandError(error) && error.code === 1) return 'Полное дерево индекса или tracked-файлы не соответствуют ожидаемому состоянию.';
        throw error;
      }
    }
    if ((await git(path, 'ls-files', '--others', '--exclude-standard', '-z')).length) {
      return 'В основной копии появились untracked-файлы.';
    }
    const unfinished = await unfinishedGitState(path);
    if (unfinished.length) return `Есть незавершённая операция Git: ${unfinished.join(', ')}.`;
    return undefined;
  }

  /**
   * Для незавершённой операции нужен точный итог. Последующий HEAD не доказывает,
   * что индекс и файлы когда-либо были согласованы с коммитом применения.
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
    if (head !== plannedSha) return `HEAD находится на ${head.slice(0, 8)}: точное завершение применения не подтверждено.`;
    if ((await git(projectPath, 'branch', '--show-current')).trim() !== identity.baseRef) {
      return 'В основной копии выбрана другая ветка или HEAD отсоединён.';
    }
    try {
      await assertCandidateCurrent(candidate);
    } catch (error) {
      if (error instanceof GitError && error.code === 'candidate_changed') return error.message;
      throw error;
    }
    return treeStateDiagnostic(projectPath, plannedSha);
  }

  async function reconcileOperation(operation: GitOperation): Promise<ApplyWorkspaceResult> {
    // Записанное завершение — исторический факт; поздние правки пользователя его не отменяют.
    if (operation.phase === 'completed' && operation.result && operation.result.status !== 'interrupted') return operation.result;
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
    await assertCandidateCurrent(candidate);
    await requireAuthor(projectPath);
    await requireSigningPolicy(projectPath);
  }

  /** Подготовка допускает только чистый workspace: один HEAD не описывает проверенную ревизию. */
  async function assertCandidateCurrent(candidate: PreparedCandidate): Promise<void> {
    const files = await dirtyFiles(candidate.workspacePath);
    if (files.length || revisionIdOf(candidate) !== candidate.revisionId
      || await commitSha(candidate.workspacePath, 'HEAD') !== candidate.candidateSha
      || (await git(candidate.workspacePath, 'rev-parse', 'HEAD^{tree}')).trim() !== candidate.candidateTree
      || (await git(candidate.workspacePath, 'branch', '--show-current')).trim() !== candidate.branch
      || (await unfinishedGitState(candidate.workspacePath)).length) {
      throw new GitError('candidate_changed', 'Рабочая область изменилась после подготовки. Подготовьте кандидата заново.', files);
    }
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
        await assertCandidateCurrent(candidate);
        const preApplyRef = sessionRefs(sessionId).checkpoint(operation.operationId);
        // Пустой old-value: checkpoint операции создаётся один раз и не перезаписывается.
        await git(projectPath, 'update-ref', preApplyRef, expectedBaseSha, '');
        await save('checkpoint_created', { preApplyRef });
        await inject('after_checkpoint', operation);

        await inject('before_commit', operation);
        await assertCandidateCurrent(candidate);
        if (!await stillOnBase()) return await interrupted('База изменилась после создания checkpoint: основная копия не тронута.');
        const plannedSha = (await git(projectPath, 'commit-tree', candidate.candidateTree, '-p', expectedBaseSha,
          '-m', `Применение сессии ${sessionId}`)).trim();
        await save('commit_created', { plannedSha });
        await inject('after_commit', operation);

        await inject('before_files', operation);
        await assertCandidateCurrent(candidate);
        if (!await stillOnBase()) return await interrupted('База изменилась перед обновлением файлов: основная копия не тронута.');
        const beforeFilesDiagnostic = await treeStateDiagnostic(projectPath, expectedBaseSha);
        if (beforeFilesDiagnostic !== undefined) return await interrupted(beforeFilesDiagnostic);
        // Двустороннее слияние деревьев обновляет индекс и файлы и отказывает при пересекающихся правках пользователя.
        await git(projectPath, 'read-tree', '-m', '-u', expectedBaseSha, plannedSha);
        await save('files_updated');
        await inject('after_files', operation);

        await inject('before_ref', operation);
        await assertCandidateCurrent(candidate);
        if (!await stillOnBase()) return await interrupted('База или текущая ветка изменились перед обновлением ref.');
        const beforeRefDiagnostic = await treeStateDiagnostic(projectPath, plannedSha);
        if (beforeRefDiagnostic !== undefined) return await interrupted(beforeRefDiagnostic);
        await git(projectPath, 'update-ref', '-m', `Применение сессии ${sessionId}`, `refs/heads/${baseRef}`, plannedSha, expectedBaseSha);
        await save('ref_updated');
        await inject('after_ref', operation);

        await inject('before_result', operation);
        const diagnostic = await appliedStateDiagnostic(operation);
        if (diagnostic !== undefined) return await interrupted(diagnostic);
        const result: ApplyWorkspaceResult = { status: 'applied', operationId: operation.operationId, appliedSha: plannedSha, preApplyRef };
        await save('completed', { result });
        await inject('after_result', operation);
        return result;
      } catch (error) {
        if (error instanceof GitError && error.code === 'candidate_changed') return interrupted(error.message);
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
      if (isTimeout(error)) throw timeoutError(error);
      const failure = error as CommandError;
      const output = `${failure.stdout ?? ''}\n${failure.stderr ?? ''}`;
      if (/\[rejected\].*\((?:non-fast-forward|fetch first)\)/.test(output)) {
        throw new GitError('non_fast_forward', 'Удалённая ветка содержит новые коммиты. Force-push не поддерживается.', [], error);
      }
      throw new GitError('push_failed', 'Не удалось отправить ветку. Проверьте доступ к удалённому репозиторию.', [], error);
    }
  }

  /** Пределы этого экземпляра действуют на все команды git внутри одного вызова порта. */
  const scoped = <T>(action: () => Promise<T>): Promise<T> => timeoutScope.run(timeouts, () => domain(action));
  return {
    inspectRepository: (projectPath) => scoped(() => inspectRepository(projectPath)),
    createWorkspace: (request) => scoped(() => createWorkspace(request)),
    prepareWorkspace: (request) => scoped(() => prepareWorkspace(request)),
    applyWorkspace: (request) => scoped(() => applyWorkspace(request)),
    reconcileApply: (request) => scoped(() => reconcileApply(request)),
    pushWorkspace: (request) => scoped(() => pushWorkspace(request)),
  };
}
