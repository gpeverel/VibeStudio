import { buildAgentInstructions } from '../../core/agent-instructions.ts';
import type { AgentEnvironment } from '../../core/ports/agent.ts';
import { CODEX_ENV_ALLOWLIST, CODEX_POLICY_CONFIG, CODEX_SANDBOX_POLICY_CONFIG } from './contracts.ts';
import type { CodexRunRequest } from './contracts.ts';
import { isCodexThreadRef, validateCodexProfile } from './profile.ts';

/** HOME/CODEX_HOME сохраняют штатную авторизацию (auth.json или keyring); содержимое не читается и не журналируется.
 * CODEX_API_KEY — документированный ключ именно для `codex exec`. PATH нужен node-shim установки через npm;
 * локаль — UTF-8; TMPDIR — служебным файлам. NODE_OPTIONS, DYLD-переменные, прокси, произвольные OPENAI-
 * и CODEX-переменные и env проекта не наследуются (`login status` CODEX_API_KEY не учитывает:
 * он не подтверждает такой вход). */
export { CODEX_ENV_ALLOWLIST } from './contracts.ts';

/** Явно заданные имена вне allowlist: адаптер отклоняет их до prompt, а не отбрасывает молча. */
export function forbiddenEnvNames(env: Readonly<Record<string, string | undefined>>): string[] {
  return Object.keys(env).filter(name => env[name] !== undefined && (!(CODEX_ENV_ALLOWLIST as readonly string[]).includes(name) || env[name]!.includes('\0')));
}

export function buildCodexEnv(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of CODEX_ENV_ALLOWLIST) {
    const value = source[name];
    if (value !== undefined && !value.includes('\0')) env[name] = value;
  }
  return env;
}

/** JSON-строка является допустимой TOML basic string, кроме сырого DEL. Значение `-c` разбирается как TOML. */
const tomlString = (value: string): string => JSON.stringify(value).replaceAll('\u007f', '\\u007f');
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

/** Legacy resume передаёт sandbox_mode через -c: его help не объявляет --sandbox.
 * Новый профиль first/resume использует один набор named permissions без legacy overrides.
 * --strict-config проверяется отдельно для каждого интерфейса; сама передача не выдаёт допуск.
 * Канал инструкций — config `developer_instructions` (config-reference); у Codex нет аналога
 * `--append-system-prompt`. Применение модели при first/resume подтверждает только живое наблюдение. */
function policyOptions(request: CodexRunRequest): string[] {
  const named = request.profile.kind === 'codex-sandbox-read-v1';
  const sandbox = named ? ['--strict-config'] : request.resume
    ? ['-c', 'sandbox_mode="read-only"']
    : ['--sandbox', 'read-only'];
  const options = [
    '--json', ...sandbox, '--ignore-user-config', '--ignore-rules',
    '-c', `approval_policy=${tomlString(request.profile.approvalPolicy)}`,
    ...(named ? CODEX_SANDBOX_POLICY_CONFIG : CODEX_POLICY_CONFIG).flatMap(value => ['-c', value]),
    '-c', 'check_for_update_on_startup=false',
    '-c', 'analytics.enabled=false',
    '-c', `developer_instructions=${tomlString(buildAgentInstructions({ resume: request.resume }))}`,
  ];
  if (request.persistSession === false) options.push('--ephemeral');
  if (request.model) options.push('--model', request.model);
  return options;
}

export function buildCodexArgs(request: CodexRunRequest): { args: string[]; stdin: string; env: Record<string, string> } {
  const issues = validateCodexProfile(request.profile, request.cwd);
  if (issues.length) throw new Error(issues[0]!.detail);
  if (typeof request.resume !== 'boolean') throw new Error('resume должен быть задан явно');
  if (request.resume) {
    if (!isCodexThreadRef(request.thread)) throw new Error('Resume требует ссылку на диалог Codex (UUID thread_id этого адаптера)');
  } else if ((request as { thread?: unknown }).thread !== undefined) {
    throw new Error('Первый ход не принимает CLI-ID: Codex выдаёт его в thread.started');
  }
  if (request.maxTurns !== undefined) throw new Error('Codex exec не имеет подтверждённого ограничения числа ходов');
  if (request.resume && request.persistSession === false) throw new Error('Resume требует сохранения диалога');
  if (request.model !== undefined && (typeof request.model !== 'string' || !MODEL.test(request.model))) throw new Error('Некорректное имя модели');
  if ([request.sessionId, request.turnId, request.participantId, request.workspaceId].some(id => typeof id !== 'string' || !id || id.length > 256)) throw new Error('Не заданы идентификаторы запуска');
  if (typeof request.prompt !== 'string' || Buffer.byteLength(request.prompt) > 10_000_000) throw new Error('Превышен размер prompt');
  const options = policyOptions(request);
  // Prompt только через stdin ("-"); ID истории — отдельный аргумент массива, не часть shell-строки.
  const args = request.resume
    ? ['exec', 'resume', ...options, request.thread.threadId, '-']
    : ['exec', ...options, '-'];
  return { args, stdin: request.prompt, env: buildCodexEnv(request.env as AgentEnvironment) };
}
