import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  ProcessCompletion, ProcessCompletionIssue, ProcessCompletionIssueCode, ProcessErrorCode, ProcessRequest, ProcessResult,
  ProcessRun, ProcessSignalResult, ProcessStreamState,
} from '../../core/ports/process-runner.ts';
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

/** Только безопасные метаданные: errno-код без текста исходной ошибки. */
function errnoCode(cause: unknown): string | undefined {
  const code = (cause as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' ? code.slice(0, 32) : undefined;
}

/** Группа принадлежит этому spawn. Процессы, покинувшие её через setsid, не охвачены. */
export interface InteractiveProcessRun extends ProcessRun {
  send(text: string): Promise<void>;
  closeInput(): void;
}
export interface InteractiveProcessRunner { start(request: ProcessRequest): InteractiveProcessRun }

/** Отдельный двусторонний режим; исходный runner R2 и Claude сохраняются без изменений. */
export function createInteractiveProcessRunner(defaults: Partial<typeof DEFAULT_PROCESS_LIMITS> = {}): InteractiveProcessRunner {
  const settings = { ...DEFAULT_PROCESS_LIMITS };
  for (const name of Object.keys(settings) as (keyof typeof settings)[]) settings[name] = limit(defaults[name], settings[name]);
  return { start: (request: ProcessRequest): InteractiveProcessRun => {
    const budget = limit(request.maxQueueBytes, settings.maxQueueBytes);
    const stdout = new BoundedQueue<Uint8Array>(budget, value => value.byteLength);
    const stderr = new BoundedQueue<Uint8Array>(budget, value => value.byteLength);
    let child: ChildProcessWithoutNullStreams | undefined;
    let finished = false;
    let interrupted = false;
    let killed = false;
    let exitCode: number | null = null;
    let signal: string | null = null;
    /** Legacy-причина: только первая. Полная совокупность — в issues. */
    let error: ProcessErrorCode | undefined;
    // Факты завершения. Отсутствие наблюдения никогда не становится подтверждением.
    let spawned = false;
    let exitObserved = false;
    let exitInfo: { exitCode: number | null; signal: string | null } | undefined;
    let stdoutState: ProcessStreamState = 'not_started';
    let stderrState: ProcessStreamState = 'not_started';
    let waitExhausted = false;
    const signals: ProcessSignalResult[] = [];
    const issues: ProcessCompletionIssue[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let drain: ReturnType<typeof setTimeout> | undefined;
    let resolveDone!: (result: ProcessResult) => void;
    const done = new Promise<ProcessResult>(resolve => { resolveDone = resolve; });

    const note = (code: ProcessCompletionIssueCode, detail: string, operation?: ProcessCompletionIssue['operation'], errorCode?: string): void => {
      if (issues.some(item => item.code === code && item.operation === operation && item.errorCode === errorCode)) return;
      issues.push({ code, ...(operation ? { operation } : {}), ...(errorCode ? { errorCode } : {}), detail });
    };
    const fail = (legacy: ProcessErrorCode, detail: string, operation?: ProcessCompletionIssue['operation'], errorCode?: string): void => {
      error ??= legacy;
      note(legacy, detail, operation, errorCode);
    };
    const streamFailed = (operation: 'stdout' | 'stderr', cause: unknown): void => {
      if (operation === 'stdout') stdoutState = 'errored'; else stderrState = 'errored';
      fail('stream_failed', 'Ошибка чтения потока процесса', operation, errnoCode(cause));
      force();
    };

    /** Сигнал только своей группе (pid собственного spawn). Результат отправки записывается, а не глотается. */
    const signalGroup = (name: 'SIGTERM' | 'SIGKILL', operation: 'interrupt' | 'kill'): void => {
      if (!child?.pid || finished) return;
      try {
        process.kill(-child.pid, name);
        signals.push({ signal: name, target: 'group', status: 'sent' });
      } catch (cause) {
        const code = errnoCode(cause);
        if (code === 'ESRCH') {
          // ESRCH не доказывает exit: это лишь «группы больше нет» на момент вызова.
          signals.push({ signal: name, target: 'group', status: 'not_found', errorCode: 'ESRCH' });
        } else {
          signals.push({ signal: name, target: 'group', status: 'failed', ...(code ? { errorCode: code } : {}) });
          fail('signal_failed', 'Не удалось отправить сигнал процессу', operation, code);
        }
      }
    };
    const completion = (): ProcessCompletion => {
      const exited = spawned && exitObserved && exitInfo !== undefined;
      const streamState = (state: ProcessStreamState): ProcessStreamState => (!spawned ? 'not_started' : state === 'unconfirmed' || state === 'not_started' ? 'forced_closed' : state);
      return Object.freeze({
        process: Object.freeze(!spawned ? { state: 'not_started' as const }
          : exited ? { state: 'exited' as const, exitCode: exitInfo!.exitCode, signal: exitInfo!.signal }
          : { state: 'unconfirmed' as const }),
        stdout: streamState(stdoutState),
        stderr: streamState(stderrState),
        signals: Object.freeze(signals.map(item => Object.freeze({ ...item }))),
        wait: waitExhausted ? 'deadline' as const : 'settled' as const,
        issues: Object.freeze(issues.map(item => Object.freeze({ ...item }))),
        descendants: 'not_guaranteed' as const,
      });
    };
    const finish = (): void => {
      if (finished) return;
      // Не оставляем обычных потомков, даже если они закрыли унаследованные pipes.
      // Финальная отправка тоже попадает в signals; not_found после exit штатен и не ошибка остановки.
      signalGroup('SIGKILL', 'kill');
      finished = true;
      clearTimeout(timer);
      clearTimeout(escalation);
      clearTimeout(drain);
      child?.stdin.destroy();
      child?.stdout.destroy();
      child?.stderr.destroy();
      stdout.finish();
      stderr.finish();
      if (spawned && !exitObserved) fail('exit_unconfirmed','Выход основного процесса не подтверждён', 'wait');
      // Принудительное закрытие потоков не штатный EOF: состояние фиксирует completion().
      resolveDone({ exitCode, signal, ...(error ? { error } : {}), completion: completion() });
    };
    const boundDrain = (): void => {
      if (drain || finished) return;
      drain = setTimeout(() => {
        waitExhausted = true;
        fail('drain_timeout', 'Потоки или выход процесса не завершились за отведённое время', 'wait');
        finish();
      }, limit(request.drainTimeoutMs, settings.drainTimeoutMs));
    };
    const force = (): void => {
      if (finished || killed) return;
      killed = true;
      signalGroup('SIGKILL', 'kill');
      boundDrain();
    };
    const soft = (): void => {
      if (finished || interrupted || killed) return;
      interrupted = true;
      signalGroup('SIGTERM', 'interrupt');
      escalation = setTimeout(force, limit(request.stopGraceMs, settings.stopGraceMs));
    };
    let inputClosed = false;
    let inputPending = false;
    const run: InteractiveProcessRun = {
      send: text => {
        if (finished || inputClosed || !child?.stdin.writable || inputPending) return Promise.reject(new Error('stdin_unavailable'));
        if (Buffer.byteLength(text) > budget) { fail('stdin_failed', 'Превышен лимит входного сообщения', 'stdin'); force(); return Promise.reject(new Error('stdin_limit')); }
        inputPending = true;
        return new Promise<void>((resolve, reject) => {
          child!.stdin.write(text, 'utf8', cause => { inputPending = false; if (cause) reject(cause); else resolve(); });
        });
      },
      closeInput: () => { if (!finished && !inputClosed) { inputClosed = true; child?.stdin.end(); } },
      stdout, stderr, done,
      get pid() { return child?.pid; },
      interrupt: async () => { soft(); await done; },
      kill: async () => { force(); await done; },
    };
    if (process.platform === 'win32') {
      fail('unsupported_platform', 'Платформа не поддерживается', 'spawn');
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
      // pid есть только у реально запущенного процесса; ENOENT и подобное дают error/close без запуска.
      if (child.pid !== undefined) {
        spawned = true;
        stdoutState = 'unconfirmed';
        stderrState = 'unconfirmed';
      }
      const receive = (queue: BoundedQueue<Uint8Array>, operation: 'stdout' | 'stderr', chunk: Buffer): void => {
        if (finished || error === 'output_limit') return;
        if (!queue.push(chunk)) { fail('output_limit', 'Превышен лимит очереди вывода', operation); force(); }
      };
      child.stdout.on('data', (chunk: Buffer) => receive(stdout, 'stdout', chunk));
      child.stderr.on('data', (chunk: Buffer) => receive(stderr, 'stderr', chunk));
      // Штатный EOF после ошибки чтения не отменяет саму ошибку.
      child.stdout.on('end', () => { if (stdoutState === 'unconfirmed') stdoutState = 'ended'; stdout.finish(); });
      child.stderr.on('end', () => { if (stderrState === 'unconfirmed') stderrState = 'ended'; stderr.finish(); });
      child.stdout.on('error', cause => streamFailed('stdout', cause));
      child.stderr.on('error', cause => streamFailed('stderr', cause));
      child.on('error', cause => { fail('spawn_failed', 'Ошибка процесса CLI', 'spawn', errnoCode(cause)); boundDrain(); });
      child.on('exit', (code, exitSignal) => {
        exitObserved = true;
        exitInfo = { exitCode: code, signal: exitSignal };
        exitCode = code;
        signal = exitSignal;
        boundDrain();
      });
      // close без exit не подтверждает выход и не даёт exitCode/signal: их проецирует только наблюдённый exit.
      child.on('close', () => finish());
      child.stdin.on('error', cause => { fail('stdin_failed', 'Не удалось передать stdin процессу', 'stdin', errnoCode(cause)); force(); });
      if (request.stdin) void run.send(request.stdin).catch(() => { fail('stdin_failed', 'Не удалось передать stdin процессу', 'stdin'); force(); });
      timer = setTimeout(() => {
        fail('timeout', 'Превышено время работы процесса', 'wait');
        soft();
      }, limit(request.timeoutMs, settings.timeoutMs));
    } catch (cause) {
      fail('spawn_failed', 'Не удалось запустить процесс', 'spawn', errnoCode(cause));
      finish();
    }
    return run;
  } };
}
