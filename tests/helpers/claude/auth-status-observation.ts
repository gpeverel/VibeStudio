import type { ProcessResult, ProcessRun, ProcessRunner } from '../../../src/core/ports/process-runner.ts';
import { safeLiveCompletion } from './practical-live.ts';

const METHODS = ['claude.ai', 'api_key', 'none'] as const;
const PROVIDERS = ['anthropic', 'firstParty', 'bedrock', 'vertex', 'foundry', 'gateway'] as const;
export const AUTH_STATUS_LIMITS = { deadlineMs: 8_000, cleanupMs: 1_000, timeoutMs: 5_000,
  stopGraceMs: 100, drainTimeoutMs: 500, maxQueueBytes: 262_144 } as const;
export interface AuthStatusFields {
  loggedIn: boolean | null;
  authMethod: typeof METHODS[number] | 'other' | 'unknown';
  apiProvider: typeof PROVIDERS[number] | 'other' | 'unknown';
}

/** Только закрытые значения; account, token, пути и остальные поля JSON отбрасываются. */
export function parseAuthStatus(output: string): AuthStatusFields {
  const unknown: AuthStatusFields = { loggedIn: null, authMethod: 'unknown', apiProvider: 'unknown' };
  if (Buffer.byteLength(output) > AUTH_STATUS_LIMITS.maxQueueBytes) return unknown;
  try {
    const value: unknown = JSON.parse(output);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return unknown;
    const fields = value as Record<string, unknown>;
    const closed = <T extends string>(item: unknown, allowed: readonly T[]): T | 'other' | 'unknown' =>
      typeof item !== 'string' ? 'unknown' : allowed.includes(item as T) ? item as T : 'other';
    return { loggedIn: typeof fields.loggedIn === 'boolean' ? fields.loggedIn : null,
      authMethod: closed(fields.authMethod, METHODS), apiProvider: closed(fields.apiProvider, PROVIDERS) };
  } catch { return unknown; }
}

export interface AuthStatusObservation {
  status: 'authenticated' | 'unauthenticated' | 'unconfirmed';
  reason: 'completed' | 'spawn_failed' | 'output_limit' | 'collection_failed' | 'deadline'
    | 'completion_unconfirmed' | 'process_failed' | 'invalid_status' | 'inconsistent_status' | 'cleanup_unconfirmed';
  auth: AuthStatusFields;
  stdoutBytes: number;
  stderrBytes: number;
  completion: ReturnType<typeof safeLiveCompletion> | null;
  cleanup: 'confirmed' | 'unconfirmed';
  stop: 'not_needed' | 'requested' | 'failed';
}

function budget(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error('Некорректный бюджет auth-пробы.');
  return value;
}
async function bounded(work: Promise<unknown>, ms: number): Promise<'fulfilled' | 'rejected' | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work.then(() => 'fulfilled' as const, () => 'rejected' as const),
      new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), ms); })]);
  } finally { clearTimeout(timer); }
}
function finished(result: ProcessResult | undefined): boolean {
  const c = result?.completion;
  return c?.process.state === 'exited' && c.stdout === 'ended' && c.stderr === 'ended' && c.wait === 'settled'
    && c.signals.every(signal => signal.status !== 'failed');
}

/** Одна команда без модели. Только собственный handle; таймеры внутри процесса, не внешний надзор. */
export async function collectAuthStatus(options: {
  runner: ProcessRunner; executable: string; cwd: string; env: Readonly<Record<string, string>>;
  deadlineMs?: number; cleanupMs?: number;
}): Promise<AuthStatusObservation> {
  const deadlineMs = budget(options.deadlineMs, AUTH_STATUS_LIMITS.deadlineMs);
  const cleanupMs = budget(options.cleanupMs, AUTH_STATUS_LIMITS.cleanupMs);
  const deadline = performance.now() + deadlineMs;
  let run: ProcessRun;
  try {
    run = options.runner.start({ executable: options.executable, args: ['auth', 'status'], cwd: options.cwd,
      env: { ...options.env }, stdin: '', timeoutMs: AUTH_STATUS_LIMITS.timeoutMs, stopGraceMs: AUTH_STATUS_LIMITS.stopGraceMs,
      drainTimeoutMs: AUTH_STATUS_LIMITS.drainTimeoutMs, maxQueueBytes: AUTH_STATUS_LIMITS.maxQueueBytes });
  } catch {
    return { status: 'unconfirmed', reason: 'spawn_failed', auth: parseAuthStatus(''), stdoutBytes: 0, stderrBytes: 0,
      completion: null, cleanup: 'unconfirmed', stop: 'not_needed' };
  }
  let result: ProcessResult | undefined;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let collecting = true;
  let failure: AuthStatusObservation['reason'] | undefined;
  const chunks: Buffer[] = [];
  const drain = async (stream: AsyncIterable<Uint8Array>, keep: boolean): Promise<void> => {
    try {
      for await (const chunk of stream) {
        if (!collecting) return;
        if (keep) stdoutBytes += chunk.byteLength; else stderrBytes += chunk.byteLength;
        if (stdoutBytes + stderrBytes > AUTH_STATUS_LIMITS.maxQueueBytes) {
          failure = 'output_limit';
          throw new Error('Превышен бюджет auth-пробы.');
        }
        if (keep) chunks.push(Buffer.from(chunk));
      }
    } catch {
      if (collecting) failure ??= 'collection_failed';
      throw new Error('Поток auth-пробы не завершён.');
    }
  };
  const done = run.done.then(value => { result = value; });
  const readers = [drain(run.stdout, true), drain(run.stderr, false)];
  const collection = await bounded(Promise.all([...readers, done]), Math.max(0, deadline - performance.now()));
  const collected = performance.now() >= deadline ? 'timeout' : collection;
  collecting = false;
  let reason: AuthStatusObservation['reason'] = failure ?? (collected === 'timeout' ? 'deadline'
    : collected === 'rejected' ? 'collection_failed' : 'completed');
  let stop: AuthStatusObservation['stop'] = 'not_needed';
  let cleanup: AuthStatusObservation['cleanup'] = 'confirmed';
  if (collected !== 'fulfilled' || !finished(result)) {
    const cleanupDeadline = performance.now() + cleanupMs;
    const stopFailures: true[] = [];
    const killed = Promise.resolve().then(() => run.kill()).catch(() => { stopFailures.push(true); });
    const settled = await bounded(Promise.allSettled([...readers, done, killed]), cleanupMs);
    stop = stopFailures.length ? 'failed' : 'requested';
    // Resolved kill сам по себе не доказывает exit/EOF; rejected done не даёт результата.
    if (settled !== 'fulfilled' || performance.now() >= cleanupDeadline || stop === 'failed' || !finished(result)) cleanup = 'unconfirmed';
  }
  const auth = collected === 'fulfilled' && !failure ? parseAuthStatus(Buffer.concat(chunks).toString('utf8')) : parseAuthStatus('');
  chunks.length = 0;
  let status: AuthStatusObservation['status'] = 'unconfirmed';
  if (reason === 'completed') {
    const completion = result?.completion;
    if (!finished(result) || completion?.process.state !== 'exited') reason = 'completion_unconfirmed';
    else if (result!.error || completion.issues.length || completion.process.signal !== null
      || result!.exitCode !== completion.process.exitCode || result!.signal !== completion.process.signal) reason = 'process_failed';
    else if (auth.loggedIn === null) reason = 'invalid_status';
    else if (result!.exitCode === 0 && auth.loggedIn) status = 'authenticated';
    else if ((result!.exitCode === 0 || result!.exitCode === 1) && !auth.loggedIn) status = 'unauthenticated';
    else reason = 'inconsistent_status';
  }
  if (cleanup !== 'confirmed') { status = 'unconfirmed'; if (reason === 'completed') reason = 'cleanup_unconfirmed'; }
  return { status, reason, auth, stdoutBytes, stderrBytes,
    completion: result ? safeLiveCompletion(result.completion) : null, cleanup, stop };
}
