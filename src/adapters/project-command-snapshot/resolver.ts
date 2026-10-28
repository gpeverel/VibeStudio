import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ProjectCommandRequest } from '../../core/ports/project-command-snapshot.ts';
import type {
  ProjectCommandCoverageLimit, ProjectCommandInputIdentity, ProjectCommandSnapshotIssue,
} from '../../shared/project-command-consent.ts';
import {
  issueFromError, readStable, type ReadBudget, type ReadOutcome, type SnapshotFs, type SnapshotIssue,
} from './file-reader.ts';
import {
  classifyCommand, executionEnvironmentIssue, isUnsupportedShell, parseScriptBody, parseShellFile, SHELL_BUILTINS, shellShebang,
  type CommandSegment,
} from './script-grammar.ts';
import { parseStrictJson, type StrictJsonValue } from './strict-json.ts';

export interface SnapshotLimits {
  readonly maxDepth: number;
  readonly maxSegments: number;
  readonly maxInputs: number;
  readonly manifestBytes: number;
  readonly scriptBytes: number;
  readonly fileBytes: number;
  readonly configBytes: number;
  readonly lockfileBytes: number;
  readonly executableBytes: number;
  readonly totalBytes: number;
}

const MIB = 1024 * 1024;
export const DEFAULT_LIMITS: SnapshotLimits = {
  maxDepth: 8,
  maxSegments: 256,
  maxInputs: 512,
  manifestBytes: MIB,
  scriptBytes: MIB,
  fileBytes: 8 * MIB,
  configBytes: 64 * 1024,
  lockfileBytes: 32 * MIB,
  executableBytes: 256 * MIB,
  totalBytes: 512 * MIB,
};

/** Внутренняя запись входа; `target` — реальный путь символьной ссылки, участвует в fingerprint, но не в DTO. */
export interface InputRecord extends ProjectCommandInputIdentity {
  readonly target: string | null;
}

export interface Analysis {
  readonly realRoot: string;
  readonly cwd: string;
  readonly inputs: readonly InputRecord[];
  readonly limitations: readonly ProjectCommandCoverageLimit[];
  readonly issues: readonly SnapshotIssue[];
}

type InputKind = ProjectCommandInputIdentity['kind'];
interface SearchDir {
  readonly dir: string;
  /** .bin проекта: реальный файл обязан остаться внутри проекта. PATH: системные утилиты допустимы. */
  readonly projectOnly: boolean;
}
interface NpmProject {
  readonly packageDir: string;
  readonly scripts: ReadonlyMap<string, string>;
  readonly lockfile: boolean;
}
interface Scope {
  readonly baseDir: string;
  readonly inShell: boolean;
  readonly dirs: readonly SearchDir[];
  readonly stack: readonly string[];
}
interface Located {
  readonly real: string;
  readonly rel: string;
  readonly target: string | null;
  readonly isProjectFile: boolean;
}

/** Закрытый список ключей проектного .npmrc, не выбирающих код, пакет, оболочку и корень (prefix, workspace,
 * userconfig, script-shell, onload-script и т. п. сюда не входят). Строки `//host/:_authToken=…` — только учётные данные. */
const NPMRC_KEYS = new Set([
  'registry', 'engine-strict', 'legacy-peer-deps', 'save-exact', 'save-prefix', 'fund', 'audit', 'loglevel', 'progress',
  'update-notifier', 'package-lock', 'ignore-scripts', 'fetch-retries', 'fetch-timeout', 'strict-ssl', 'color',
]);

/** Первая строка .npmrc вне закрытого списка: возвращается безопасная метка без значения. */
function npmrcIssue(text: string): string | undefined {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith(';') || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    const key = (eq < 0 ? line : line.slice(0, eq)).trim();
    if (!/^[A-Za-z0-9_@/:.-]+$/.test(key)) return 'npmrc:key_form';
    if (key.startsWith('//')) continue;
    const normalized = key.toLowerCase().replaceAll('_', '-');
    if (/^@[a-z0-9._-]+(?:\/[a-z0-9._-]+)?:registry$/.test(normalized) || NPMRC_KEYS.has(normalized)) continue;
    return `npmrc:key:${label(key)}`;
  }
  return undefined;
}
const SAFE_LABEL = /^[A-Za-z0-9_.:@/+-]{1,64}$/;

function label(value: string): string {
  return SAFE_LABEL.test(value) ? value : 'redacted';
}

function posix(path: string): string {
  return path.split(sep).join('/');
}

class Session {
  readonly inputs = new Map<string, InputRecord>();
  readonly limitations = new Set<ProjectCommandCoverageLimit>(['filesystem_race_after_capture']);
  readonly issues: SnapshotIssue[] = [];
  readonly budget: ReadBudget;
  readonly reads = new Map<string, ReadOutcome>();
  readonly walked = new Set<string>();
  segments = 0;
  npm: NpmProject | undefined;
  pathDirs: readonly SearchDir[] | undefined;
  readonly fs: SnapshotFs;
  readonly limits: SnapshotLimits;
  readonly request: ProjectCommandRequest;
  readonly realRoot: string;
  readonly realCwd: string;

  constructor(fs: SnapshotFs, limits: SnapshotLimits, request: ProjectCommandRequest, realRoot: string, realCwd: string) {
    this.fs = fs;
    this.limits = limits;
    this.request = request;
    this.realRoot = realRoot;
    this.realCwd = realCwd;
    this.budget = { remaining: limits.totalBytes };
  }

  fail(code: ProjectCommandSnapshotIssue, detail: string): void {
    this.issues.push({ code, detail });
  }

  inside(path: string): boolean {
    return path === this.realRoot || path.startsWith(this.realRoot + sep);
  }

  /** Абсолютный путь под запрошенным projectRoot переносится на его канонический вариант. */
  rebase(abs: string): string {
    const requested = resolve(this.request.projectRoot);
    if (requested !== this.realRoot && (abs === requested || abs.startsWith(requested + sep))) {
      return join(this.realRoot, abs.slice(requested.length));
    }
    return abs;
  }

  async read(real: string, maxBytes: number, keepBytes: number, detail: string): Promise<ReadOutcome> {
    const key = `${keepBytes}\0${real}`;
    const cached = this.reads.get(key);
    if (cached) return cached;
    const outcome = await readStable(this.fs, real, { maxBytes, keepBytes, budget: this.budget, detail });
    this.reads.set(key, outcome);
    return outcome;
  }

  add(path: string, kind: InputKind, digest: string | null, target: string | null): void {
    // Ключ включает реальный путь: два toolchain с одинаковым именем в разных каталогах — разные входы.
    const key = `${path}\0${target ?? ''}`;
    const existing = this.inputs.get(key);
    if (existing) {
      // Тот же файл, прочитанный дважды за один снимок, обязан дать тот же результат.
      if (existing.digest !== digest) this.fail('unstable_input', `input:${label(path)}`);
      return;
    }
    if (this.inputs.size >= this.limits.maxInputs) {
      this.fail('limit_exceeded', 'inputs');
      return;
    }
    this.inputs.set(key, { path, kind, digest, target });
  }
}

/** Каноническое расположение файла проекта: границы, символьные ссылки, ошибки доступа. */
async function locate(session: Session, baseDir: string, raw: string, detail: string, allowOutside: boolean): Promise<Located | undefined> {
  if (raw === '' || raw.includes('\0')) {
    session.fail('invalid_request', detail);
    return undefined;
  }
  if (/[*?[\]{}]/.test(raw)) {
    session.fail('ambiguous_path', detail);
    return undefined;
  }
  const abs = session.rebase(isAbsolute(raw) ? resolve(raw) : resolve(baseDir, raw));
  if (!session.inside(abs) && !allowOutside) {
    session.fail('outside_project', detail);
    return undefined;
  }
  let real: string;
  try {
    real = await session.fs.realpath(abs);
  } catch (error) {
    const issue = issueFromError(error, detail);
    session.fail(issue.code, issue.detail);
    return undefined;
  }
  if (!session.inside(real) && !allowOutside) {
    session.fail('outside_project', detail);
    return undefined;
  }
  const isProjectFile = session.inside(real);
  // Реальный путь вне проекта остаётся только в приватном target и хэше fingerprint, не в DTO.
  const target = real === abs ? null : session.inside(real) ? posix(relative(session.realRoot, real)) : real;
  if (session.inside(abs)) {
    const rel = posix(relative(session.realRoot, abs));
    return { real, rel: rel === '' ? '.' : rel, target, isProjectFile };
  }
  // Вне проекта (системный toolchain): в DTO только безопасное имя, идентичность — байты и реальный путь.
  return { real, rel: `toolchain:${label(abs.slice(abs.lastIndexOf(sep) + 1))}`, target: real, isProjectFile };
}

interface ProjectFile {
  readonly rel: string;
  /** Канонический путь только для внутреннего обнаружения циклов; не выводится в диагностике. */
  readonly identity: string;
  /** Принадлежность реального файла проекту не зависит от отображаемой метки пути. */
  readonly isProjectFile: boolean;
  /** Есть, если файл помещается в keepBytes. */
  readonly content: Uint8Array | undefined;
  readonly prefix: Uint8Array;
}

async function readProjectFile(
  session: Session, baseDir: string, raw: string, kind: InputKind, maxBytes: number, keepBytes: number,
  detail: string, allowOutside = false,
): Promise<ProjectFile | undefined> {
  const located = await locate(session, baseDir, raw, detail, allowOutside);
  if (!located) return undefined;
  const outcome = await session.read(located.real, maxBytes, keepBytes, detail);
  if (!outcome.ok) {
    session.fail(outcome.issue.code, outcome.issue.detail);
    return undefined;
  }
  session.add(located.rel, kind, outcome.digest, located.target);
  return {
    rel: located.rel, identity: located.real, isProjectFile: located.isProjectFile,
    content: outcome.content, prefix: outcome.prefix,
  };
}

/** Необязательный файл: отсутствие тоже факт (digest null), чтобы его появление меняло fingerprint. */
async function optionalFile(
  session: Session, dir: string, name: string, kind: InputKind, maxBytes: number, keepBytes: number,
): Promise<{ readonly present: boolean; readonly content: Uint8Array | undefined }> {
  const abs = join(dir, name);
  try {
    await session.fs.lstat(abs);
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : '';
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      session.add(posix(relative(session.realRoot, abs)), kind, null, null);
      return { present: false, content: undefined };
    }
    const issue = issueFromError(error, `optional:${label(name)}`);
    session.fail(issue.code, issue.detail);
    return { present: false, content: undefined };
  }
  const file = await readProjectFile(session, dir, name, kind, maxBytes, keepBytes, `optional:${label(name)}`);
  return { present: file !== undefined, content: file?.content };
}

function projectPathDirs(session: Session): readonly SearchDir[] {
  if (session.pathDirs) return session.pathDirs;
  const raw = session.request.env.PATH ?? '';
  const dirs: SearchDir[] = [];
  for (const entry of raw === '' ? [] : raw.split(':')) {
    // Пустой/относительный элемент PATH зависит от cwd запуска и не фиксируется однозначно.
    if (!isAbsolute(entry)) {
      session.fail('ambiguous_path', 'path_entry_not_absolute');
      continue;
    }
    dirs.push({ dir: session.rebase(resolve(entry)), projectOnly: false });
  }
  session.pathDirs = dirs;
  return dirs;
}

function binDirs(session: Session, packageDir: string): readonly SearchDir[] {
  const dirs: SearchDir[] = [];
  for (let dir = packageDir; ; dir = dirname(dir)) {
    dirs.push({ dir: join(dir, 'node_modules', '.bin'), projectOnly: true });
    if (dir === session.realRoot || dir === dirname(dir)) break;
  }
  return dirs;
}

/** Ищет исполняемый файл по каталогам так же, как оболочка: первый обычный файл с битом исполнения.
 * undefined — не найден; null — найден, но прочитать не удалось (причина уже записана). */
async function resolveBare(session: Session, name: string, dirs: readonly SearchDir[]): Promise<ProjectFile | null | undefined> {
  for (const { dir, projectOnly } of dirs) {
    const candidate = join(dir, name);
    try {
      const real = await session.fs.realpath(candidate);
      const stat = await session.fs.lstat(real);
      if (!stat.isFile() || (stat.mode & 0o111) === 0) continue;
    } catch (error) {
      // Доказанное отсутствие — продолжаем поиск; любая иная ошибка (EIO, EPERM, EACCES) не маскируется.
      const issue = issueFromError(error, `tool:${label(name)}`);
      if (issue.code === 'missing_input') continue;
      session.fail(issue.code, issue.detail);
      return null;
    }
    const file = await readProjectFile(
      session, dir, name, 'executable', session.limits.executableBytes, session.limits.scriptBytes, `tool:${label(name)}`, !projectOnly,
    );
    return file ?? null;
  }
  return undefined;
}

/** Идентичность вызываемой команды: путь с «/» либо имя из каталогов поиска.
 * Содержимое возвращается (если помещается в scriptBytes), чтобы shell-файл можно было разобрать дальше. */
async function resolveHead(session: Session, head: string, scope: Scope, bareDirs: readonly SearchDir[]): Promise<ProjectFile | undefined> {
  if (head.includes('/')) {
    // Абсолютный путь вне проекта допустим как системный toolchain; относительный обязан быть в проекте.
    return readProjectFile(
      session, scope.baseDir, head, 'executable', session.limits.executableBytes, session.limits.scriptBytes,
      `tool:${label(head)}`, isAbsolute(head),
    );
  }
  const found = await resolveBare(session, head, bareDirs);
  if (found === undefined) session.fail('unknown_dependency', `tool:${label(head)}`);
  return found === null ? undefined : found;
}

/** Любая найденная проектная обёртка разбирается одинаково, в том числе вместо node/npm/shell. */
async function resolveExecutable(session: Session, head: string, scope: Scope): Promise<void> {
  await walkExecutable(session, await resolveHead(session, head, scope, scope.dirs), scope);
}

/** Интерпретатор из shebang — существенный вход. Допустимы только `#!/абсолютный/путь` без опций и
 * `#!/…/env <одно имя>`: опции вроде `-l`, `--rcfile` меняют загружаемый код и не принимаются молча. */
async function resolveShebang(session: Session, text: string, scope: Scope): Promise<void> {
  const newline = text.indexOf('\n');
  const words = text.slice(2, newline < 0 ? undefined : newline).trim().split(/\s+/).filter((word) => word !== '');
  const interpreter = words[0];
  if (interpreter === undefined || !interpreter.startsWith('/')) {
    session.fail('unsupported_command', 'shebang:interpreter');
    return;
  }
  const viaEnv = interpreter.slice(interpreter.lastIndexOf('/') + 1) === 'env';
  const target = words[1];
  if (viaEnv ? words.length !== 2 || target === undefined || target.startsWith('-')
      || target.includes('=') || target.includes('/') : words.length !== 1) {
    session.fail('unsupported_command', 'shebang:arguments');
    return;
  }
  if (isUnsupportedShell(viaEnv ? target ?? '' : interpreter)) {
    session.fail('unknown_dependency', 'shebang:unsupported_shell');
    return;
  }
  session.limitations.add('system_toolchain_not_attested');
  await resolveExecutable(session, interpreter, scope);
  if (viaEnv && target !== undefined) await resolveExecutable(session, target, scope);
}

/** Регистрирует файл до обхода интерпретатора и тела, чтобы циклы shebang тоже давали закрытый отказ. */
function enterFile(session: Session, file: ProjectFile, scope: Scope): Scope | undefined {
  const marker = `file:${file.identity}`;
  if (scope.stack.includes(marker)) {
    session.fail('dependency_cycle', `file:${label(file.rel)}`);
    return undefined;
  }
  if (scope.stack.length >= session.limits.maxDepth) {
    session.fail('limit_exceeded', 'depth');
    return undefined;
  }
  return { ...scope, stack: [...scope.stack, marker] };
}

/** Файл проекта: интерпретатор из shebang учитывается; sh/bash разбирается закрытой грамматикой.
 * Прочие (бинарные, node, python) и системные файлы вне проекта — лист: их внутренние вызовы остаются
 * пределом runtime-зависимостей. */
async function walkExecutable(session: Session, file: ProjectFile | undefined, scope: Scope): Promise<void> {
  if (file?.isProjectFile) {
    const inner = enterFile(session, file, scope);
    if (!inner) return;
    // Префикс есть всегда: крупный shell-файл не должен тихо превращаться в непрозрачный лист.
    const text = decode(file.content ?? file.prefix);
    if (text.startsWith('#!')) {
      await resolveShebang(session, text, inner);
      if (shellShebang(text)) {
        await walkShellContents(session, file, inner);
        return;
      }
    }
  }
  session.limitations.add('runtime_dependencies_not_attested');
}

/** Разбирает shell-файл закрытой грамматикой и обходит вызванные им команды; неизвестное — отказ. */
async function walkShellFile(session: Session, file: ProjectFile, scope: Scope): Promise<void> {
  const inner = enterFile(session, file, scope);
  if (inner) await walkShellContents(session, file, inner);
}

/** Файл уже присутствует в stack; прямой запуск shell-файла и shebang используют общий обход тела. */
async function walkShellContents(session: Session, file: ProjectFile, scope: Scope): Promise<void> {
  if (file.content === undefined) {
    session.fail('limit_exceeded', 'shell_file_size');
    return;
  }
  const parsed = parseShellFile(decode(file.content));
  if (!parsed.ok) {
    session.fail(parsed.reason, `shell:${label(file.rel)}:${parsed.detail}`);
    return;
  }
  // Внутри файла выполняет оболочка: echo/true/false — встроенные команды.
  const inner: Scope = { ...scope, inShell: true };
  for (const segment of parsed.segments) await handleSegment(session, segment, inner);
}

function countSegment(session: Session): boolean {
  session.segments += 1;
  if (session.segments > session.limits.maxSegments) {
    session.fail('limit_exceeded', 'segments');
    return false;
  }
  return true;
}

function decode(content: Uint8Array): string {
  return new TextDecoder('utf-8').decode(content);
}

async function findPackageDir(session: Session): Promise<string | undefined> {
  for (let dir = session.realCwd; ; dir = dirname(dir)) {
    try {
      // Любая запись с именем package.json — корень пакета; её тип проверит чтение.
      await session.fs.lstat(join(dir, 'package.json'));
      return dir;
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : '';
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        const issue = issueFromError(error, 'package.json');
        session.fail(issue.code, issue.detail);
        return undefined;
      }
    }
    try {
      const modules = await session.fs.lstat(join(dir, 'node_modules'));
      // npm остановился бы на этом каталоге как на корне пакета без манифеста.
      if (modules.isDirectory()) {
        session.fail('ambiguous_path', 'node_modules_without_manifest');
        return undefined;
      }
    } catch {
      // Отсутствие node_modules — обычный случай.
    }
    if (dir === session.realRoot || dir === dirname(dir)) break;
  }
  session.fail('missing_input', 'package.json');
  return undefined;
}

async function loadNpm(session: Session): Promise<NpmProject | undefined> {
  if (session.npm) return session.npm;
  const packageDir = await findPackageDir(session);
  if (!packageDir) return undefined;
  const manifest = await readProjectFile(session, packageDir, 'package.json', 'manifest', session.limits.manifestBytes, session.limits.manifestBytes, 'package.json');
  if (!manifest?.content) return undefined;
  const parsed = parseStrictJson(decode(manifest.content));
  const root: StrictJsonValue | undefined = parsed.ok ? parsed.value : undefined;
  if (!parsed.ok || root === null || typeof root !== 'object' || Array.isArray(root)) {
    session.fail('ambiguous_manifest', 'manifest_not_object');
    return undefined;
  }
  if (root.workspaces !== undefined) {
    // npm run внутри workspace выбирает другой пакет и манифест; один package.json это не описывает.
    session.fail('unsupported_command', 'manifest:workspaces');
    return undefined;
  }
  if (parsed.duplicates.some((path) => path[0] === 'scripts')) {
    session.fail('ambiguous_manifest', 'duplicate_script_key');
    return undefined;
  }
  const rawScripts = root.scripts;
  const scripts = new Map<string, string>();
  if (rawScripts !== undefined) {
    if (rawScripts === null || typeof rawScripts !== 'object' || Array.isArray(rawScripts)) {
      session.fail('ambiguous_manifest', 'scripts_not_object');
      return undefined;
    }
    for (const [name, body] of Object.entries(rawScripts)) {
      if (typeof body !== 'string') {
        session.fail('ambiguous_manifest', 'script_not_string');
        return undefined;
      }
      scripts.set(name, body);
    }
  }
  const npmrc = await optionalFile(session, packageDir, '.npmrc', 'configuration', session.limits.configBytes, session.limits.configBytes);
  const npmrcProblem = npmrc.content ? npmrcIssue(decode(npmrc.content)) : undefined;
  if (npmrcProblem) session.fail('unsupported_command', npmrcProblem);
  const lock = await optionalFile(session, packageDir, 'package-lock.json', 'lockfile', session.limits.lockfileBytes, 0);
  const shrinkwrap = await optionalFile(session, packageDir, 'npm-shrinkwrap.json', 'lockfile', session.limits.lockfileBytes, 0);
  session.limitations.add('system_toolchain_not_attested');
  session.npm = { packageDir, scripts, lockfile: lock.present || shrinkwrap.present };
  return session.npm;
}

async function walkBody(
  session: Session, npm: NpmProject, scriptName: string, body: string, forwarded: readonly string[], stack: readonly string[],
): Promise<void> {
  const parsed = parseScriptBody(body, forwarded);
  if (!parsed.ok) {
    session.fail(parsed.reason, `script:${label(scriptName)}:${parsed.detail}`);
    return;
  }
  const scope: Scope = { baseDir: npm.packageDir, inShell: true, dirs: [...binDirs(session, npm.packageDir), ...projectPathDirs(session)], stack };
  for (const segment of parsed.segments) await handleSegment(session, segment, scope);
}

async function walkScript(session: Session, npm: NpmProject, name: string, forwarded: readonly string[], stack: readonly string[]): Promise<void> {
  if (stack.includes(name)) {
    session.fail('dependency_cycle', `script:${label(name)}`);
    return;
  }
  if (stack.length >= session.limits.maxDepth) {
    session.fail('limit_exceeded', 'depth');
    return;
  }
  if (!npm.scripts.has(name)) {
    session.fail('missing_input', `script:${label(name)}`);
    return;
  }
  const key = JSON.stringify([name, forwarded]);
  if (session.walked.has(key)) return;
  session.walked.add(key);
  // npm выполняет pre<name> и post<name> автоматически; аргументы получает только основной script.
  for (const [scriptName, args] of [[`pre${name}`, []], [name, forwarded], [`post${name}`, []]] as const) {
    const body = npm.scripts.get(scriptName);
    if (body === undefined) continue;
    await walkBody(session, npm, scriptName, body, args, [...stack, name]);
  }
}

async function handleSegment(session: Session, segment: CommandSegment, scope: Scope): Promise<void> {
  if (!countSegment(session)) return;
  switch (segment.kind) {
    case 'npm_script': case 'npm_install': {
      session.limitations.add('system_toolchain_not_attested');
      await resolveExecutable(session, segment.command, scope);
      const npm = await loadNpm(session);
      if (!npm) return;
      if (segment.kind === 'npm_script') {
        await walkScript(session, npm, segment.script, segment.forwarded, scope.stack);
        return;
      }
      // `npm ci` ставит ровно то, что закреплено lockfile, поэтому lockfile — обязательный вход.
      // Без --ignore-scripts npm запустил бы lifecycle-скрипты ещё не установленных зависимостей:
      // их нельзя перечислить заранее, и это остаётся неизвестной зависимостью, а не пределом.
      session.limitations.add('runtime_dependencies_not_attested');
      if (!npm.lockfile) session.fail('missing_input', 'lockfile');
      if (!segment.ignoreScripts) session.fail('unknown_dependency', 'npm_ci:dependency_lifecycle');
      return;
    }
    case 'node': {
      session.limitations.add('system_toolchain_not_attested');
      session.limitations.add('runtime_dependencies_not_attested');
      await resolveExecutable(session, segment.command, scope);
      for (const file of segment.files) {
        await readProjectFile(session, scope.baseDir, file, 'script', session.limits.scriptBytes, 0, `script:${label(file)}`);
      }
      return;
    }
    case 'shell': {
      session.limitations.add('system_toolchain_not_attested');
      await resolveExecutable(session, segment.command, scope);
      const file = await readProjectFile(
        session, scope.baseDir, segment.file, 'script', session.limits.scriptBytes, session.limits.scriptBytes, `script:${label(segment.file)}`,
      );
      if (file) await walkShellFile(session, file, scope);
      return;
    }
    case 'path': {
      await resolveExecutable(session, segment.path, scope);
      return;
    }
    case 'tool': {
      if (scope.inShell && SHELL_BUILTINS.has(segment.name)) {
        session.limitations.add('system_toolchain_not_attested');
        return;
      }
      await resolveExecutable(session, segment.name, scope);
      return;
    }
  }
}

/** Единственная точка анализа: читает файлы, но не исполняет ничего. Не бросает, кроме непредвиденных сбоев. */
export async function analyze(fs: SnapshotFs, limits: SnapshotLimits, request: ProjectCommandRequest): Promise<Analysis> {
  const empty = (realRoot: string, issue: SnapshotIssue): Analysis => ({ realRoot, cwd: '.', inputs: [], limitations: ['filesystem_race_after_capture'], issues: [issue] });
  let realRoot: string;
  try {
    realRoot = await fs.realpath(resolve(request.projectRoot));
    if (!(await fs.lstat(realRoot)).isDirectory()) return empty('', { code: 'non_regular_input', detail: 'project_root' });
  } catch (error) {
    return empty('', issueFromError(error, 'project_root'));
  }
  let realCwd: string;
  try {
    realCwd = await fs.realpath(resolve(request.cwd));
    if (!(await fs.lstat(realCwd)).isDirectory()) return empty(realRoot, { code: 'non_regular_input', detail: 'cwd' });
  } catch (error) {
    return empty(realRoot, issueFromError(error, 'cwd'));
  }
  if (realCwd !== realRoot && !realCwd.startsWith(realRoot + sep)) return empty(realRoot, { code: 'outside_project', detail: 'cwd' });

  const session = new Session(fs, limits, request, realRoot, realCwd);
  const envIssue = executionEnvironmentIssue(request.env);
  if (envIssue) session.fail('unsupported_command', envIssue);

  const command = request.command;
  if (command.kind === 'npm-script') {
    if (command.script === '' || command.script.startsWith('-')) {
      session.fail('invalid_request', 'script_name');
    } else {
      const scope: Scope = { baseDir: realCwd, inShell: false, dirs: projectPathDirs(session), stack: [] };
      session.limitations.add('system_toolchain_not_attested');
      await resolveExecutable(session, 'npm', scope);
      const npm = await loadNpm(session);
      if (npm) await walkScript(session, npm, command.script, command.args, []);
    }
  } else {
    const classified = classifyCommand([command.executable, ...command.args]);
    if (!classified.ok) {
      session.fail(classified.reason, classified.detail);
    } else {
      const scope: Scope = { baseDir: realCwd, inShell: false, dirs: projectPathDirs(session), stack: [] };
      await handleSegment(session, classified.segment, scope);
    }
    for (const file of command.inputFiles) {
      await readProjectFile(session, realCwd, file, 'file', limits.fileBytes, 0, `input:${label(file)}`);
    }
  }
  if (session.issues.length === 0 && ![...session.inputs.values()].some((input) => input.digest !== null)) {
    session.fail('unknown_dependency', 'no_attested_input');
  }
  const inputs = [...session.inputs.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
  return {
    realRoot,
    cwd: posix(relative(realRoot, realCwd)) || '.',
    inputs,
    limitations: [...session.limitations].sort(),
    issues: session.issues,
  };
}
