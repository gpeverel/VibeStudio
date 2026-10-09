import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import type { AgentCapabilities, AgentDetection, AgentDetectOptions } from '../../core/ports/agent.ts';
import type { ProcessRunner } from '../../core/ports/process-runner.ts';
import { buildClaudeEnv } from './args.ts';

export const REQUIRED_CLAUDE_FLAGS = [
  '--print', '--verbose', '--input-format', '--output-format', '--include-partial-messages',
  '--restricted', '--safe-mode', '--setting-sources', '--strict-mcp-config', '--mcp-config',
  '--tools', '--permission-mode', '--permission-prompts', '--disable-slash-commands',
  '--no-chrome', '--disallowedTools', '--allowedTools', '--append-system-prompt', '--session-id', '--system-prompt-snapshot',
] as const;

export function emptyCapabilities(): AgentCapabilities {
  return {
    streamJson: false, partialMessages: false, sessionId: false, resume: false,
    noSessionPersistence: false, maxTurns: false, restricted: false, safeMode: false,
    tools: false, settingSources: false, strictMcpConfig: false, permissionPrompts: false,
    readOnly: 'unverified',
  };
}

/** Явный путь авторитетен: ошибка по нему не подменяется другим бинарником. */
export async function resolveClaudeBinary(options: AgentDetectOptions = {}): Promise<string | null> {
  const env = options.env ?? buildClaudeEnv(process.env);
  if (options.binaryPath && !isAbsolute(options.binaryPath)) return null;
  const home = env.HOME || homedir();
  const paths = options.binaryPath ? [options.binaryPath] : [
    ...(env.PATH ?? '').split(delimiter).filter(isAbsolute).map(path => join(path, 'claude')),
    join(home, '.local/bin/claude'), join(home, '.claude/local/claude'),
    '/opt/homebrew/bin/claude', '/usr/local/bin/claude', '/usr/bin/claude',
  ];
  for (const candidate of new Set(paths)) {
    try {
      await access(candidate, constants.X_OK);
      const resolved = await realpath(candidate);
      if ((await stat(resolved)).isFile()) return resolved;
    } catch { /* Следующий известный путь без shell и установки CLI. */ }
  }
  return null;
}

async function capture(runner: ProcessRunner, executable: string, args: readonly string[], env: Record<string, string>): Promise<{ output: string; ok: boolean; code: number | null }> {
  const run = runner.start({ executable, args, cwd: tmpdir(), env, stdin: '', timeoutMs: 5_000, stopGraceMs: 100, drainTimeoutMs: 500, maxQueueBytes: 262_144 });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let overflow = false;
  const drain = async (stream: AsyncIterable<Uint8Array>, keep: boolean): Promise<void> => {
    for await (const chunk of stream) {
      bytes += chunk.byteLength;
      if (bytes > 262_144) { overflow = true; void run.kill(); break; }
      if (keep) chunks.push(chunk);
    }
  };
  const [, , result] = await Promise.all([drain(run.stdout, true), drain(run.stderr, false), run.done]);
  return { output: Buffer.concat(chunks).toString('utf8'), ok: !overflow && !result.error && result.exitCode === 0 && !result.signal, code: result.exitCode };
}

export async function detectClaude(runner: ProcessRunner, options: AgentDetectOptions = {}): Promise<AgentDetection> {
  const env = buildClaudeEnv(options.env ?? process.env);
  const binaryPath = await resolveClaudeBinary({ ...options, env });
  const result: AgentDetection = { status: 'unavailable', binaryPath, version: null, auth: 'unknown', capabilities: emptyCapabilities(), unavailable: [] };
  if (!binaryPath) {
    result.unavailable.push({ reason: 'binary_missing', detail: 'Исполняемый файл Claude CLI не найден; укажите абсолютный путь' });
    return result;
  }
  try {
    const version = await capture(runner, binaryPath, ['--version'], env);
    const help = await capture(runner, binaryPath, ['--help'], env);
    result.version = version.ok ? version.output.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0] ?? null : null;
    // Наличие в help доказывает объявленный интерфейс, не его поведение на живом ходе.
    const has = (flag: string): boolean => help.ok && new RegExp(`(?:^|[\\s,])${flag}(?=[\\s,=<]|$)`, 'm').test(help.output);
    result.capabilities = {
      streamJson: has('--output-format') && help.output.includes('stream-json'),
      partialMessages: has('--include-partial-messages'), sessionId: has('--session-id'),
      resume: has('--resume'), noSessionPersistence: has('--no-session-persistence'),
      maxTurns: has('--max-turns'), restricted: has('--restricted'), safeMode: has('--safe-mode'),
      tools: has('--tools'), settingSources: has('--setting-sources'),
      strictMcpConfig: has('--strict-mcp-config'), permissionPrompts: has('--permission-prompts'),
      readOnly: 'unverified',
    };
    const missing = REQUIRED_CLAUDE_FLAGS.filter(flag => !has(flag));
    if (!version.ok || !help.ok || missing.length || !result.capabilities.streamJson) result.unavailable.push({
      reason: 'capability_missing', detail: missing.length ? `CLI не подтвердил обязательные флаги: ${missing.join(', ')}` : 'Диагностика интерфейса CLI не завершилась успешно',
    });
    if (result.capabilities.safeMode && result.capabilities.restricted) {
      const auth = await capture(runner, binaryPath, ['--safe-mode', '--restricted', 'auth', 'status'], env);
      try {
        const status: unknown = JSON.parse(auth.output);
        const loggedIn = status && typeof status === 'object' && 'loggedIn' in status ? status.loggedIn : undefined;
        if (auth.ok && loggedIn === true) result.auth = 'authenticated';
        else if (loggedIn === false && (auth.code === 0 || auth.code === 1)) result.auth = 'unauthenticated';
      } catch { /* Не печатать stdout: статус может содержать персональные данные. */ }
    }
    if (result.auth !== 'authenticated') result.unavailable.push({
      reason: result.auth === 'unauthenticated' ? 'not_authenticated' : 'capability_missing',
      detail: result.auth === 'unauthenticated' ? 'Claude CLI не авторизован' : 'Авторизация не подтверждена безопасной диагностикой',
    });
    result.unavailable.push({ reason: 'profile_unverified', detail: 'Границы read-only не подтверждены реальными пробами для выбранной среды' });
  } catch {
    result.unavailable.push({ reason: 'spawn_failed', detail: 'Ошибка запуска диагностики CLI' });
  }
  // detect не имеет конкретного cwd/профиля и потому не может подтвердить read-only.
  result.status = result.unavailable.length ? 'unavailable' : 'available';
  return result;
}
