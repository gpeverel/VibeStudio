import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import type { AgentDetectOptions } from '../../core/ports/agent.ts';
import type { ProcessRunner } from '../../core/ports/process-runner.ts';
import { buildCodexEnv } from './args.ts';
import type { CodexCapabilities, CodexDetection } from './contracts.ts';

/** Флаги `codex exec`, без которых запуск с профилем codex-read-only-v1 невозможен.
 * Объявления подтверждены в help 0.163.0 диагностикой D3 2026-10-20; исполнение политики не проверено. */
export const REQUIRED_CODEX_FLAGS = ['--json', '--sandbox', '--config', '--ignore-user-config', '--ignore-rules'] as const;
/** D4 той же версии не объявляет --sandbox. Resume получает sandbox_mode через собственный --config
 * (официальный config-reference); наследование флагов родительской команды не предполагается. */
export const REQUIRED_CODEX_RESUME_FLAGS = ['--json', '--config', '--ignore-user-config', '--ignore-rules'] as const;

export function emptyCodexCapabilities(): CodexCapabilities {
  return {
    execJson: false, stdinPrompt: false, resume: false, ephemeral: false, sandbox: false,
    configOverrides: false, ignoreUserConfig: false, ignoreRules: false, model: false, loginStatus: false,
    strictConfig: false, resumeStrictConfig: false,
  };
}

/** Явный путь авторитетен: ошибка по нему не подменяется другим бинарником.
 * Установка через npm — node-shim (shebang `env node`): PATH процесса должен содержать node. */
export async function resolveCodexBinary(options: AgentDetectOptions = {}): Promise<string | null> {
  const env = options.env ?? buildCodexEnv(process.env);
  if (options.binaryPath && !isAbsolute(options.binaryPath)) return null;
  const home = env.HOME || homedir();
  const paths = options.binaryPath ? [options.binaryPath] : [
    ...(env.PATH ?? '').split(delimiter).filter(isAbsolute).map(path => join(path, 'codex')),
    join(home, '.local/bin/codex'), '/opt/homebrew/bin/codex', '/usr/local/bin/codex',
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

const OUTPUT_LIMIT = 262_144;
interface Capture { stdout: string; stderr: string; ok: boolean; code: number | null }

/** stderr читается только для сравнения с известными строками и не покидает функцию в диагностике. */
async function capture(runner: ProcessRunner, executable: string, args: readonly string[], env: Record<string, string>): Promise<Capture> {
  const run = runner.start({ executable, args, cwd: tmpdir(), env, stdin: '', timeoutMs: 5_000, stopGraceMs: 100, drainTimeoutMs: 500, maxQueueBytes: OUTPUT_LIMIT });
  const out: Uint8Array[][] = [[], []];
  let bytes = 0;
  let overflow = false;
  let streamFailed = false;
  // Ошибка потока не отменяет ожидание done: процесс останавливается и его завершение подтверждается runner.
  const drain = async (stream: AsyncIterable<Uint8Array>, chunks: Uint8Array[]): Promise<void> => {
    try {
      for await (const chunk of stream) {
        bytes += chunk.byteLength;
        if (bytes > OUTPUT_LIMIT) { overflow = true; void run.kill().catch(() => undefined); break; }
        chunks.push(chunk);
      }
    } catch { streamFailed = true; void run.kill().catch(() => undefined); }
  };
  const [, , result] = await Promise.all([drain(run.stdout, out[0]!), drain(run.stderr, out[1]!), run.done]);
  const completion = result.completion;
  // Проекции exitCode/signal сами по себе не подтверждают exit/EOF. Не начинаем следующий probe
  // после неизвестного завершения, ошибки потока/cleanup или противоречивого результата runner.
  // Подтверждённый ненулевой exit остаётся диагностическим ответом (например, Not logged in).
  if (overflow || streamFailed || result.error || result.signal !== null || !Number.isSafeInteger(result.exitCode)
    || completion.process.state !== 'exited'
    || completion.process.exitCode !== result.exitCode || completion.process.signal !== result.signal
    || completion.stdout !== 'ended' || completion.stderr !== 'ended'
    || completion.wait !== 'settled' || completion.issues.length) {
    throw new Error('Завершение диагностики Codex не подтверждено; следующие процессы запрещены');
  }
  return {
    stdout: Buffer.concat(out[0]!).toString('utf8'), stderr: Buffer.concat(out[1]!).toString('utf8'),
    ok: result.exitCode === 0 && result.signal === null, code: result.exitCode,
  };
}

/** Объявление опции в начале строки help (`  -c, --config <k=v>`); упоминание флага в описании другого не считается. */
const flagIn = (text: string, flag: string): boolean => new RegExp(`^[ \\t]*(?:-[A-Za-z],[ \\t]+)?${flag}(?=[\\s,=<\\[]|$)`, 'm').test(text);

/** Обнаружение отделено от допуска запуска: описывает готовность binary/interface/auth, а не профиль.
 * Четыре диагностических spawn: --version, exec --help, exec resume --help, login status. */
export async function detectCodex(runner: ProcessRunner, options: AgentDetectOptions = {}): Promise<CodexDetection> {
  const env = buildCodexEnv(options.env ?? process.env);
  const binaryPath = await resolveCodexBinary({ ...options, env });
  const result: CodexDetection = { status: 'unavailable', binaryPath, version: null, auth: 'unknown', capabilities: emptyCodexCapabilities(), unavailable: [] };
  if (!binaryPath) {
    result.unavailable.push({ reason: 'binary_missing', detail: 'Исполняемый файл Codex CLI не найден; укажите абсолютный путь' });
    return result;
  }
  try {
    const version = await capture(runner, binaryPath, ['--version'], env);
    const execHelp = await capture(runner, binaryPath, ['exec', '--help'], env);
    const resumeHelp = await capture(runner, binaryPath, ['exec', 'resume', '--help'], env);
    // Вывод должен назвать сам codex: произвольная строка с числом не считается версией этой CLI.
    result.version = version.ok ? version.stdout.match(/^codex(?:-cli)?\s+(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\s*$/m)?.[1] ?? null : null;
    // Наличие в help доказывает объявленный интерфейс, не его поведение на живом ходе.
    const has = (flag: string): boolean => execHelp.ok && flagIn(execHelp.stdout, flag);
    const resumeHas = (flag: string): boolean => resumeHelp.ok && flagIn(resumeHelp.stdout, flag);
    result.capabilities = {
      execJson: has('--json'), stdinPrompt: execHelp.ok && /\bstdin\b/i.test(execHelp.stdout),
      resume: execHelp.ok && /^\s+resume(?:\s|$)/m.test(execHelp.stdout)
        && REQUIRED_CODEX_RESUME_FLAGS.every(resumeHas) && /\bstdin\b/i.test(resumeHelp.stdout),
      ephemeral: has('--ephemeral'), sandbox: has('--sandbox'), configOverrides: has('--config'),
      ignoreUserConfig: has('--ignore-user-config'), ignoreRules: has('--ignore-rules'), model: has('--model'), loginStatus: false,
      // Проверяем каждый help самостоятельно: global по исходнику не заменяет объявление установки.
      strictConfig: has('--strict-config'), resumeStrictConfig: resumeHas('--strict-config'),
    };
    const missing = REQUIRED_CODEX_FLAGS.filter(flag => !has(flag));
    if (!version.ok || !result.version || !execHelp.ok || missing.length || !result.capabilities.stdinPrompt) result.unavailable.push({
      reason: 'capability_missing',
      detail: missing.length && execHelp.ok ? `CLI не подтвердил обязательные флаги: ${missing.join(', ')}`
        : 'Диагностика интерфейса CLI не завершилась успешно (для npm-установки PATH должен содержать node)',
    });
    // `login status` пишет в stderr: exit 0 — вход выполнен, exit 1 и «Not logged in» — нет. Содержимое не сохраняется.
    const auth = await capture(runner, binaryPath, ['login', 'status'], env);
    if (auth.ok) result.auth = 'authenticated';
    else if (auth.code === 1 && /^Not logged in\s*$/.test(auth.stderr) && !auth.stdout.trim()) result.auth = 'unauthenticated';
    result.capabilities.loginStatus = result.auth !== 'unknown';
    if (result.auth !== 'authenticated') result.unavailable.push({
      reason: result.auth === 'unauthenticated' ? 'not_authenticated' : 'capability_missing',
      detail: result.auth === 'unauthenticated' ? 'Codex CLI не авторизован' : 'Авторизация не подтверждена безопасной диагностикой',
    });
  } catch {
    result.unavailable.push({ reason: 'spawn_failed', detail: 'Ошибка запуска диагностики CLI' });
  }
  // status описывает готовность самой CLI (binary/interface/auth), а не допуск профиля.
  result.status = result.unavailable.length ? 'unavailable' : 'available';
  return result;
}
