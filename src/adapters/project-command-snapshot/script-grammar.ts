/**
 * Закрытая грамматика команд P4. Это не анализатор shell: тело script принимается только как
 * последовательность простых команд через `&&`, `||`, `;` без подстановок, перенаправлений,
 * каналов и фоновых запусков. Всё остальное отклоняется с типизированной причиной, а не
 * «угадывается». Чистый модуль без Node-API.
 *
 * Поддерживаемые простые команды (после необязательных `NAME=value`):
 *   npm run|run-script <script> [-- args…], npm test|start, npm ci [--ignore-scripts];
 *   node [безопасные флаги] <файл…> [args…];  sh|bash <файл> [args…];
 *   путь с «/» (./scripts/x.sh, node_modules/.bin/x) — файл проекта;
 *   имя инструмента (ищется в node_modules/.bin и PATH, находится — хэшируется, нет — отказ).
 * Имена node/npm/sh/bash распознаются и в относительных путях. Известные неподдержанные
 * интерпретаторы не считаются обычными инструментами с непрозрачными аргументами.
 * Всё, что аргументы инструмента читают сами (тесты, конфигурации, плагины), грамматика не видит.
 */
export type CommandSegment =
  /** forwarded — хвост после `--`: npm дописывает его к последней команде основного script. */
  | { readonly kind: 'npm_script'; readonly command: string; readonly script: string; readonly forwarded: readonly string[] }
  | { readonly kind: 'npm_install'; readonly command: string; readonly clean: boolean; readonly ignoreScripts: boolean }
  | { readonly kind: 'node'; readonly command: string; readonly files: readonly string[] }
  | { readonly kind: 'shell'; readonly command: string; readonly file: string }
  | { readonly kind: 'path'; readonly path: string }
  | { readonly kind: 'tool'; readonly name: string };

export type SegmentRejectionReason = 'unsupported_command' | 'unknown_dependency';

/** Деталь — короткий код/метка из безопасного алфавита; значения аргументов и env сюда не попадают. */
export interface SegmentRejection {
  readonly reason: SegmentRejectionReason;
  readonly detail: string;
}

export type SegmentResult =
  | { readonly ok: true; readonly segment: CommandSegment }
  | ({ readonly ok: false } & SegmentRejection);

export type ScriptBodyResult =
  | { readonly ok: true; readonly segments: readonly CommandSegment[] }
  | ({ readonly ok: false } & SegmentRejection);

/** Встроенные команды sh: в теле script не требуют исполняемого файла. В прямом запуске их нет. */
export const SHELL_BUILTINS: ReadonlySet<string> = new Set(['echo', 'true', 'false']);

const MAX_BODY_LENGTH = 64 * 1024;
const FORBIDDEN_CHARS = new Set(['<', '>', '`', '$', '(', ')', '{', '}', '\\', '!']);
const GLOB_CHARS = /[*?[\]{}]/;
const SAFE_LABEL = /^[A-Za-z0-9_.:@/+-]{1,64}$/;

/** Переменные, меняющие, какой код будет загружен или каким интерпретатором выполнен запуск. */
const EXECUTION_ENV = /^(?:PATH|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|BASH_ENV|ENV|SHELL|IFS|LD_.+|DYLD_.+|npm_config_.+|NPM_CONFIG_.+)$/;

/** Закрытый список безопасных значений NODE_OPTIONS; любая иная форма может подгрузить код (`-r./x.cjs`). */
const NODE_OPTION_TOKEN = /^(?:--max-old-space-size=\d+|--max-semi-space-size=\d+|--stack-trace-limit=\d+|--no-warnings|--no-deprecation|--trace-warnings|--trace-deprecation|--enable-source-maps|--disable-warning=[A-Za-z0-9_-]+)$/;

/** Настройки npm из окружения, не влияющие на выбор кода, конфигов и оболочки. */
const NPM_CONFIG_ENV = /^npm_config_(?:loglevel|progress|audit|fund|color|update[-_]notifier)$/i;

/** Служебные слова оболочки: управляющие конструкции грамматика не поддерживает. */
const RESERVED_WORDS: ReadonlySet<string> = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'select',
  'function', 'in', '[[', ']]', '{', '}',
]);

/** Обёртки скрывают настоящий исполняемый вход, поэтому он остаётся неизвестной зависимостью. */
const WRAPPERS: ReadonlySet<string> = new Set([
  'env', 'sudo', 'doas', 'xargs', 'nohup', 'time', 'timeout', 'command', 'exec', 'eval', 'cd', 'pushd',
  'popd', 'source', '.', 'export', 'unset', 'set', 'trap', 'alias', 'npx', 'pnpm', 'pnpx', 'yarn', 'bun',
  'bunx', 'deno', 'cross-env', 'dotenv', 'env-cmd', 'concurrently', 'npm-run-all', 'run-s', 'run-p',
  'start-server-and-test', 'parallelshell', 'nodemon',
]);
const UNSUPPORTED_SHELLS: ReadonlySet<string> = new Set(['zsh', 'dash', 'ash', 'ksh', 'fish', 'csh', 'tcsh']);
const UNSUPPORTED_INTERPRETERS: ReadonlySet<string> = new Set([
  'nodejs', 'perl', 'ruby', 'php', 'lua', 'luajit', 'tclsh', 'wish', 'busybox',
]);
const PYTHON_INTERPRETER = /^(?:python|pypy)(?:[23](?:\.\d+)*)?$/;
const DESTRUCTIVE: ReadonlySet<string> = new Set([
  'rm', 'rmdir', 'unlink', 'shred', 'dd', 'truncate', 'mkfs', 'rimraf', 'del', 'del-cli', 'trash', 'trash-cli',
]);
const NPM_PUBLISH: ReadonlySet<string> = new Set([
  'publish', 'unpublish', 'deprecate', 'dist-tag', 'access', 'owner', 'token', 'login', 'logout', 'adduser',
  'team', 'org', 'profile', 'hook', 'star', 'unstar',
]);
const NPM_RUN: ReadonlySet<string> = new Set(['run', 'run-script', 'rum', 'urn']);
const NPM_TEST: ReadonlySet<string> = new Set(['test', 't', 'tst']);
const NPM_CLEAN_INSTALL: ReadonlySet<string> = new Set(['ci', 'ic', 'clean-install']);
const NPM_INSTALL: ReadonlySet<string> = new Set(['install', 'i', 'add']);
const NPM_FLAGS: ReadonlySet<string> = new Set([
  '--silent', '-s', '--quiet', '-q', '--no-audit', '--no-fund', '--offline', '--prefer-offline', '--no-progress',
]);
const NODE_FLAGS: ReadonlySet<string> = new Set([
  '--test', '--no-warnings', '--enable-source-maps', '--experimental-strip-types', '--experimental-transform-types',
]);

function label(value: string): string {
  return SAFE_LABEL.test(value) ? value : 'redacted';
}

function unsupported(detail: string): SegmentResult {
  return { ok: false, reason: 'unsupported_command', detail };
}

function unknown(detail: string): SegmentResult {
  return { ok: false, reason: 'unknown_dependency', detail };
}

function ok(segment: CommandSegment): SegmentResult {
  return { ok: true, segment };
}

function baseName(token: string): string {
  return token.slice(token.lastIndexOf('/') + 1);
}

/** Неподдержанная shell-грамматика остаётся неизвестной и при выборе через shebang. */
export function isUnsupportedShell(command: string): boolean {
  return UNSUPPORTED_SHELLS.has(baseName(command));
}

function isPlainPath(token: string): boolean {
  return token.length > 0 && !token.startsWith('-') && !GLOB_CHARS.test(token) && !token.includes('\0');
}

function flagName(token: string): string {
  const eq = token.indexOf('=');
  return label(eq < 0 ? token : token.slice(0, eq));
}

/** Разбирает аргументы npm после слова `npm`. */
function classifyNpm(command: string, args: readonly string[]): SegmentResult {
  let ignoreScripts = false;
  /** До `--` каждый флаг обязан быть из закрытого списка (npm разбирает их в любой позиции);
   * нефлаговые токены и всё после `--` npm пересылает script, поэтому они возвращаются для анализа. */
  const scan = (from: number, allowIgnoreScripts: boolean): { readonly forwarded: readonly string[] } | SegmentResult => {
    const positional: string[] = [];
    for (let i = from; i < args.length; i += 1) {
      const token = args[i] as string;
      if (token === '--') return { forwarded: [...positional, ...args.slice(i + 1)] };
      if (!token.startsWith('-')) {
        positional.push(token);
        continue;
      }
      if (NPM_FLAGS.has(token) || /^--loglevel=(?:silent|error|warn|info)$/.test(token)) continue;
      if (allowIgnoreScripts && token === '--ignore-scripts') {
        ignoreScripts = true;
        continue;
      }
      return unsupported(`npm_option:${flagName(token)}`);
    }
    return { forwarded: positional };
  };
  const rejected = (value: { readonly forwarded: readonly string[] } | SegmentResult): value is SegmentResult => 'ok' in value;
  // Флаги перед подкомандой: тот же закрытый список.
  let index = 0;
  while (index < args.length && (args[index] as string).startsWith('-') && args[index] !== '--') {
    const token = args[index] as string;
    if (!NPM_FLAGS.has(token) && !/^--loglevel=(?:silent|error|warn|info)$/.test(token)) return unsupported(`npm_option:${flagName(token)}`);
    index += 1;
  }
  const sub = args[index];
  if (sub === undefined || sub === '--') return unsupported('npm_subcommand:none');
  index += 1;
  if (NPM_PUBLISH.has(sub)) return unsupported(`publish_operation:${label(sub)}`);
  if (NPM_TEST.has(sub) || sub === 'start') {
    const tail = scan(index, false);
    if (rejected(tail)) return tail;
    return ok({ kind: 'npm_script', command, script: sub === 'start' ? 'start' : 'test', forwarded: tail.forwarded });
  }
  if (NPM_RUN.has(sub)) {
    // Имя script — первый нефлаговый токен; флаги до него тоже из закрытого списка.
    while (index < args.length && (args[index] as string).startsWith('-') && args[index] !== '--') {
      const token = args[index] as string;
      if (!NPM_FLAGS.has(token) && !/^--loglevel=(?:silent|error|warn|info)$/.test(token)) return unsupported(`npm_option:${flagName(token)}`);
      index += 1;
    }
    const script = args[index];
    if (script === undefined || script === '--') return unsupported('npm_run:no_script');
    const tail = scan(index + 1, false);
    if (rejected(tail)) return tail;
    return ok({ kind: 'npm_script', command, script, forwarded: tail.forwarded });
  }
  if (NPM_CLEAN_INSTALL.has(sub)) {
    const tail = scan(index, true);
    if (rejected(tail)) return tail;
    if (tail.forwarded.length > 0) return unsupported('npm_install:with_packages');
    return ok({ kind: 'npm_install', command, clean: true, ignoreScripts });
  }
  if (NPM_INSTALL.has(sub)) {
    // `npm install` выбирает версии из реестра: что именно будет установлено и запущено, не закреплено.
    return unknown('npm_install:not_pinned');
  }
  return unsupported(`npm_subcommand:${label(sub)}`);
}

function classifyNode(command: string, args: readonly string[]): SegmentResult {
  let testMode = false;
  let index = 0;
  for (; index < args.length; index += 1) {
    const token = args[index] as string;
    if (!token.startsWith('-')) break;
    if (!NODE_FLAGS.has(token)) return unsupported(`node_option:${flagName(token)}`);
    if (token === '--test') testMode = true;
  }
  const first = args[index];
  if (first === undefined) return unsupported('node:no_entry_file');
  const files = [first];
  if (testMode) {
    for (let next = index + 1; next < args.length; next += 1) {
      const token = args[next] as string;
      if (token.startsWith('-')) break;
      files.push(token);
    }
  }
  if (!files.every(isPlainPath)) return unsupported('node:entry_not_plain_path');
  return ok({ kind: 'node', command, files });
}

function classifyShell(command: string, args: readonly string[]): SegmentResult {
  const file = args[0];
  if (file === undefined) return unsupported('shell:no_file');
  if (!isPlainPath(file)) return unsupported('shell:not_plain_file');
  return ok({ kind: 'shell', command, file });
}

/** Классифицирует уже разделённые токены: argv прямого запуска либо одна команда из тела script. */
export function classifyCommand(tokens: readonly string[]): SegmentResult {
  const head = tokens[0];
  if (head === undefined || head === '') return unsupported('empty_command');
  if (tokens.some((token) => token.includes('\0'))) return unsupported('nul_in_command');
  if (RESERVED_WORDS.has(head)) return unsupported('syntax:shell_keyword');
  const args = tokens.slice(1);
  // Способ записи пути не меняет семантику argv: ./tools/node тоже выбирает entrypoint.
  const special = baseName(head);
  if (WRAPPERS.has(special)) return unknown(`wrapper:${label(special)}`);
  if (isUnsupportedShell(head) || UNSUPPORTED_INTERPRETERS.has(special) || PYTHON_INTERPRETER.test(special)) {
    return unknown(`interpreter:${label(special)}`);
  }
  if (DESTRUCTIVE.has(special)) return unsupported(`destructive_operation:${label(special)}`);
  switch (special) {
    case 'npm': return classifyNpm(head, args);
    case 'node': return classifyNode(head, args);
    case 'sh': case 'bash': return classifyShell(head, args);
    // Конфигурация git (pager, external diff, hooks) не аттестуется, поэтому git не считается известным входом.
    case 'git': return args[0] === 'push' ? unsupported('publish_operation:git_push') : unknown('tool:git');
    default: break;
  }
  if (head.includes('/')) {
    return isPlainPath(head) ? ok({ kind: 'path', path: head }) : unsupported('path_not_plain');
  }
  if (GLOB_CHARS.test(head) || head.startsWith('-')) return unsupported('tool_name_not_plain');
  return ok({ kind: 'tool', name: head });
}

interface Tokenized {
  readonly commands: readonly (readonly string[])[];
}

function tokenize(body: string): Tokenized | SegmentRejection {
  const bad = (detail: string): SegmentRejection => ({ reason: 'unsupported_command', detail });
  const commands: string[][] = [];
  let current: string[] = [];
  let token = '';
  let hasToken = false;
  let dangling = false;
  const flushToken = (): void => {
    if (!hasToken) return;
    current.push(token);
    token = '';
    hasToken = false;
    dangling = false;
  };
  const flushCommand = (): boolean => {
    flushToken();
    if (current.length === 0) return false;
    commands.push(current);
    current = [];
    return true;
  };
  let i = 0;
  while (i < body.length) {
    const ch = body[i] as string;
    if (ch === "'") {
      const end = body.indexOf("'", i + 1);
      if (end < 0) return bad('syntax:unterminated_quote');
      token += body.slice(i + 1, end);
      hasToken = true;
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      let end = i + 1;
      while (end < body.length && body[end] !== '"') {
        const inner = body[end] as string;
        if (inner === '$' || inner === '`' || inner === '\\' || inner === '!') return bad('syntax:expansion_in_quotes');
        end += 1;
      }
      if (end >= body.length) return bad('syntax:unterminated_quote');
      token += body.slice(i + 1, end);
      hasToken = true;
      i = end + 1;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      flushToken();
      i += 1;
      continue;
    }
    if (ch === '\n' || ch === '\r') return bad('syntax:multiline');
    if (ch === ';') {
      if (!flushCommand()) return bad('syntax:empty_command');
      i += 1;
      continue;
    }
    if (ch === '&' || ch === '|') {
      if (body[i + 1] !== ch) return bad(ch === '&' ? 'syntax:background' : 'syntax:pipe');
      if (!flushCommand()) return bad('syntax:empty_command');
      dangling = true;
      i += 2;
      continue;
    }
    if (FORBIDDEN_CHARS.has(ch)) return bad('syntax:expansion_or_redirect');
    if (!hasToken && (ch === '#' || ch === '~')) return bad('syntax:comment_or_home');
    token += ch;
    hasToken = true;
    i += 1;
  }
  flushToken();
  if (current.length > 0) commands.push(current);
  if (dangling) return bad('syntax:dangling_operator');
  return { commands };
}

/** Разбор тела script из package.json. Первая же неподдержанная команда делает весь script неподдержанным.
 * forwarded — аргументы после `--` для основного script: npm добавляет их к последней команде. */
export function parseScriptBody(body: string, forwarded: readonly string[] = []): ScriptBodyResult {
  if (body.length === 0 || body.trim().length === 0) return { ok: false, reason: 'unsupported_command', detail: 'empty_script' };
  if (body.length > MAX_BODY_LENGTH) return { ok: false, reason: 'unsupported_command', detail: 'script_too_long' };
  const tokenized = tokenize(body);
  if (!('commands' in tokenized)) return { ok: false, ...tokenized };
  const segments: CommandSegment[] = [];
  const last = tokenized.commands.length - 1;
  for (const [position, command] of tokenized.commands.entries()) {
    let start = 0;
    while (start < command.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(command[start] as string)) {
      const name = (command[start] as string).slice(0, (command[start] as string).indexOf('='));
      if (EXECUTION_ENV.test(name) || /^npm_config_/i.test(name)) {
        return { ok: false, reason: 'unsupported_command', detail: `env_assignment:${label(name)}` };
      }
      start += 1;
    }
    if (start === command.length) return { ok: false, reason: 'unsupported_command', detail: 'syntax:assignment_only' };
    const tokens = command.slice(start);
    if (position === last) tokens.push(...forwarded);
    const result = classifyCommand(tokens);
    if (!result.ok) return result;
    segments.push(result.segment);
  }
  return { ok: true, segments };
}

/** Окружение запроса, которое подгружает неаттестованный код или меняет оболочку npm.
 * Возвращается только имя переменной: значения не попадают в диагностику. */
export function executionEnvironmentIssue(env: Readonly<Record<string, string>>): string | undefined {
  for (const name of Object.keys(env).sort()) {
    const value = env[name] ?? '';
    // Экспортированные bash-функции подменяют любую команду внутри поддержанного bash-файла.
    if (name.startsWith('BASH_FUNC_')) return `env_name:${label(name.slice(0, 20))}`;
    if (value === '') continue;
    if (/^(?:BASH_ENV|ENV|LD_.+|DYLD_.+)$/.test(name)) {
      return `env_name:${label(name)}`;
    }
    // Любая конфигурация npm из окружения может подменить пользовательский конфиг, prefix или shell:
    // допускается только закрытый список безвредных настроек вывода.
    if (/^npm_config_/i.test(name) && !NPM_CONFIG_ENV.test(name)) return `env_name:${label(name)}`;
    if (name === 'NODE_OPTIONS' && !value.trim().split(/\s+/).every((token) => NODE_OPTION_TOKEN.test(token))) {
      return `env_name:${label(name)}`;
    }
  }
  return undefined;
}

const SHELL_SET_LINE = /^set(?:\s+(?:-[eufx]+|-o\s+pipefail))+$/;

/**
 * Shell-файл поддерживается только в той же закрытой грамматике, построчно: комментарии, пустые строки
 * и `set -eu[x]`/`set -o pipefail` пропускаются, каждая остальная строка — простые команды. Функции,
 * if/for, переменные, подстановки и продолжения строк — отказ, а не молчаливый пропуск вызванных файлов.
 */
export function parseShellFile(text: string): ScriptBodyResult {
  if (text.includes('\r')) return { ok: false, reason: 'unsupported_command', detail: 'syntax:crlf' };
  if (text.includes('\0')) return { ok: false, reason: 'unsupported_command', detail: 'syntax:nul' };
  const segments: CommandSegment[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.endsWith('\\')) return { ok: false, reason: 'unsupported_command', detail: 'syntax:line_continuation' };
    if (SHELL_SET_LINE.test(line)) continue;
    const parsed = parseScriptBody(line);
    if (!parsed.ok) return parsed;
    segments.push(...parsed.segments);
  }
  return { ok: true, segments };
}

/** Первая строка `#!/bin/sh`, `#!/usr/bin/env bash` и т. п.: файл исполняет sh или bash. */
export function shellShebang(text: string): boolean {
  const first = text.slice(0, text.indexOf('\n') < 0 ? undefined : text.indexOf('\n')).trim();
  if (!first.startsWith('#!')) return false;
  const words = first.slice(2).trim().split(/\s+/);
  const interpreter = baseName(words[0] ?? '');
  const name = interpreter === 'env' ? (words[1] ?? '') : interpreter;
  return name === 'sh' || name === 'bash';
}
