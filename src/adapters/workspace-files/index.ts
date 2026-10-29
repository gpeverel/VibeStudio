import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import { basename, join, posix, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { GitError, type GitPort } from '../../core/ports/git.ts';
import type { ProjectRecord, WorkspaceRecord } from '../../core/ports/store.ts';
import { WorkspaceFilesError, type WorkspaceFiles } from '../../core/ports/workspace-files.ts';
export { WorkspaceFilesError, type WorkspaceFilesErrorCode } from '../../core/ports/workspace-files.ts';

const execute = promisify(execFile);

/** Файл назначения заменён или изменён после создания: откат его не трогает. */
class ReplacedFile extends Error {
  constructor(readonly reason: 'replaced' | 'modified') { super(reason); }
}

export interface WorkspaceFilesOptions {
  /** Корень workspace приложения. Должен быть абсолютным и находиться вне проектов пользователя. */
  workspacesRoot: string;
  git: Pick<GitPort, 'inspectRepository'>;
  /** Предел одного копируемого файла. */
  maxCopyBytes?: number;
  /** Предел числа правил. */
  maxCopyRules?: number;
  /** Только для тестов аварий: вызывается после создания каждого файла назначения. */
  faultInjector?: (point: 'after_file_copied', destination: string) => void | Promise<void>;
}

export const DEFAULT_SETUP_TIMEOUT_MS = 300_000;
const GIT_READ_TIMEOUT_MS = 30_000;
const MANIFEST_BYTES = 1_048_576;
const SESSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
/** Никогда не копируются: служебный каталог Git и зависимости (общий node_modules — обход изоляции). */
const FORBIDDEN_SEGMENTS = new Set(['.git', 'node_modules']);

async function gitRead(cwd: string, args: readonly string[]): Promise<string> {
  const env: Record<string, string | undefined> = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
  // Наследуемый GIT_DIR и подобные переменные не должны направить чтение в чужой репозиторий.
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') && key !== 'GIT_TERMINAL_PROMPT') delete env[key];
  const { stdout } = await execute('git', ['--no-optional-locks', ...args], {
    cwd, env, encoding: 'utf8', timeout: GIT_READ_TIMEOUT_MS, maxBuffer: MANIFEST_BYTES + 4096, killSignal: 'SIGKILL',
  });
  return stdout;
}

/** Код выхода git: 0 — да, 1 — нет; любая другая причина (включая таймаут) — исключение. */
async function gitTest(cwd: string, args: readonly string[]): Promise<boolean> {
  try {
    await gitRead(cwd, args);
    return true;
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return false;
    throw error;
  }
}

async function inside(parent: string, child: string): Promise<boolean> {
  const [root, path] = await Promise.all([realpath(parent), realpath(child)]);
  return path !== root && path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Созданный этим вызовом файл: по идентичности и содержимому откат отличает его от замены. */
interface CreatedFile {
  path: string;
  dev: number;
  ino: number;
  /** SHA-256 записанных байтов; undefined, пока запись не завершена. */
  digest: string | undefined;
}

const digestOf = (content: Uint8Array): string => createHash('sha256').update(content).digest('hex');

interface CopyPlan {
  rule: number;
  source: string;
  destination: string;
  parents: string[];
  mode: number;
}

export function createWorkspaceFiles(options: WorkspaceFilesOptions): WorkspaceFiles {
  if (!options.workspacesRoot || resolve(options.workspacesRoot) !== options.workspacesRoot) {
    throw new WorkspaceFilesError('unsafe_workspace_path', 'Корень workspace должен быть абсолютным нормализованным путём.');
  }
  const root = options.workspacesRoot;
  const maxCopyBytes = options.maxCopyBytes ?? 1_048_576;
  const maxCopyRules = options.maxCopyRules ?? 32;

  async function manifestSetup(projectPath: string): Promise<ProjectRecord['config']['setup']> {
    let text: string;
    try {
      // Читается закоммиченная версия: именно она попадёт в workspace, созданный от HEAD.
      text = await gitRead(projectPath, ['show', 'HEAD:package.json']);
    } catch (error) {
      if ((error as { code?: unknown }).code === 128) return null;
      throw error;
    }
    let manifest: unknown;
    try {
      manifest = JSON.parse(text);
    } catch (error) {
      throw new WorkspaceFilesError('invalid_project', 'package.json в HEAD не является корректным JSON: setup не определён.', { cause: error });
    }
    const scripts = typeof manifest === 'object' && manifest !== null ? (manifest as { scripts?: unknown }).scripts : undefined;
    const setup = typeof scripts === 'object' && scripts !== null ? (scripts as Record<string, unknown>).setup : undefined;
    return typeof setup === 'string' && setup.trim() ? { kind: 'npm-script', script: 'setup', args: [] } : null;
  }

  async function inspectProject(path: string): Promise<Omit<ProjectRecord, 'id'>> {
    let canonicalPath: string;
    try {
      canonicalPath = await realpath(path);
      if (!(await lstat(canonicalPath)).isDirectory()) throw new Error('не каталог');
    } catch (error) {
      throw new WorkspaceFilesError('invalid_project', 'Выбранный путь недоступен или не является каталогом.', { cause: error });
    }
    await options.git.inspectRepository(canonicalPath);
    const branch = (await gitRead(canonicalPath, ['branch', '--show-current'])).trim();
    if (!branch) throw new GitError('detached_head', 'HEAD отсоединён: выберите ветку проекта.');
    return {
      canonicalPath, name: basename(canonicalPath), defaultBranch: branch, configVersion: 1,
      config: { setup: await manifestSetup(canonicalPath), copyFiles: [], setupTimeoutMs: DEFAULT_SETUP_TIMEOUT_MS },
    };
  }

  function allocatePath(sessionId: string): string {
    if (!SESSION_ID.test(sessionId)) {
      throw new WorkspaceFilesError('invalid_session_id', 'Идентификатор сессии не годится для имени каталога.');
    }
    return join(root, sessionId);
  }

  /** Лексическая проверка правила: только относительный нормализованный POSIX-путь к одному файлу. */
  function parseRule(value: unknown, rule: number): string[] {
    const invalid = (message: string) => new WorkspaceFilesError('invalid_copy_rule', `Правило ${rule + 1}: ${message}`, { rule });
    if (typeof value !== 'string' || value === '') throw invalid('нужен непустой относительный путь.');
    if (value.includes('\0') || value.includes('\\')) throw invalid('недопустимые символы в пути.');
    if (/[*?[\]{}]/.test(value)) throw invalid('шаблоны не поддерживаются: укажите точный файл.');
    if (value.startsWith('/') || value.endsWith('/') || posix.normalize(value) !== value) throw invalid('путь должен быть относительным и нормализованным.');
    const segments = value.split('/');
    if (segments.some(part => part === '' || part === '.' || part === '..')) throw invalid('выход за корень проекта запрещён.');
    if (segments.some(part => FORBIDDEN_SEGMENTS.has(part.toLowerCase()))) {
      throw new WorkspaceFilesError('copy_forbidden_path', `Правило ${rule + 1}: служебные каталоги и зависимости не копируются.`, { rule });
    }
    return segments;
  }

  /** Каждый существующий компонент пути — обычный каталог или файл, не symlink. */
  async function walkWithoutSymlinks(base: string, segments: readonly string[], rule: number, missing: 'error' | 'stop'): Promise<string> {
    let current = base;
    for (const [index, segment] of segments.entries()) {
      current = join(current, segment);
      try {
        if ((await lstat(current)).isSymbolicLink()) {
          throw new WorkspaceFilesError('copy_symlink', `Правило ${rule + 1}: символические ссылки в пути запрещены.`, { rule });
        }
      } catch (error) {
        if (error instanceof WorkspaceFilesError) throw error;
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          if (missing === 'stop') return join(base, ...segments.slice(0, index));
          throw new WorkspaceFilesError('copy_source_missing', `Правило ${rule + 1}: источник не найден.`, { rule, cause: error });
        }
        throw new WorkspaceFilesError('copy_failed', `Правило ${rule + 1}: путь недоступен.`, { rule, cause: error });
      }
    }
    return current;
  }

  async function plan(project: ProjectRecord, workspace: WorkspaceRecord): Promise<CopyPlan[]> {
    const rules = project.config.copyFiles;
    if (rules.length > maxCopyRules) {
      throw new WorkspaceFilesError('copy_limit_exceeded', `Правил копирования больше ${maxCopyRules}.`);
    }
    let realProject: string;
    let realWorkspace: string;
    try {
      [realProject, realWorkspace] = await Promise.all([realpath(project.canonicalPath), realpath(workspace.path)]);
      if (!await inside(root, realWorkspace)) throw new Error('вне корня');
    } catch (error) {
      throw new WorkspaceFilesError('unsafe_workspace_path', 'Workspace должен существовать внутри каталога приложения.', { cause: error });
    }
    const projectPrefix = realProject.endsWith(sep) ? realProject : realProject + sep;
    const workspacePrefix = realWorkspace.endsWith(sep) ? realWorkspace : realWorkspace + sep;
    if (realProject === realWorkspace || realWorkspace.startsWith(projectPrefix) || realProject.startsWith(workspacePrefix)) {
      throw new WorkspaceFilesError('unsafe_workspace_path', 'Workspace не может находиться внутри проекта и наоборот.');
    }

    const seen = new Set<string>();
    const plans: CopyPlan[] = [];
    for (const [rule, value] of rules.entries()) {
      const segments = parseRule(value, rule);
      const key = segments.join('/').toLowerCase();
      if (seen.has(key)) throw new WorkspaceFilesError('copy_collision', `Правило ${rule + 1}: путь повторяется.`, { rule });
      seen.add(key);

      const source = await walkWithoutSymlinks(realProject, segments, rule, 'error');
      const info = await lstat(source);
      if (!info.isFile()) throw new WorkspaceFilesError('invalid_copy_rule', `Правило ${rule + 1}: источник не обычный файл.`, { rule });
      if (info.size > maxCopyBytes) {
        throw new WorkspaceFilesError('copy_limit_exceeded', `Правило ${rule + 1}: файл больше ${maxCopyBytes} байт.`, { rule });
      }
      try {
        const relative = segments.join('/');
        // Код 1 («не отслеживается») — ответ; таймаут или сбой git не превращаются в «не tracked».
        if (await gitTest(realWorkspace, ['ls-files', '--error-unmatch', '--', relative])) {
          throw new WorkspaceFilesError('copy_tracked', `Правило ${rule + 1}: файл отслеживается Git, перезапись запрещена.`, { rule });
        }
        // Файл, не скрытый ignore-правилами, сделал бы workspace «грязным» и сломал бы проверки состояния.
        if (!await gitTest(realWorkspace, ['check-ignore', '-q', '--', relative])) {
          throw new WorkspaceFilesError('copy_not_ignored',
            `Правило ${rule + 1}: файл не скрыт правилами ignore в workspace, копирование сделало бы дерево изменённым.`, { rule });
        }
      } catch (error) {
        if (error instanceof WorkspaceFilesError) throw error;
        throw new WorkspaceFilesError('copy_failed', `Правило ${rule + 1}: не удалось проверить состояние Git.`, { rule, cause: error });
      }

      const existing = await walkWithoutSymlinks(realWorkspace, segments, rule, 'stop');
      const destination = join(realWorkspace, ...segments);
      if (existing === destination) {
        throw new WorkspaceFilesError('copy_collision', `Правило ${rule + 1}: файл назначения уже существует.`, { rule });
      }
      const parents: string[] = [];
      for (let depth = segments.length - 1; depth > 0; depth--) {
        const dir = join(realWorkspace, ...segments.slice(0, depth));
        if (dir === existing || dir.startsWith(existing + sep)) parents.unshift(dir);
      }
      plans.push({ rule, source, destination, parents: parents.filter(dir => dir !== existing), mode: info.mode & 0o700 });
    }
    return plans;
  }

  async function copyOne(item: CopyPlan, created: { files: CreatedFile[]; directories: string[] }): Promise<void> {
    for (const dir of item.parents) {
      try {
        await mkdir(dir, { mode: 0o700 });
        created.directories.push(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (!(await lstat(dir)).isDirectory()) {
          throw new WorkspaceFilesError('copy_collision', `Правило ${item.rule + 1}: на месте каталога назначения лежит другой объект.`, { rule: item.rule });
        }
      }
    }
    const input = await open(item.source, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await input.stat();
      if (!info.isFile() || info.size > maxCopyBytes) {
        throw new WorkspaceFilesError('copy_source_missing', `Правило ${item.rule + 1}: источник изменился перед копированием.`, { rule: item.rule });
      }
      const content = await input.readFile();
      // wx: не перезаписывает и не следует по symlink, возникшему после проверки.
      const output = await open(item.destination, 'wx', item.mode || 0o600);
      const made = await output.stat();
      const record: CreatedFile = { path: item.destination, dev: made.dev, ino: made.ino, digest: undefined };
      created.files.push(record);
      try {
        await output.writeFile(content);
        record.digest = digestOf(content);
      } finally {
        await output.close();
      }
      await options.faultInjector?.('after_file_copied', item.destination);
    } finally {
      await input.close();
    }
  }

  /**
   * Файл удаляется, только если это тот же объект, который создал вызов, и его содержимое не менялось.
   * Заменённый или изменённый пользователем файл остаётся (причина попадает в cleanupFailure).
   * Окно между проверкой и unlink не закрыто: файловая система не даёт атомарного «удалить, если тот же».
   */
  async function removeIfStillOurs(file: CreatedFile): Promise<void> {
    const info = await lstat(file.path).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === 'ENOENT') return undefined;
      throw cause;
    });
    if (!info) return;
    if (!info.isFile() || info.dev !== file.dev || info.ino !== file.ino) throw new ReplacedFile('replaced');
    if (file.digest !== undefined) {
      const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (digestOf(await handle.readFile()) !== file.digest) throw new ReplacedFile('modified');
      } finally {
        await handle.close();
      }
    }
    await unlink(file.path);
  }

  async function copyFiles(project: ProjectRecord, workspace: WorkspaceRecord): Promise<void> {
    if (project.config.copyFiles.length === 0) return;
    const plans = await plan(project, workspace);
    const created = { files: [] as CreatedFile[], directories: [] as string[] };
    try {
      for (const item of plans) await copyOne(item, created);
    } catch (error) {
      // Откат только созданных этим вызовом файлов и каталогов; чужое содержимое не трогается.
      const failures: string[] = [];
      const code = (cause: unknown, fallback: string): string => String((cause as { code?: unknown }).code ?? fallback);
      for (const file of created.files.reverse()) {
        try {
          await removeIfStillOurs(file);
        } catch (cause) {
          failures.push(cause instanceof ReplacedFile ? cause.reason : code(cause, 'unlink'));
        }
      }
      for (const dir of created.directories.reverse()) {
        if ((await readdir(dir).catch(() => ['занят'])).length === 0) await rmdir(dir).catch((cause: unknown) => { failures.push(code(cause, 'rmdir')); });
      }
      if (error instanceof WorkspaceFilesError) {
        throw new WorkspaceFilesError(error.code, error.message, {
          ...(error.rule === undefined ? {} : { rule: error.rule }), cause: error.cause,
          ...(failures.length ? { cleanupFailure: failures.join(',') } : {}),
        });
      }
      throw new WorkspaceFilesError('copy_failed', 'Не удалось скопировать файлы в workspace; созданное этим вызовом удалено.', {
        cause: error, ...(failures.length ? { cleanupFailure: failures.join(',') } : {}),
      });
    }
  }

  async function inspect(workspace: WorkspaceRecord): Promise<'present' | 'missing' | 'uncertain'> {
    let real: string;
    try {
      real = await realpath(workspace.path);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'uncertain';
    }
    try {
      if (!(await lstat(real)).isDirectory() || !await inside(root, real)) return 'uncertain';
      const top = await realpath((await gitRead(real, ['rev-parse', '--show-toplevel'])).trim());
      if (top !== real) return 'uncertain';
      if ((await gitRead(real, ['branch', '--show-current'])).trim() !== workspace.branch) return 'uncertain';
      const bound = (await gitRead(real, ['config', '--local', '--get', `branch.${workspace.branch}.vibestudio-workspace`])).trim();
      return bound === real ? 'present' : 'uncertain';
    } catch {
      return 'uncertain';
    }
  }

  return { inspectProject, allocatePath, copyFiles, inspect };
}
