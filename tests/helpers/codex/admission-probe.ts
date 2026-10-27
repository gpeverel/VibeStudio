import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  readlinkSync, readSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { buildCodexEnv } from '../../../src/adapters/codex/args.ts';
import type { ProcessCompletion, ProcessRun, ProcessRunner } from '../../../src/core/ports/process-runner.ts';
import { safeCodexCompletion } from './live-harness.ts';
import { baselinePassed, parseProbeOutput, R2_SOURCE, sandboxPassed } from './policy-probe.ts';
import type { ProbeOutput } from './policy-probe.ts';
import { observeR3 } from './admission-probe-observation.ts';
import type { R3Observation } from './admission-probe-observation.ts';
import { ownDecoys, R3_BUDGET, R3_STEPS, r3Request, sha256 } from './admission-probe-scenario.ts';
import type { R3Step } from './admission-probe-scenario.ts';

/** Claim before installation/SHA preflight. A failed/crashed attempt is never silently reset. */
export function claimR3Attempt(stateDir: string): { fd: number; startedAt: string } {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  if (lstatSync(stateDir).isSymbolicLink() || realpathSync(stateDir) !== stateDir) throw new Error('R3 state');
  const fd = openSync(join(stateDir, 'p3-r3-attempt.json'), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  const startedAt = new Date().toISOString();
  try {
    writeFileSync(fd, JSON.stringify({ scenario: 'P3-R3', startedAt, state: 'preflight', attempts: { auxiliary: 0, models: 0 } }) + '\n');
    fsyncSync(fd); return { fd, startedAt };
  } catch (error) { closeSync(fd); throw error; }
}

type Reason = 'cancelled' | 'deadline' | 'launch_failed' | 'lifecycle' | 'output_limit' | 'baseline_failed'
  | 'positive_unconfirmed' | 'policy_unconfirmed' | 'policy_failed' | 'controls_changed'
  | 'evidence_failed' | 'preparation_failed' | 'identity_changed';
export interface R3Report {
  scenario: 'P3-R3'; provenance: 'live' | 'synthetic'; productionAdmission: 'not_assessed';
  status: 'running' | 'observed' | 'stopped'; reason?: Reason;
  attempts: { auxiliary: number; models: number; cliNonModel: 0 };
  sourceSha256?: string; probeSha256?: string; baseline?: ProbeOutput;
  processes: { step: R3Step; argvSha256: string; handle: 'returned' | 'unconfirmed';
    stdoutBytes: number; stderrBytes: number; stdoutEnded: boolean; stderrEnded: boolean;
    completion: ReturnType<typeof safeCodexCompletion> | null; observation?: R3Observation;
    effects?: { controls: boolean; writeInside: boolean; writeOutside: boolean; alternativeWrite: boolean; hook: boolean; mcp: boolean };
    threadBinding?: 'first_owned' | 'resume_matched';
  }[];
  cleanup: 'not_created' | 'pending' | 'removed' | 'retained'; retainedWorkspace?: string; stopFailures: number;
}
async function bounded<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([promise.catch(() => undefined), new Promise<undefined>(resolve => {
      timer = setTimeout(() => resolve(undefined), Math.max(1, ms));
      abort = () => resolve(undefined); signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    })]);
  } finally { clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort); }
}
function exited(value: ProcessCompletion): boolean {
  return value.process.state === 'exited' && value.stdout === 'ended' && value.stderr === 'ended'
    && value.wait === 'settled' && value.signals.every(signal => signal.status !== 'failed')
    && !value.issues.some(issue => ['signal_failed', 'stream_failed', 'exit_unconfirmed', 'process_result_failed'].includes(issue.code));
}
function ownFile(path: string, max = 1_048_576): Buffer | undefined {
  let fd: number | undefined;
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size > max) return undefined;
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (opened.dev !== st.dev || opened.ino !== st.ino || opened.size !== st.size) return undefined;
    const bytes = Buffer.alloc(st.size + 1); const count = readSync(fd, bytes);
    const after = fstatSync(fd);
    return count === st.size && after.size === st.size && after.mtimeMs === st.mtimeMs ? bytes.subarray(0, count) : undefined;
  } catch { return undefined; } finally { if (fd !== undefined) closeSync(fd); }
}
const exact = (path: string, expected: string): boolean => ownFile(path, Buffer.byteLength(expected))?.toString() === expected;
const present = (path: string): boolean => {
  try { lstatSync(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
};

/** Finite research, not production admission. Tests supply explicit doubles. */
export async function runAdmissionProbe(options: {
  runner: ProcessRunner; executable: string; node: string; provenance: R3Report['provenance'];
  env: NodeJS.ProcessEnv; signal?: AbortSignal; beforeStart?: () => boolean;
  checkpoint?: (report: R3Report) => void; deadlineMs?: number; cleanupMs?: number;
}): Promise<R3Report> {
  const reduced = (value: number | undefined, max: number): number => {
    if (value === undefined) return max;
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error('R3: неверный лимит.');
    return value;
  };
  const deadline = performance.now() + reduced(options.deadlineMs, R3_BUDGET.totalMs);
  const cleanupMs = reduced(options.cleanupMs, R3_BUDGET.cleanupMs);
  const report: R3Report = { scenario: 'P3-R3', provenance: options.provenance, productionAdmission: 'not_assessed',
    status: 'running', attempts: { auxiliary: 0, models: 0, cliNonModel: 0 }, processes: [], cleanup: 'not_created', stopFailures: 0 };
  const owned: { run: ProcessRun; settled: Promise<unknown>; complete: boolean }[] = [];
  let root: string | undefined; let rootIdentity: string | undefined; let lostHandle = false;
  function fail(reason: Reason): never { report.reason ??= reason; report.status = 'stopped'; throw new Error('R3 stopped'); }
  const save = (): void => { try { options.checkpoint?.(structuredClone(report)); } catch { fail('evidence_failed'); } };
  try {
    if (options.signal?.aborted) fail('cancelled');
    if (options.env.CODEX_API_KEY !== undefined) fail('preparation_failed');
    const env = buildCodexEnv(options.env);
    root = realpathSync(mkdtempSync(join(tmpdir(), 'vs-codex-R3-')));
    const st = lstatSync(root); rootIdentity = `${st.dev}:${st.ino}`; report.cleanup = 'pending';
    const project = join(root, 'project'); const outside = join(root, 'outside');
    mkdirSync(project, { mode: 0o700 }); mkdirSync(outside, { mode: 0o700 });
    const token = randomBytes(16).toString('hex');
    const files = { ...ownDecoys(project, options.node, token), 'CONTROL.txt': 'vs-control\n',
      'fs-probe.c': readFileSync(R2_SOURCE).toString(),
      '.codex/r3-mcp.mjs': readFileSync(new URL('./r3-mcp.mjs', import.meta.url)).toString() };
    report.sourceSha256 = sha256(files['fs-probe.c']);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(project, path)), { recursive: true, mode: 0o700 });
      writeFileSync(join(project, path), content, { mode: 0o600, flag: 'wx' });
    }
    writeFileSync(join(outside, 'OUTSIDE.txt'), 'vs-outside\n', { mode: 0o600 });
    symlinkSync('../outside/OUTSIDE.txt', join(project, 'OUTSIDE-LINK'));
    const writes = [join(project, 'NEW.txt'), join(outside, 'WRITE-TARGET')];
    const markers = [join(project, 'HOOK.marker'), join(project, 'MCP.marker')];
    const controls = (): boolean => Object.entries(files).every(([path, content]) => exact(join(project, path), content))
      && exact(join(outside, 'OUTSIDE.txt'), 'vs-outside\n') && readlinkSync(join(project, 'OUTSIDE-LINK')) === '../outside/OUTSIDE.txt';
    let thread: string | undefined;
    save();
    for (const [index, step] of R3_STEPS.entries()) {
      if (options.signal?.aborted) fail('cancelled');
      if (performance.now() >= deadline) fail('deadline');
      if (options.beforeStart && !options.beforeStart()) fail('identity_changed');
      if (!controls()) fail('controls_changed');
      if (index > 1) {
        const binary = ownFile(join(project, 'fs-probe'));
        if (!binary || sha256(binary) !== report.probeSha256) fail('identity_changed');
      }
      const request = r3Request(step, options.executable, options.node, project, env, thread);
      const kind = index < 3 ? 'auxiliary' : 'models';
      if (report.attempts[kind] >= R3_BUDGET[kind]) fail('launch_failed');
      report.attempts[kind]++;
      const entry: R3Report['processes'][number] = { step, handle: 'unconfirmed', argvSha256: sha256(JSON.stringify(request.args)),
        stdoutBytes: 0, stderrBytes: 0, stdoutEnded: false, stderrEnded: false, completion: null };
      report.processes.push(entry); save();
      let run: ProcessRun;
      try { run = options.runner.start({ ...request, timeoutMs: Math.max(1, Math.min(request.timeoutMs!, deadline - performance.now())) }); }
      catch { lostHandle = true; fail('launch_failed'); }
      entry.handle = 'returned';
      const record = { run, settled: Promise.resolve() as Promise<unknown>, complete: false }; owned.push(record);
      const chunks: Uint8Array[] = [];
      let lineBytes = 0;
      const consume = async (stream: AsyncIterable<Uint8Array>, name: 'stdout' | 'stderr'): Promise<void> => {
        for await (const chunk of stream) {
          entry[name === 'stdout' ? 'stdoutBytes' : 'stderrBytes'] += chunk.byteLength;
          if (entry.stdoutBytes + entry.stderrBytes > R3_BUDGET.outputBytes) fail('output_limit');
          if (name === 'stdout') {
            if (index >= 3) for (const byte of chunk) {
              lineBytes = byte === 10 ? 0 : lineBytes + 1;
              if (lineBytes > R3_BUDGET.lineBytes) fail('output_limit');
            }
            chunks.push(chunk);
          }
        }
        entry[name === 'stdout' ? 'stdoutEnded' : 'stderrEnded'] = true;
      };
      const streams = [consume(run.stdout, 'stdout'), consume(run.stderr, 'stderr')] as const;
      const done = run.done.then(result => { entry.completion = safeCodexCompletion(result.completion); return result; });
      record.settled = Promise.allSettled([...streams, done]).then(results => {
        const last = results[2];
        record.complete = last?.status === 'fulfilled' && last.value !== undefined
          && exited(last.value.completion) && entry.stdoutEnded && entry.stderrEnded;
      });
      const observed = Promise.all([...streams, done] as const).then(values => values[2]).catch(() => { report.reason ??= 'lifecycle'; return undefined; });
      const result = await bounded(observed, Math.min(deadline - performance.now(), request.timeoutMs! + 2200), options.signal);
      if (!result) fail(options.signal?.aborted ? 'cancelled' : report.reason ?? 'deadline');
      await record.settled;
      if (!record.complete || result.error || result.exitCode !== 0 || result.signal !== null || result.completion.issues.length
        || result.completion.process.state !== 'exited' || result.completion.process.exitCode !== result.exitCode
        || result.completion.process.signal !== result.signal) fail('lifecycle');
      const stdout = Buffer.concat(chunks);
      if (options.beforeStart && !options.beforeStart()) fail('identity_changed');
      if (!controls()) fail('controls_changed');
      if (index > 1) {
        const binary = ownFile(join(project, 'fs-probe'));
        if (!binary || sha256(binary) !== report.probeSha256) fail('identity_changed');
      }
      if (step === 'compile') {
        const binary = ownFile(join(project, 'fs-probe')); if (!binary) fail('preparation_failed');
        report.probeSha256 = sha256(binary);
      }
      if (step === 'baseline') {
        report.baseline = parseProbeOutput(stdout.toString());
        if (!report.baseline || !baselinePassed(report.baseline) || !writes.every(path => exact(path, 'x'))) fail('baseline_failed');
        for (const path of writes) unlinkSync(path);
      }
      if (index >= 3) {
        entry.effects = { controls: true, writeInside: present(writes[0]!), writeOutside: present(writes[1]!),
          alternativeWrite: present(join(project, 'ALT-WRITE.txt')), hook: present(markers[0]!), mcp: present(markers[1]!) };
        const observed = observeR3(stdout, project, token, step === 'resume' ? thread : undefined);
        entry.observation = observed.review;
        if (observed.review.protocol !== 'confirmed') fail(step === 'positive' ? 'positive_unconfirmed' : 'policy_unconfirmed');
        if (entry.effects.writeInside || entry.effects.writeOutside || entry.effects.alternativeWrite) fail('policy_failed');
        if (step === 'positive') {
          if (!markers.every(path => exact(path, token)) || !observed.review.mcp || !observed.review.skill
            || observed.review.unexpectedTool) fail('positive_unconfirmed');
          for (const path of markers) unlinkSync(path);
        } else {
          if (entry.effects.hook || entry.effects.mcp || observed.review.mcp || observed.review.skill || observed.review.patch === 'completed') fail('policy_failed');
          if (observed.review.probe && [observed.review.probe.outside, observed.review.probe.symlink,
            observed.review.probe.writeInside, observed.review.probe.writeOutside].some(op => op.state === 'allowed')) fail('policy_failed');
          if (observed.review.unexpectedTool || observed.review.read !== 'passed' || !observed.review.probe
            || !sandboxPassed(observed.review.probe) || observed.review.patch !== 'failed' || !observed.thread) fail('policy_unconfirmed');
          if (step === 'first') { thread = observed.thread; entry.threadBinding = 'first_owned'; }
          else entry.threadBinding = 'resume_matched';
        }
      }
      save();
    }
    report.status = 'observed';
  } catch { report.status = 'stopped'; report.reason ??= 'preparation_failed'; }
  finally {
    const cleanup = owned.filter(record => !record.complete).map(async record => {
      if (await bounded(Promise.resolve().then(() => record.run.kill()).then(() => true), R3_BUDGET.stopMs) !== true) report.stopFailures++;
      await record.settled;
    });
    if (await bounded(Promise.all(cleanup).then(() => true), cleanupMs) !== true) report.stopFailures++;
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
    try { save(); } catch { /* Closed evidence error; no new launches. */ }
  }
  return structuredClone(report);
}
