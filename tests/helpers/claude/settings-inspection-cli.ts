import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Writable } from 'node:stream';
import { buildClaudeEnv } from '../../../src/adapters/claude/args.ts';
import { superviseSettingsInspection } from './settings-inspection-supervisor.ts';
import { inspectionMetadata } from './settings-inspection-worker.ts';

/** Фиксированный одноразовый диагностический стенд, не production admission.
 * Наличие флага не является разрешением пользователя; каждый реальный запуск согласуется отдельно. */
export const PREPARED_INSPECTION = Object.freeze({
  executable: '/opt/homebrew/bin/claude',
  resolvedExecutable: '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe',
  executableSha256: '0116ee2e0a513900b633d9951367f18747686478e2b462805b8c31609f047f70',
  executableSize: 239695888,
  cwd: '/private/tmp/vs-policy-inspect-p2b-04-vZWONW', cwdDev: 16777229, cwdIno: 66602142,
  argv: Object.freeze([
    '--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--restricted', '--safe-mode', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--tools', 'Read,Glob,Grep', '--allowedTools', 'Read,Glob,Grep', '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
    '--disable-slash-commands', '--no-chrome', '--disallowedTools', 'Bash,PowerShell,Edit,Write,NotebookEdit,Agent,Task,Skill,WebFetch,WebSearch',
    '--no-session-persistence', '--system-prompt-snapshot', 'off',
  ]),
});
export type InspectionPreflightCode = 'env_token_present' | 'environment_kind_present' | 'home_invalid' | 'config_dir_invalid' | 'executable_changed'
  | 'cwd_changed' | 'preflight_failed';
export function inspectionEnvironment(source: Readonly<Record<string, string | undefined>>):
  { ok: true; env: Readonly<Record<string, string>> } | { ok: false; reason: InspectionPreflightCode } {
  // Проверяются только имена: даже пустое значение или getter не читается.
  if (['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'].some(name => Object.hasOwn(source, name)))
    return { ok: false, reason: 'env_token_present' };
  if (Object.hasOwn(source, 'CLAUDE_CODE_ENVIRONMENT_KIND')) return { ok: false, reason: 'environment_kind_present' };
  if (!source.HOME || !isAbsolute(source.HOME) || source.HOME.includes('\0')) return { ok: false, reason: 'home_invalid' };
  if (source.CLAUDE_CONFIG_DIR !== undefined && (!isAbsolute(source.CLAUDE_CONFIG_DIR) || source.CLAUDE_CONFIG_DIR.includes('\0'))) return { ok: false, reason: 'config_dir_invalid' };
  return { ok: true, env: Object.freeze(buildClaudeEnv(source)) };
}
function executableUnchanged(): boolean {
  if (realpathSync(PREPARED_INSPECTION.executable) !== PREPARED_INSPECTION.resolvedExecutable) return false;
  const before = statSync(PREPARED_INSPECTION.executable);
  if (!before.isFile() || before.size !== PREPARED_INSPECTION.executableSize) return false;
  const fd = openSync(PREPARED_INSPECTION.executable, 'r');
  const hash = createHash('sha256'), buffer = Buffer.alloc(65_536);
  try { for (;;) { const size = readSync(fd, buffer, 0, buffer.length, null); if (!size) break; hash.update(buffer.subarray(0, size)); } }
  finally { closeSync(fd); }
  const after = statSync(PREPARED_INSPECTION.executable);
  return hash.digest('hex') === PREPARED_INSPECTION.executableSha256 && before.dev === after.dev && before.ino === after.ino
    && before.size === after.size && before.mtimeMs === after.mtimeMs
    && realpathSync(PREPARED_INSPECTION.executable) === PREPARED_INSPECTION.resolvedExecutable;
}
export function preparedInspectionPreflight(source: Readonly<Record<string, string | undefined>>):
  { ok: true; env: Readonly<Record<string, string>> } | { ok: false; reason: InspectionPreflightCode } {
  const environment = inspectionEnvironment(source);
  if (!environment.ok) return environment;
  try {
    const cwd = lstatSync(PREPARED_INSPECTION.cwd);
    if (!cwd.isDirectory() || cwd.isSymbolicLink() || cwd.dev !== PREPARED_INSPECTION.cwdDev || cwd.ino !== PREPARED_INSPECTION.cwdIno
      || readdirSync(PREPARED_INSPECTION.cwd).length !== 0) return { ok: false, reason: 'cwd_changed' };
    if (!executableUnchanged()) return { ok: false, reason: 'executable_changed' };
    return environment;
  } catch { return { ok: false, reason: 'preflight_failed' }; }
}

/** Только вспомогательный Node. Не выбирает и не запускает executable Claude. */
export function spawnInspectionWorker(cli: ChildProcessWithoutNullStreams, options: {
  cwd: string; env: Readonly<Record<string, string>>; ownedCwd?: boolean;
}) {
  return spawn(process.execPath, [fileURLToPath(new URL('./settings-inspection-worker.ts', import.meta.url)),
    '--inspection-worker', ...(options.ownedCwd ? ['--owned-cwd'] : [])], {
    cwd: options.cwd, env: options.env, shell: false,
    stdio: ['ignore', 'pipe', 'pipe', cli.stdin, cli.stdout, cli.stderr, 'ipc'], serialization: 'json',
  });
}

/** Последняя запись имеет лишь остаток общего deadline, не новый период ожидания.
 * false означает неподтверждённую доставку; уже записанные байты не отзываются. */
export function writeInspectionResult(output: Writable, value: unknown, deadlineNs: bigint): Promise<boolean> {
  let line: string;
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== 'string') return Promise.resolve(false);
    line = serialized + '\n';
    if (Buffer.byteLength(line) > 32_768) return Promise.resolve(false);
  } catch { return Promise.resolve(false); }
  const remaining = Number(deadlineNs - process.hrtime.bigint()) / 1_000_000;
  return new Promise(resolve => {
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (written: boolean) => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      resolve(written);
    };
    // Остаётся обработчик поздней ошибки: произвольный Error не попадёт в stderr.
    output.on('error', () => finish(false));
    if (remaining > 0) timer = setTimeout(() => finish(false), remaining);
    try { output.write(line, error => finish(!error)); } catch { finish(false); }
    if (remaining <= 0) finish(false);
  });
}

async function runPreparedInspection(): Promise<void> {
  const preflight = preparedInspectionPreflight(process.env);
  if (!preflight.ok) { process.stdout.write(JSON.stringify({ cliCompatibility: 'unconfirmed', started: false, reason: preflight.reason }) + '\n'); process.exitCode = 2; return; }
  const artifactsBefore = { cwd: inspectionMetadata(PREPARED_INSPECTION.cwd),
    remote: inspectionMetadata(join(preflight.env.CLAUDE_CONFIG_DIR ?? join(preflight.env.HOME!, '.claude'), 'remote-settings.json')) };
  const deadlineNs = process.hrtime.bigint() + 18_000_000_000n;
  const run = superviseSettingsInspection({
    artifactsBefore,
    spawnCli: () => spawn(PREPARED_INSPECTION.executable, [...PREPARED_INSPECTION.argv], {
      cwd: PREPARED_INSPECTION.cwd, env: preflight.env, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    }),
    spawnWorker: cli => spawnInspectionWorker(cli, { cwd: PREPARED_INSPECTION.cwd, env: preflight.env, ownedCwd: true }),
  });
  const stop = () => run.stop();
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  const report = await run.done;
  process.off('SIGINT', stop); process.off('SIGTERM', stop);
  const delivered = await writeInspectionResult(process.stdout, {
    identity: { executable: PREPARED_INSPECTION.executable, executableSha256: PREPARED_INSPECTION.executableSha256,
      declaredPackageVersion: '2.1.295', runtimeVersion: 'unconfirmed', cwd: PREPARED_INSPECTION.cwd,
      argv: PREPARED_INSPECTION.argv, envNames: Object.keys(preflight.env).sort() },
    topology: { claudeLimit: 1, auxiliaryNodeProcesses: 2, promptCount: 0, retries: 0 }, ...report,
  }, deadlineNs);
  const exitCode = delivered && report.transport?.outcome === 'observed' && !report.supervisor.stopAccepted && !report.supervisor.deadline
    && report.supervisor.reasons.length === 0 && report.supervisor.cli.state === 'exited' && report.supervisor.cli.exitCode === 0
    && report.supervisor.cli.signal === null && report.supervisor.worker.state === 'exited' && report.supervisor.worker.exitCode === 0
    && report.supervisor.worker.signal === null && report.artifacts?.cleanup === 'removed' ? 0 : 1;
  // Не оставляем ожидающую stdout-запись держать Node после общего предела.
  process.exit(exitCode);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== '--approved-single-probe' || process.env.P2B_SETTINGS_INSPECTION !== '1') {
    process.stdout.write(JSON.stringify({ cliCompatibility: 'unconfirmed', started: false, reason: 'explicit_probe_required',
      permission: 'Требуется отдельное разрешение пользователя; opt-in флаг не заменяет разрешение.' }) + '\n');
    process.exitCode = 2;
  } else void runPreparedInspection().catch(() => {
    process.stdout.write(JSON.stringify({ cliCompatibility: 'unconfirmed', reason: 'stand_failed' }) + '\n'); process.exitCode = 1;
  });
}
