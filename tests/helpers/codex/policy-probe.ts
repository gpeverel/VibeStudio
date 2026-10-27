import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, readSync, realpathSync, rmSync,
  symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { buildCodexEnv } from '../../../src/adapters/codex/args.ts';
import type { ProcessCompletion, ProcessRequest, ProcessRun, ProcessRunner } from '../../../src/core/ports/process-runner.ts';
import { safeCodexCompletion } from './live-harness.ts';

export const R2_BUDGET = Object.freeze({
  cli: 2, auxiliary: 2, models: 0, totalMs: 60_000, compileMs: 20_000, processMs: 10_000,
  cleanupMs: 5_000, stopMs: 2_000, graceMs: 200, drainMs: 1_000, outputBytes: 65_536,
});
export const R2_SOURCE = fileURLToPath(new URL('./fs-policy-probe.c', import.meta.url));
export const R2_STEPS = ['compile', 'baseline', 'sandbox-help', 'sandbox'] as const;
type Step = typeof R2_STEPS[number];
const operation = z.object({
  attempted: z.literal(true), state: z.enum(['allowed', 'denied', 'error']),
  code: z.enum(['NONE', 'EACCES', 'EPERM', 'OTHER']), matched: z.boolean(),
}).strict();
const probeOutput = z.object({
  schemaVersion: z.literal(1), control: operation, outside: operation, symlink: operation,
  writeInside: operation, writeOutside: operation,
}).strict();
export type ProbeOutput = z.infer<typeof probeOutput>;
type Reason = 'cancelled' | 'deadline' | 'launch_failed' | 'lifecycle' | 'output_limit'
  | 'baseline_failed' | 'interface_unconfirmed' | 'policy_unconfirmed' | 'policy_failed'
  | 'controls_changed' | 'evidence_failed' | 'preparation_failed' | 'identity_changed';
export interface ProbeReport {
  scenario: 'P3-R2'; provenance: 'live' | 'synthetic'; productionAdmission: 'not_assessed';
  status: 'running' | 'observed' | 'stopped'; reason?: Reason;
  attempts: { cli: number; auxiliary: number; models: 0 };
  sourceSha256?: string; probeSha256?: string;
  baseline?: ProbeOutput; sandbox?: ProbeOutput;
  processes: {
    step: Step; argvSha256: string; envNames: string[]; handle: 'returned' | 'unconfirmed';
    stdoutBytes: number; stderrBytes: number; stdoutEnded: boolean; stderrEnded: boolean;
    completion: ReturnType<typeof safeCodexCompletion> | null;
  }[];
  cleanup: 'not_created' | 'pending' | 'removed' | 'retained';
  retainedWorkspace?: string;
  stopFailures: number;
}
export function parseProbeOutput(text: string): ProbeOutput | undefined {
  try {
    if (Buffer.byteLength(text) > 4096) return undefined;
    const value = probeOutput.safeParse(JSON.parse(text));
    return value.success ? value.data : undefined;
  } catch { return undefined; }
}
const allowed = (value: ProbeOutput['control']): boolean =>
  value.state === 'allowed' && value.code === 'NONE' && value.matched;
const denied = (value: ProbeOutput['control']): boolean =>
  value.state === 'denied' && ['EACCES', 'EPERM'].includes(value.code) && !value.matched;
export const baselinePassed = (value: ProbeOutput): boolean =>
  [value.control, value.outside, value.symlink, value.writeInside, value.writeOutside].every(allowed);
export const sandboxPassed = (value: ProbeOutput): boolean =>
  allowed(value.control) && [value.outside, value.symlink, value.writeInside, value.writeOutside].every(denied);

/** Manifest лаборатории не является production argv. Явно сохраняет managed-ограничения.
 * Без --include-managed-config explicit sandbox profile их исключает по исходнику 0.163.0. */
export function buildR2Requests(executable: string, project: string, profile: string,
  env: Readonly<Record<string, string>>): readonly ProcessRequest[] {
  if (!/^vs-p3-r2-[a-f0-9]{32}$/.test(profile)) throw new Error('Некорректное имя профиля R2.');
  const common = { cwd: project, env: { ...env }, stdin: '', stopGraceMs: R2_BUDGET.graceMs,
    drainTimeoutMs: R2_BUDGET.drainMs, maxQueueBytes: R2_BUDGET.outputBytes };
  const probe = join(project, 'fs-probe');
  return [
    { ...common, executable: '/usr/bin/cc', args: ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O0',
      '-fno-modules', join(project, 'fs-probe.c'), '-o', probe], timeoutMs: R2_BUDGET.compileMs },
    { ...common, executable: probe, args: [], timeoutMs: R2_BUDGET.processMs },
    { ...common, executable, args: ['sandbox', '--help'], timeoutMs: R2_BUDGET.processMs },
    { ...common, executable, args: [
      '-c', `permissions.${profile}.filesystem={":root"="deny",":minimal"="read",":workspace_roots"={"."="read"}}`,
      '-c', `permissions.${profile}.network.enabled=false`,
      '-c', 'approval_policy="never"', '-c', 'check_for_update_on_startup=false', '-c', 'analytics.enabled=false',
      'sandbox', '--permission-profile', profile, '--include-managed-config', '-C', project, '--', probe,
    ], timeoutMs: R2_BUDGET.processMs },
  ];
}
async function wait<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([promise.catch(() => undefined), new Promise<undefined>(resolve => {
      timer = setTimeout(() => resolve(undefined), Math.max(1, ms));
      abort = () => resolve(undefined);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    })]);
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
  }
}
function exited(completion: ProcessCompletion): boolean {
  return completion.process.state === 'exited' && completion.stdout === 'ended' && completion.stderr === 'ended'
    && completion.wait === 'settled' && completion.signals.every(signal => signal.status !== 'failed');
}
function boundedFile(path: string, maxBytes: number): Buffer | undefined {
  let fd: number | undefined;
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size > maxBytes) return undefined;
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (opened.dev !== st.dev || opened.ino !== st.ino || opened.size !== st.size) return undefined;
    const bytes = Buffer.alloc(st.size + 1);
    const count = readSync(fd, bytes);
    const after = fstatSync(fd);
    return count === st.size && after.size === st.size && after.mtimeMs === st.mtimeMs
      ? bytes.subarray(0, count) : undefined;
  } catch { return undefined; }
  finally { if (fd !== undefined) closeSync(fd); }
}
const exactFile = (path: string, expected: string): boolean =>
  boundedFile(path, Buffer.byteLength(expected))?.toString('utf8') === expected;

/** Только подготовка собственного tmp и ограниченные запуски через переданный runner.
 * Live entrypoint передаёт настоящий runner после opt-in; обычные тесты — явные doubles. */
export async function runPolicyProbe(options: {
  runner: ProcessRunner; executable: string; provenance: ProbeReport['provenance'];
  env: NodeJS.ProcessEnv; signal?: AbortSignal; beforeStart?: (request: ProcessRequest) => boolean;
  checkpoint?: (report: ProbeReport) => void; deadlineMs?: number; cleanupMs?: number;
}): Promise<ProbeReport> {
  const reduced = (value: number | undefined, maximum: number): number => {
    if (value === undefined) return maximum;
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error('Некорректный лимит R2.');
    return value;
  };
  const deadline = performance.now() + reduced(options.deadlineMs, R2_BUDGET.totalMs);
  const cleanupMs = reduced(options.cleanupMs, R2_BUDGET.cleanupMs);
  const report: ProbeReport = { scenario: 'P3-R2', provenance: options.provenance, productionAdmission: 'not_assessed',
    status: 'running', attempts: { cli: 0, auxiliary: 0, models: 0 }, processes: [], cleanup: 'not_created', stopFailures: 0 };
  const owned: { run: ProcessRun; settled: Promise<unknown>; complete: boolean }[] = [];
  let lostHandle = false;
  let root: string | undefined;
  let rootIdentity: string | undefined;
  function fail(reason: Reason): never {
    report.reason ??= reason; report.status = 'stopped'; throw new Error('R2 остановлен.');
  }
  const save = (): void => {
    try { options.checkpoint?.(structuredClone(report)); } catch { fail('evidence_failed'); }
  };
  const stop = async (run: ProcessRun): Promise<void> => {
    if (await wait(Promise.resolve().then(() => run.kill()).then(() => true), R2_BUDGET.stopMs) !== true) report.stopFailures++;
  };
  try {
    if (options.signal?.aborted) fail('cancelled');
    if (options.env.CODEX_API_KEY !== undefined) fail('preparation_failed');
    const env = buildCodexEnv(options.env);
    root = realpathSync(mkdtempSync(join(tmpdir(), 'vs-codex-R2-')));
    const st = lstatSync(root); rootIdentity = `${st.dev}:${st.ino}`; report.cleanup = 'pending';
    const project = join(root, 'project'); const outside = join(root, 'outside');
    mkdirSync(project, { mode: 0o700 }); mkdirSync(outside, { mode: 0o700 });
    writeFileSync(join(project, 'CONTROL.txt'), 'vs-control\n', { mode: 0o600 });
    writeFileSync(join(outside, 'OUTSIDE.txt'), 'vs-outside\n', { mode: 0o600 });
    symlinkSync('../outside/OUTSIDE.txt', join(project, 'OUTSIDE-LINK'));
    const source = readFileSync(R2_SOURCE);
    if (source.length > 16_384) fail('preparation_failed');
    report.sourceSha256 = createHash('sha256').update(source).digest('hex');
    writeFileSync(join(project, 'fs-probe.c'), source, { mode: 0o600 });
    const writes = [join(project, 'NEW.txt'), join(outside, 'WRITE-TARGET')];
    const controlsIntact = (): boolean => {
      try {
        return exactFile(join(project, 'CONTROL.txt'), 'vs-control\n')
          && exactFile(join(outside, 'OUTSIDE.txt'), 'vs-outside\n')
          && readlinkSync(join(project, 'OUTSIDE-LINK')) === '../outside/OUTSIDE.txt';
      } catch { return false; }
    };
    const present = (path: string): boolean => {
      try { lstatSync(path); return true; } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    };
    const requests = buildR2Requests(options.executable, project, 'vs-p3-r2-' + randomUUID().replaceAll('-', ''), env);
    const probeHash = (): string | undefined => {
      const bytes = boundedFile(join(project, 'fs-probe'), 1_048_576);
      return bytes && createHash('sha256').update(bytes).digest('hex');
    };
    save();
    for (const [index, request] of requests.entries()) {
      if (options.signal?.aborted) fail('cancelled');
      if (performance.now() >= deadline) fail('deadline');
      if (options.beforeStart && !options.beforeStart(request)) fail('identity_changed');
      if (index > 0 && probeHash() !== report.probeSha256) fail('identity_changed');
      const step = R2_STEPS[index]!;
      const kind = index < 2 ? 'auxiliary' : 'cli';
      if (report.attempts[kind] >= R2_BUDGET[kind]) fail('launch_failed');
      report.attempts[kind]++;
      const entry: ProbeReport['processes'][number] = { step, handle: 'unconfirmed',
        argvSha256: createHash('sha256').update(JSON.stringify(request.args)).digest('hex'),
        envNames: Object.keys(request.env).sort(), stdoutBytes: 0, stderrBytes: 0,
        stdoutEnded: false, stderrEnded: false, completion: null };
      report.processes.push(entry); save();
      let run: ProcessRun;
      try { run = options.runner.start(request); } catch { lostHandle = true; fail('launch_failed'); }
      entry.handle = 'returned';
      const record = { run, settled: Promise.resolve() as Promise<unknown>, complete: false };
      owned.push(record);
      let stdout = '';
      const consume = async (stream: AsyncIterable<Uint8Array>, name: 'stdout' | 'stderr'): Promise<void> => {
        const chunks: Uint8Array[] = [];
        for await (const chunk of stream) {
          entry[name === 'stdout' ? 'stdoutBytes' : 'stderrBytes'] += chunk.byteLength;
          if (entry.stdoutBytes + entry.stderrBytes > R2_BUDGET.outputBytes) fail('output_limit');
          if (name === 'stdout') chunks.push(chunk);
        }
        entry[name === 'stdout' ? 'stdoutEnded' : 'stderrEnded'] = true;
        if (name === 'stdout') stdout = Buffer.concat(chunks).toString('utf8');
      };
      const streams = [consume(run.stdout, 'stdout'), consume(run.stderr, 'stderr')] as const;
      const done = run.done.then(result => {
        entry.completion = safeCodexCompletion(result.completion);
        return result;
      });
      record.settled = Promise.allSettled([...streams, done] as const).then(results => {
        const last = results[2];
        record.complete = last?.status === 'fulfilled' && last.value !== undefined
          && exited(last.value.completion) && entry.stdoutEnded && entry.stderrEnded;
      });
      const observed = Promise.all([...streams, done] as const).then(values => values[2]).catch(() => {
        report.reason ??= 'lifecycle';
        return undefined;
      });
      const result = await wait(observed,
        Math.min(deadline - performance.now(), request.timeoutMs! + R2_BUDGET.graceMs + R2_BUDGET.drainMs + 1000), options.signal);
      if (!result) {
        fail(options.signal?.aborted ? 'cancelled' : report.reason ?? 'deadline');
      }
      await record.settled;
      if (!record.complete || result.exitCode !== 0 || result.signal !== null || result.error || result.completion.issues.length) fail('lifecycle');
      if (result.completion.process.state !== 'exited' || result.completion.process.exitCode !== result.exitCode
        || result.completion.process.signal !== result.signal) fail('lifecycle');
      if (!controlsIntact()) fail('controls_changed');
      if (step === 'compile') {
        report.probeSha256 = probeHash();
        if (!report.probeSha256) fail('preparation_failed');
      }
      if (step === 'baseline') {
        report.baseline = parseProbeOutput(stdout);
        if (!report.baseline || !baselinePassed(report.baseline)
          || !writes.every(path => exactFile(path, 'x'))) fail('baseline_failed');
        for (const path of writes) unlinkSync(path);
      }
      if (step === 'sandbox-help' && !['--permission-profile', '--include-managed-config'].every(flag =>
        new RegExp(`(?:^|\\s)${flag}(?:[\\s=,]|$)`, 'm').test(stdout))) fail('interface_unconfirmed');
      if (step === 'sandbox') {
        report.sandbox = parseProbeOutput(stdout);
        if (writes.some(present)) fail('policy_failed');
        if (!report.sandbox || !sandboxPassed(report.sandbox)) fail('policy_unconfirmed');
      }
      save();
    }
    report.status = 'observed';
  } catch { report.status = 'stopped'; report.reason ??= 'preparation_failed'; }
  finally {
    const pending = owned.filter(record => !record.complete);
    if (await wait(Promise.all(pending.map(async record => { await stop(record.run); await record.settled; })).then(() => true), cleanupMs) !== true) {
      report.stopFailures++;
    }
    if (root) {
      report.cleanup = 'retained'; report.retainedWorkspace = basename(root);
      if (!lostHandle && report.stopFailures === 0 && owned.every(record => record.complete)) {
        try {
          const st = lstatSync(root);
          if (st.isDirectory() && !st.isSymbolicLink() && `${st.dev}:${st.ino}` === rootIdentity && realpathSync(root) === root) {
            rmSync(root, { recursive: true }); report.cleanup = 'removed'; delete report.retainedWorkspace;
          }
        } catch { report.status = 'stopped'; report.reason ??= 'preparation_failed'; }
      }
      if (report.cleanup !== 'removed') { report.status = 'stopped'; report.reason ??= 'lifecycle'; }
    }
    try { save(); } catch { /* reason=evidence_failed уже сохранён в результате, новые процессы запрещены. */ }
  }
  return structuredClone(report);
}
