import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ProcessErrorCode, ProcessRequest, ProcessResult, ProcessRun, ProcessRunner } from '../../core/ports/process-runner.ts';
import { BoundedQueue } from './queue.ts';

export const DEFAULT_PROCESS_LIMITS = {
  timeoutMs: 120_000,
  stopGraceMs: 500,
  drainTimeoutMs: 1_000,
  maxQueueBytes: 1_048_576,
};

function limit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647 ? value : fallback;
}

/** Группа принадлежит этому spawn. Процессы, покинувшие её через setsid, не охвачены. */
export function createProcessRunner(defaults: Partial<typeof DEFAULT_PROCESS_LIMITS> = {}): ProcessRunner {
  const settings = { ...DEFAULT_PROCESS_LIMITS };
  for (const name of Object.keys(settings) as (keyof typeof settings)[]) settings[name] = limit(defaults[name], settings[name]);
  return { start: (request: ProcessRequest): ProcessRun => {
    const budget = limit(request.maxQueueBytes, settings.maxQueueBytes);
    const stdout = new BoundedQueue<Uint8Array>(budget, value => value.byteLength);
    const stderr = new BoundedQueue<Uint8Array>(budget, value => value.byteLength);
    let child: ChildProcessWithoutNullStreams | undefined;
    let finished = false;
    let interrupted = false;
    let killed = false;
    let exitCode: number | null = null;
    let signal: string | null = null;
    let error: ProcessErrorCode | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let drain: ReturnType<typeof setTimeout> | undefined;
    let resolveDone!: (result: ProcessResult) => void;
    const done = new Promise<ProcessResult>(resolve => { resolveDone = resolve; });

    const signalGroup = (name: NodeJS.Signals): void => {
      if (!child?.pid || finished) return;
      try { process.kill(-child.pid, name); }
      catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') error ??= 'spawn_failed';
      }
    };
    const finish = (): void => {
      if (finished) return;
      // Не оставляем обычных потомков, даже если они закрыли унаследованные pipes.
      signalGroup('SIGKILL');
      finished = true;
      clearTimeout(timer);
      clearTimeout(escalation);
      clearTimeout(drain);
      child?.stdin.destroy();
      child?.stdout.destroy();
      child?.stderr.destroy();
      stdout.finish();
      stderr.finish();
      resolveDone({ exitCode, signal, ...(error ? { error } : {}) });
    };
    const boundDrain = (): void => {
      if (drain || finished) return;
      drain = setTimeout(() => {
        error ??= 'drain_timeout';
        finish();
      }, limit(request.drainTimeoutMs, settings.drainTimeoutMs));
    };
    const force = (): void => {
      if (finished || killed) return;
      killed = true;
      signalGroup('SIGKILL');
      boundDrain();
    };
    const soft = (): void => {
      if (finished || interrupted) return;
      interrupted = true;
      signalGroup('SIGTERM');
      escalation = setTimeout(force, limit(request.stopGraceMs, settings.stopGraceMs));
    };
    const run: ProcessRun = {
      stdout, stderr, done,
      get pid() { return child?.pid; },
      interrupt: async () => { soft(); await done; },
      kill: async () => { force(); await done; },
    };
    if (process.platform === 'win32') {
      error = 'unsupported_platform';
      finish();
      return run;
    }
    try {
      child = spawn(request.executable, [...request.args], {
        cwd: request.cwd,
        env: { ...request.env },
        detached: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const receive = (queue: BoundedQueue<Uint8Array>, chunk: Buffer): void => {
        if (finished || error === 'output_limit') return;
        if (!queue.push(chunk)) { error = 'output_limit'; force(); }
      };
      child.stdout.on('data', (chunk: Buffer) => receive(stdout, chunk));
      child.stderr.on('data', (chunk: Buffer) => receive(stderr, chunk));
      child.stdout.on('end', () => stdout.finish());
      child.stderr.on('end', () => stderr.finish());
      child.stdout.on('error', () => { error ??= 'drain_timeout'; force(); });
      child.stderr.on('error', () => { error ??= 'drain_timeout'; force(); });
      child.on('error', () => { error ??= 'spawn_failed'; boundDrain(); });
      child.on('exit', (code, exitSignal) => {
        exitCode = code;
        signal = exitSignal;
        boundDrain();
      });
      child.on('close', (code, exitSignal) => {
        exitCode = code;
        signal = exitSignal;
        finish();
      });
      child.stdin.on('error', () => { error ??= 'stdin_failed'; force(); });
      child.stdin.end(request.stdin, 'utf8');
      timer = setTimeout(() => {
        error ??= 'timeout';
        soft();
      }, limit(request.timeoutMs, settings.timeoutMs));
    } catch {
      error = 'spawn_failed';
      finish();
    }
    return run;
  } };
}
