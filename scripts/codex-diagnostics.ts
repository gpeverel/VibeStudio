/** Сценарий D из docs/P3-CODEX-LIVE-PLAN.md. Импорт ничего не запускает.
 * --run-p3-diagnostics — защита от случайного запуска, НЕ согласие пользователя.
 * Модельные команды, login/logout, credentials и изменение конфигурации здесь отсутствуют. */
import { createHash } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { access, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { setTimeout, clearTimeout } from 'node:timers';
import type { ProcessCompletion, ProcessCompletionIssue, ProcessResult, ProcessRun, ProcessRunner } from '../src/core/ports/process-runner.ts';
import { createProcessRunner } from '../src/adapters/process-runner/index.ts';
import { buildCodexEnv } from '../src/adapters/codex/args.ts';
import { REQUIRED_CODEX_FLAGS, REQUIRED_CODEX_RESUME_FLAGS } from '../src/adapters/codex/detect.ts';

export const DIAGNOSTIC_STEPS = [
  { id: 'D1', args: ['--version'] },
  { id: 'D2', args: ['--help'] },
  { id: 'D3', args: ['exec', '--help'] },
  { id: 'D4', args: ['exec', 'resume', '--help'] },
  { id: 'D5', args: ['login', '--help'] },
  { id: 'D6', args: ['login', 'status'] },
] as const;
export const DIAGNOSTIC_BUDGET = {
  processMs: 5_000, graceMs: 200, drainMs: 1_000, totalMs: 45_000, cleanupMs: 5_000, streamBytes: 65_536,
} as const;
type Budget = { [K in keyof typeof DIAGNOSTIC_BUDGET]: number };
type Reason = 'preflight_failed' | 'identity_changed' | 'interface_unsupported' | 'not_authenticated'
  | 'process_failed' | 'stream_failed' | 'output_limit' | 'timeout' | 'interrupted' | 'evidence_failed' | 'cleanup_failed';
type IdentityRole = 'wrapper' | 'native' | 'node';
export interface DiagnosticIdentity { role: IdentityRole; path: string; realpath: string; stat: string; sha256: string }
export interface DiagnosticProbe {
  id: typeof DIAGNOSTIC_STEPS[number]['id'];
  args: readonly string[];
  status: 'not_run' | 'passed' | 'failed';
  durationMs?: number;
  stdoutBytes?: number;
  stderrBytes?: number;
  completion?: ProcessCompletion;
  version?: string;
  flags?: string[];
  auth?: 'authenticated' | 'unauthenticated' | 'unknown';
}
export interface DiagnosticReport {
  schemaVersion: 1;
  scenario: 'P3-D';
  provenance: 'synthetic' | 'live';
  status: 'running' | 'passed' | 'failed' | 'interrupted';
  reason?: Reason;
  startedAt: string;
  durationMs: number;
  budget: Budget;
  attempts: number;
  modelCalls: 0;
  envNames: string[];
  identity: DiagnosticIdentity[];
  probes: DiagnosticProbe[];
  workspace: string | null;
  cleanup: 'not_created' | 'removed' | 'retained' | 'failed';
}
export interface DiagnosticOptions {
  runner: ProcessRunner;
  executable: string;
  identityFiles: readonly { role: IdentityRole; path: string }[];
  env: Readonly<Record<string, string | undefined>>;
  provenance: 'synthetic' | 'live';
  signal?: AbortSignal;
  /** Только тесты; CLI всегда использует фиксированный бюджет D. */
  budget?: Partial<Budget>;
  /** Запись безопасного evidence после каждого шага; её отказ запрещает следующий spawn. */
  onProgress?: (report: DiagnosticReport) => Promise<void>;
}
const statKey = async (path: string): Promise<string> => {
  const info = await stat(path);
  if (!info.isFile()) throw new Error('not_file');
  return [info.dev, info.ino, info.size, info.mode, info.mtimeMs, info.ctimeMs].join(':');
};
async function identity(file: { role: IdentityRole; path: string }): Promise<DiagnosticIdentity> {
  if (!isAbsolute(file.path)) throw new Error('absolute_path_required');
  const target = await realpath(file.path);
  const before = await statKey(target);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(target)) hash.update(chunk);
  if (before !== await statKey(target) || target !== await realpath(file.path)) throw new Error('identity_changed');
  return { ...file, realpath: target, stat: before, sha256: hash.digest('hex') };
}
async function sameIdentity(files: readonly DiagnosticIdentity[]): Promise<boolean> {
  try {
    for (const file of files) {
      if (await realpath(file.path) !== file.realpath || await statKey(file.realpath) !== file.stat) return false;
    }
    return true;
  } catch { return false; }
}
async function sameNode(env: Readonly<Record<string, string>>, files: readonly DiagnosticIdentity[]): Promise<boolean> {
  const expected = files.find(file => file.role === 'node');
  if (!expected) return true; // У synthetic executable может не быть node-shim.
  const entries = (env.PATH ?? '').split(delimiter);
  // /usr/bin/env учитывает пустые/относительные элементы относительно cwd.
  // Не пропускаем их при проверке и не переписываем окружение ради допуска.
  if (entries.some(dir => !isAbsolute(dir))) return false;
  for (const dir of entries) {
    const path = join(dir, 'node');
    try {
      await access(path, constants.X_OK);
      if (!(await stat(path)).isFile()) continue;
      return await realpath(path) === expected.realpath;
    } catch { /* Следующий элемент неизменённого PATH. */ }
  }
  return false;
}
function errno(error: unknown): string | undefined {
  const value = (error as { code?: unknown } | null)?.code;
  return typeof value === 'string' && /^E[A-Z0-9_]{1,31}$/.test(value) ? value : undefined;
}
/** Сырой stderr, diagnostic, Error.message и произвольный detail не попадают в evidence. */
function safeCompletion(base: ProcessCompletion | undefined, issues: ProcessCompletionIssue[], timedOut: boolean): ProcessCompletion {
  return {
    process: base ? { ...base.process } : { state: 'unconfirmed' },
    stdout: issues.some(i => i.code === 'stream_failed' && i.operation === 'stdout') ? 'errored' : base?.stdout ?? 'unconfirmed',
    stderr: issues.some(i => i.code === 'stream_failed' && i.operation === 'stderr') ? 'errored' : base?.stderr ?? 'unconfirmed',
    signals: (base?.signals ?? []).map(({ signal, target, status, errorCode }) => ({
      signal, target, status, ...(errno({ code: errorCode }) ? { errorCode } : {}),
    })),
    wait: timedOut ? 'deadline' : base?.wait ?? 'deadline',
    issues: [...(base?.issues ?? []), ...issues].map(({ code, operation, errorCode }) => ({
      code, ...(operation ? { operation } : {}), ...(errno({ code: errorCode }) ? { errorCode } : {}), detail: code,
    })),
    descendants: 'not_guaranteed',
  };
}
const closed = (c: ProcessCompletion): boolean => c.process.state === 'exited'
  && c.stdout === 'ended' && c.stderr === 'ended';
const clean = (c: ProcessCompletion): boolean => closed(c) && c.process.state === 'exited'
  && c.process.exitCode === 0 && c.process.signal === null && c.wait === 'settled' && c.issues.length === 0;

async function within(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), Math.max(0, ms)); })]);
  } finally { clearTimeout(timer); }
}

async function capture(run: ProcessRun, budget: Budget, remaining: number, signal?: AbortSignal) {
  const chunks: Uint8Array[][] = [[], []];
  const bytes = [0, 0];
  const issues: ProcessCompletionIssue[] = [];
  const stops: Promise<void>[] = [];
  const pendingStops = new Set<'interrupt' | 'kill'>();
  const drained = [false, false];
  let reason: Reason | undefined;
  let result: ProcessResult | undefined;
  let timedOut = false;
  const requestedStops = new Set<'interrupt' | 'kill'>();
  const stop = (hard: boolean): void => {
    const operation = hard ? 'kill' : 'interrupt';
    if (requestedStops.has(operation) || requestedStops.has('kill')) return;
    requestedStops.add(operation);
    const failed = (error: unknown): void => {
      issues.push({ code: 'signal_failed', operation, errorCode: errno(error), detail: 'signal_failed' });
    };
    try {
      const stopping = run[operation]();
      pendingStops.add(operation);
      stops.push(Promise.resolve(stopping).catch(failed).finally(() => { pendingStops.delete(operation); }));
    } catch (error) { failed(error); }
  };
  const abort = (): void => { reason = 'interrupted'; stop(false); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const drain = async (stream: AsyncIterable<Uint8Array>, index: 0 | 1): Promise<void> => {
    try {
      for await (const chunk of stream) {
        bytes[index] = bytes[index]! + chunk.byteLength;
        if (bytes[index]! > budget.streamBytes) {
          reason ??= 'output_limit';
          issues.push({ code: 'output_limit', operation: index ? 'stderr' : 'stdout', detail: 'output_limit' });
          stop(true);
          break;
        }
        chunks[index]!.push(chunk);
      }
    } catch (error) {
      reason ??= 'stream_failed';
      issues.push({ code: 'stream_failed', operation: index ? 'stderr' : 'stdout', errorCode: errno(error), detail: 'stream_failed' });
      stop(true);
    } finally { drained[index] = true; }
  };
  const done = run.done.then(value => {
    result = value;
    if (value?.error || !value?.completion) reason ??= 'process_failed';
  }, error => {
    reason ??= 'process_failed';
    issues.push({ code: 'process_result_failed', operation: 'done', errorCode: errno(error), detail: 'process_result_failed' });
    stop(true);
  });
  const streamsAndDone = Promise.all([drain(run.stdout, 0), drain(run.stderr, 1), done]);
  const settle = async (): Promise<void> => {
    await streamsAndDone;
    let observed = 0;
    while (observed < stops.length) {
      const batch = stops.slice(observed);
      observed = stops.length;
      await Promise.all(batch);
    }
  };
  try {
    if (!await within(settle(), Math.min(remaining, budget.processMs + budget.graceMs + budget.drainMs))) {
      timedOut = true;
      reason ??= 'timeout';
      issues.push({ code: 'timeout', operation: 'wait', detail: 'timeout' });
      stop(true);
      // Новый kill мог появиться после начала/завершения первого ожидания.
      if (!await within(settle(), budget.cleanupMs)) {
        if (result?.completion?.process.state !== 'exited') {
          issues.push({ code: 'exit_unconfirmed', operation: 'wait', detail: 'exit_unconfirmed' });
        }
        if (drained.some(value => !value)) issues.push({ code: 'drain_timeout', operation: 'wait', detail: 'drain_timeout' });
        for (const operation of pendingStops) issues.push({ code: 'timeout', operation, detail: 'timeout' });
      }
    }
  } finally { signal?.removeEventListener('abort', abort); }
  // Копия отделяет terminal от позднего result/ошибок зависшей подстановки.
  return {
    reason, completion: safeCompletion(result?.completion, issues, timedOut),
    stdout: Buffer.concat(chunks[0]!).toString('utf8'), stderr: Buffer.concat(chunks[1]!).toString('utf8'),
    stdoutBytes: bytes[0]!, stderrBytes: bytes[1]!,
  };
}

const KNOWN_FLAGS = [...REQUIRED_CODEX_FLAGS, '--ephemeral', '--model', '--help', '--version'] as const;
function facts(probe: DiagnosticProbe, stdout: string, stderr: string): Reason | undefined {
  if (probe.id === 'D6') {
    probe.auth = clean(probe.completion!) ? 'authenticated'
      : probe.completion?.process.state === 'exited' && probe.completion.process.exitCode === 1
        && closed(probe.completion) && probe.completion.process.signal === null && probe.completion.wait === 'settled'
        && probe.completion.issues.length === 0 && !stdout.trim()
        && /^Not logged in\s*$/.test(stderr) ? 'unauthenticated' : 'unknown';
    return probe.auth === 'authenticated' ? undefined : probe.auth === 'unauthenticated' ? 'not_authenticated' : 'process_failed';
  }
  if (!clean(probe.completion!)) return 'process_failed';
  if (probe.id === 'D1') {
    probe.version = stdout.match(/^codex(?:-cli)?\s+(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\s*$/m)?.[1];
    return probe.version ? undefined : 'interface_unsupported';
  }
  if (probe.id === 'D2') return /^\s+exec(?:\s|$)/m.test(stdout) && /^\s+login(?:\s|$)/m.test(stdout) ? undefined : 'interface_unsupported';
  if (probe.id === 'D5') return /^\s+status(?:\s|$)/m.test(stdout) ? undefined : 'interface_unsupported';
  probe.flags = KNOWN_FLAGS.filter(flag => new RegExp(`^[ \\t]*(?:-[A-Za-z],[ \\t]+)?${flag}(?=[\\s,=<\\[]|$)`, 'm').test(stdout));
  const required = probe.id === 'D4' ? REQUIRED_CODEX_RESUME_FLAGS : REQUIRED_CODEX_FLAGS;
  return required.every(flag => probe.flags!.includes(flag)) && /\bstdin\b/i.test(stdout) ? undefined : 'interface_unsupported';
}

/** Только доверенная инженерная композиция. Любой отказ завершает набор, повторов нет. */
export async function runCodexDiagnostics(options: DiagnosticOptions): Promise<DiagnosticReport> {
  const budget = { ...DIAGNOSTIC_BUDGET, ...options.budget };
  if (Object.values(budget).some(n => !Number.isSafeInteger(n) || n <= 0 || n > 2_147_483_647)) throw new Error('invalid_budget');
  const started = Date.now();
  const env = Object.freeze(buildCodexEnv(options.env));
  const report: DiagnosticReport = {
    schemaVersion: 1, scenario: 'P3-D', provenance: options.provenance, status: 'running', startedAt: new Date(started).toISOString(),
    durationMs: 0, budget, attempts: 0, modelCalls: 0, envNames: Object.keys(env).sort(), identity: [],
    probes: DIAGNOSTIC_STEPS.map(step => ({ id: step.id, args: [...step.args], status: 'not_run' })),
    workspace: null, cleanup: 'not_created',
  };
  let removable = true;
  const fail = (reason: Reason): void => { report.status = reason === 'interrupted' ? 'interrupted' : 'failed'; report.reason = reason; };
  const checkpoint = async (): Promise<boolean> => {
    report.durationMs = Date.now() - started;
    try { await options.onProgress?.(structuredClone(report)); return true; }
    catch { fail('evidence_failed'); return false; }
  };
  try {
    if (options.signal?.aborted) { fail('interrupted'); return report; }
    if (!isAbsolute(options.executable) || !options.identityFiles.length
      || !options.identityFiles.some(file => file.path === options.executable)) throw new Error('identity_required');
    await access(options.executable, constants.X_OK);
    for (const file of options.identityFiles) report.identity.push(await identity(file));
    if (!await sameNode(env, report.identity)) throw new Error('node_identity_mismatch');
    report.workspace = await realpath(await mkdtemp(join(tmpdir(), 'vibestudio-codex-D-')));
    report.cleanup = 'retained';
    if (!await checkpoint()) return report;
    for (const probe of report.probes) {
      if (options.signal?.aborted) { fail('interrupted'); break; }
      if (Date.now() - started >= budget.totalMs) { fail('timeout'); break; }
      if (!await sameIdentity(report.identity) || !await sameNode(env, report.identity)) { fail('identity_changed'); break; }
      if (options.signal?.aborted) { fail('interrupted'); break; }
      if (Date.now() - started >= budget.totalMs) { fail('timeout'); break; }
      const before = Date.now();
      report.attempts++;
      removable = false; // Неизвестный throw start не доказывает отсутствия процесса.
      let run: ProcessRun;
      try {
        run = options.runner.start({
          executable: options.executable, args: probe.args, cwd: report.workspace, stdin: '', env,
          timeoutMs: budget.processMs, stopGraceMs: budget.graceMs, drainTimeoutMs: budget.drainMs, maxQueueBytes: budget.streamBytes,
        });
      } catch (error) {
        probe.status = 'failed';
        probe.completion = safeCompletion(undefined, [{ code: 'spawn_failed', operation: 'spawn', errorCode: errno(error), detail: 'spawn_failed' }], false);
        fail('process_failed');
        break;
      }
      const captured = await capture(run, budget, budget.totalMs - (Date.now() - started), options.signal);
      probe.durationMs = Date.now() - before;
      probe.completion = captured.completion;
      probe.stdoutBytes = captured.stdoutBytes;
      probe.stderrBytes = captured.stderrBytes;
      removable = closed(captured.completion);
      const reason = captured.reason ?? facts(probe, captured.stdout, captured.stderr);
      probe.status = reason ? 'failed' : 'passed';
      if (reason) fail(reason);
      if (!await checkpoint() || reason) break;
    }
    if (report.status === 'running') {
      if (!await sameIdentity(report.identity)) fail('identity_changed');
      else if (options.signal?.aborted) fail('interrupted');
      else report.status = 'passed';
    }
  } catch { fail(report.attempts ? 'process_failed' : 'preflight_failed'); }
  finally {
    if (report.workspace && removable) {
      try { await rm(report.workspace, { recursive: true }); report.cleanup = 'removed'; }
      catch { report.cleanup = 'failed'; fail('cleanup_failed'); }
    }
    await checkpoint();
  }
  return report;
}

// Один выбранный executable сценария D. Смена установки требует новой редакции плана.
export const SELECTED_CODEX = '/Users/nishimata/.nvm/versions/node/v24.15.0/bin/codex';
const NATIVE_CODEX = '/Users/nishimata/.nvm/versions/node/v24.15.0/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex';
async function main(): Promise<void> {
  if (process.argv.slice(2).join(' ') !== '--run-p3-diagnostics') {
    process.stderr.write('Запуск: sh scripts/with-node.sh node --experimental-transform-types scripts/codex-diagnostics.ts --run-p3-diagnostics\nТолько после согласования сценария D и назначения исполнителя. Флаг сам по себе не является согласием.\n');
    process.exitCode = 2;
    return;
  }
  const evidenceDir = await mkdtemp(join(tmpdir(), 'vibestudio-codex-D-evidence-'));
  const evidencePath = join(evidenceDir, 'report.json');
  const controller = new AbortController();
  let deadlineHit = false;
  let hardDeadline: ReturnType<typeof setTimeout> | undefined;
  // Этот watchdog охватывает и preflight/evidence, а не только дочерний ProcessRunner.
  // При его срабатывании последний checkpoint неполон; число реально начатых probes неизвестно.
  const stop = (): void => {
    controller.abort();
    hardDeadline ??= setTimeout(() => {
      process.stderr.write(JSON.stringify({
        status: 'unconfirmed', reason: 'supervisor_timeout', attemptsUpperBound: 6, modelCalls: 0,
        evidencePath, cleanup: 'unconfirmed',
      }) + '\n');
      process.exit(1);
    }, DIAGNOSTIC_BUDGET.cleanupMs);
  };
  const deadline = setTimeout(() => { deadlineHit = true; stop(); }, DIAGNOSTIC_BUDGET.totalMs);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const report = await runCodexDiagnostics({
      runner: createProcessRunner(), executable: SELECTED_CODEX, provenance: 'live', env: process.env, signal: controller.signal,
      identityFiles: [{ role: 'wrapper', path: SELECTED_CODEX }, { role: 'native', path: NATIVE_CODEX }, { role: 'node', path: process.execPath }],
      onProgress: async report => {
        if (deadlineHit) { report.status = 'failed'; report.reason = 'timeout'; }
        await writeFile(evidencePath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
      },
    });
    if (deadlineHit) { report.status = 'failed'; report.reason = 'timeout'; }
    process.stdout.write(JSON.stringify({ status: report.status, reason: report.reason, attempts: report.attempts, modelCalls: 0, evidencePath, cleanup: report.cleanup }) + '\n');
    process.exitCode = report.status === 'passed' ? 0 : 1;
  } finally {
    clearTimeout(deadline); clearTimeout(hardDeadline);
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch(() => { process.stderr.write('Диагностический стенд завершился с ошибкой; сырой текст скрыт.\n'); process.exitCode = 1; });
}
