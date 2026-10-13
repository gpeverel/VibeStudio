import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProcessRunner } from '../../src/adapters/process-runner/index.ts';
import type { ProcessRequest, ProcessRun, ProcessRunner } from '../../src/core/ports/process-runner.ts';
import { Stand, pidAlive, waitFor } from '../helpers/claude/stand.ts';

// Обычные тесты вызывают настоящий spawn; fault-тесты подставляют только свой child.
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const stands: Stand[] = [];
const managed = new Set<ProcessRun>();
function stand(): Stand { const s = new Stand(); stands.push(s); return s; }
afterEach(async () => {
  // Даже упавший assertion не должен оставлять собственный управляемый запуск.
  const stopping = Promise.all([...managed].map(run => run.kill()));
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(30_000);
  await stopping;
  managed.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
  while (stands.length) stands.pop()?.cleanup();
});

const nativeRunner = createProcessRunner();
const runner: ProcessRunner = { start: request => {
  const run = nativeRunner.start(request);
  managed.add(run);
  return run;
} };
const base = (s: Stand, overrides: Partial<ProcessRequest> = {}): ProcessRequest => ({
  executable: process.execPath, args: [], cwd: s.dir, env: { PATH: '' }, stdin: '', ...overrides,
});
async function collect(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts).toString('utf8');
}
const node = (script: string): string[] => ['-e', script];

/** Ни один PID этого double не передаётся настоящему process.kill. */
function simulatedChild(errno?: 'EPERM' | 'ESRCH') {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), {
    pid: 424242, exitCode: null, signalCode: null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
  });
  vi.mocked(spawn).mockReturnValueOnce(child as unknown as ChildProcessWithoutNullStreams);
  const send = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    expect(pid).toBe(-child.pid);
    expect(['SIGTERM', 'SIGKILL']).toContain(signal);
    if (errno) throw Object.assign(new Error('synthetic signal failure'), { code: errno });
    return true;
  });
  const run = runner.start(base(stand(), { timeoutMs: 100, stopGraceMs: 10, drainTimeoutMs: 20 }));
  child.emit('spawn');
  return { child, send, run };
}

describe('P2a ProcessRunner: ошибки на doubles без сигналов реальным PID', () => {
  it.each(['EPERM', 'ESRCH'] as const)('%s не доказывает exit; deadline конечен и сохраняет результаты обеих попыток', async errno => {
    const { run, child, send } = simulatedChild(errno);
    const stop = run.interrupt();
    await vi.advanceTimersByTimeAsync(200);
    await stop;
    const result = await run.done;
    expect(result.completion).toMatchObject({
      process: { state: 'unconfirmed' }, wait: 'deadline',
      stdout: 'forced_closed', stderr: 'forced_closed', descendants: 'not_guaranteed',
    });
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      expect(result.completion.signals).toContainEqual(expect.objectContaining({
        signal, target: 'group', status: errno === 'EPERM' ? 'failed' : 'not_found', errorCode: errno,
      }));
    }
    expect(result.completion.signals.map(item => [item.target === 'group' ? -child.pid : child.pid, item.signal])).toEqual(send.mock.calls);
    expect(result.completion.issues).toContainEqual(expect.objectContaining({ code: 'exit_unconfirmed' }));
    expect(result.completion.issues).toContainEqual(expect.objectContaining({ code: 'drain_timeout' }));
    if (errno === 'EPERM') {
      expect(result.completion.issues).toContainEqual(expect.objectContaining({ code: 'signal_failed', errorCode: errno }));
    }
    const snapshot = JSON.stringify(result);
    const count = send.mock.calls.length;
    child.emit('exit', 0, null);
    child.stdout.emit('end');
    child.stderr.emit('end');
    child.emit('close', 0, null);
    await run.interrupt();
    await run.kill();
    expect(send).toHaveBeenCalledTimes(count);
    expect(JSON.stringify(await run.done)).toBe(snapshot);
  });

  it('успешная отправка SIGKILL без exit не становится подтверждённой остановкой', async () => {
    const { run } = simulatedChild();
    const stopped = run.kill();
    await vi.advanceTimersByTimeAsync(200);
    await stopped;
    expect((await run.done).completion).toMatchObject({ process: { state: 'unconfirmed' }, wait: 'deadline' });
    expect((await run.done).completion.signals).toContainEqual(expect.objectContaining({ signal: 'SIGKILL', status: 'sent' }));
  });

  it('close без exit не доказывает выход основного процесса', async () => {
    const { child, run } = simulatedChild();
    child.stdout.emit('end');
    child.stderr.emit('end');
    child.emit('close', 0, null);
    await vi.advanceTimersByTimeAsync(200);
    const result = await run.done;
    expect(result.error).toBe('exit_unconfirmed');
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBeNull();
    expect(result.completion.process).toEqual({ state: 'unconfirmed' });
    expect(result.completion.issues).toContainEqual(expect.objectContaining({ code: 'exit_unconfirmed' }));
  });

  it('ESRCH финальной уборки после exit сохраняется как not_found, не стирая подтверждённый выход', async () => {
    const { child, run, send } = simulatedChild('ESRCH');
    child.stdout.emit('end');
    child.stderr.emit('end');
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
    await vi.advanceTimersByTimeAsync(1);
    const result = await run.done;
    expect(result).toMatchObject({ exitCode: 0, signal: null, completion: {
      process: { state: 'exited', exitCode: 0, signal: null }, stdout: 'ended', stderr: 'ended', wait: 'settled', issues: [],
    } });
    expect(result.error).toBeUndefined();
    expect(send.mock.calls).toEqual([[-child.pid, 'SIGKILL']]);
    expect(result.completion.signals).toHaveLength(send.mock.calls.length);
    expect(result.completion.signals[0]).toMatchObject({ signal: 'SIGKILL', target: 'group', status: 'not_found', errorCode: 'ESRCH' });
  });

  it.each([
    ['stdout', false], ['stderr', false], ['stdout', true], ['stderr', true],
  ] as const)('%s read error сохраняется отдельно от EOF второго потока, Stop=%s', async (stream, stopped) => {
    const { child, run } = simulatedChild();
    const stopping = stopped ? run.interrupt() : undefined;
    const other = stream === 'stdout' ? 'stderr' : 'stdout';
    child[other].emit('end');
    child[stream].emit('error', Object.assign(new Error('synthetic read failure'), { code: 'EIO' }));
    child[stream].emit('end'); // поздний EOF не стирает уже наблюдавшуюся ошибку
    child.emit('exit', null, 'SIGKILL');
    child.emit('close', null, 'SIGKILL');
    await vi.advanceTimersByTimeAsync(200);
    await stopping;
    const result = await run.done;
    expect(result.completion[stream]).toBe('errored');
    expect(result.completion[other]).toBe('ended');
    expect(result.completion.issues).toContainEqual(expect.objectContaining({ code: 'stream_failed', operation: stream, errorCode: 'EIO' }));
    expect(result.completion.process).toEqual({ state: 'exited', exitCode: null, signal: 'SIGKILL' });
  });

  it('exit + stdout EOF не превращают принудительное закрытие stderr в штатный EOF', async () => {
    const { child, run } = simulatedChild();
    child.stdout.emit('end');
    child.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(200);
    expect((await run.done).completion).toMatchObject({
      process: { state: 'exited', exitCode: 0, signal: null }, stdout: 'ended', stderr: 'forced_closed', wait: 'deadline',
    });
    expect((await run.done).completion.issues).toContainEqual(expect.objectContaining({ code: 'drain_timeout' }));
  });
});

describe('0C ProcessRunner: жизненный цикл на реальных дочерних процессах', () => {
  it('stdout и stderr разделены; большой промпт доходит через stdin, а не argv', async () => {
    const s = stand();
    const big = 'ж'.repeat(300_000);
    const run = runner.start(base(s, {
      args: node(`let d='';process.stdin.setEncoding('utf8').on('data',c=>d+=c).on('end',()=>{process.stdout.write('len='+d.length);process.stderr.write('E')})`),
      stdin: big,
    }));
    const [out, err, result] = await Promise.all([collect(run.stdout), collect(run.stderr), run.done]);
    expect(out).toBe(`len=${big.length}`);
    expect(err).toBe('E');
    expect(result).toMatchObject({ exitCode: 0, signal: null });
    expect(result.error).toBeUndefined();
    expect(result.completion).toMatchObject({
      process: { state: 'exited', exitCode: 0, signal: null }, stdout: 'ended', stderr: 'ended',
      wait: 'settled', issues: [], descendants: 'not_guaranteed',
    });
  });

  it('аргументы с метасимволами shell передаются буквально (без shell)', async () => {
    const s = stand();
    const hostile = `$(touch ${s.path('PWNED')}); \`id\` | "x" 'y' && echo z`;
    const run = runner.start(base(s, { args: [...node('process.stdout.write(process.argv[1])'), hostile] }));
    const [out] = await Promise.all([collect(run.stdout), collect(run.stderr), run.done]);
    expect(out).toBe(hostile);
    expect(existsSync(s.path('PWNED'))).toBe(false);
  });

  it('env дочернего процесса — ровно переданный объект, окружение родителя не копируется', async () => {
    const s = stand();
    process.env.VS_PARENT_SECRET = 'must-not-leak';
    try {
      const run = runner.start(base(s, {
        env: { ONLY_THIS: '1' },
        args: node('process.stdout.write(JSON.stringify(Object.keys(process.env).sort()))'),
      }));
      const [out] = await Promise.all([collect(run.stdout), collect(run.stderr), run.done]);
      const keys = JSON.parse(out) as string[];
      expect(keys).toContain('ONLY_THIS');
      expect(keys).not.toContain('VS_PARENT_SECRET');
    } finally { delete process.env.VS_PARENT_SECRET; }
  });

  it('ошибка spawn (нет бинарника) даёт результат spawn_failed, а не исключение', async () => {
    const s = stand();
    const run = runner.start(base(s, { executable: s.path('нет-такого-claude') }));
    const result = await run.done;
    expect(result.error).toBe('spawn_failed');
    expect(result.exitCode).not.toBe(0);
    expect(result.completion.process).toEqual({ state: 'not_started' });
    expect(result.completion.issues).toContainEqual(expect.objectContaining({ code: 'spawn_failed' }));
    await expect(collect(run.stdout)).resolves.toBe('');
  });

  it('ненулевой код выхода отражается в результате', async () => {
    const s = stand();
    const run = runner.start(base(s, { args: node('process.exit(7)') }));
    expect(await run.done).toMatchObject({ exitCode: 7 });
  });

  it('таймаут завершает зависший процесс с error=timeout', async () => {
    const s = stand();
    const started = Date.now();
    const run = runner.start(base(s, { args: node('setInterval(()=>{},1000)'), timeoutMs: 200, stopGraceMs: 100, drainTimeoutMs: 200 }));
    const result = await run.done;
    expect(result.error).toBe('timeout');
    expect(result.completion.issues).toContainEqual(expect.objectContaining({ code: 'timeout' }));
    expect(result.completion.process.state).toBe('exited');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('interrupt идемпотентен; процесс, игнорирующий SIGTERM, убивается принудительно', async () => {
    const s = stand();
    const run = runner.start(base(s, {
      args: node(`process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)`),
      stopGraceMs: 100, drainTimeoutMs: 300,
    }));
    const reader = run.stdout[Symbol.asyncIterator]();
    await reader.next(); // процесс запущен, обработчик SIGTERM установлен
    const [a, b] = await Promise.all([run.interrupt(), run.interrupt()]);
    expect(a).toBeUndefined();
    expect(b).toBeUndefined();
    const first = await run.done;
    await run.interrupt();
    await run.kill();
    expect(await run.done).toBe(first);
    expect(first.signal).toBe('SIGKILL');
    expect(first.completion.process).toEqual({ state: 'exited', exitCode: null, signal: 'SIGKILL' });
    expect(first.completion.signals).toEqual(expect.arrayContaining([
      expect.objectContaining({ signal: 'SIGTERM', target: 'group', status: 'sent' }),
      expect.objectContaining({ signal: 'SIGKILL', target: 'group', status: 'sent' }),
    ]));
    expect(first.completion.signals.filter(item => item.signal === 'SIGTERM')).toHaveLength(1);
  });

  it('kill и interrupt после завершения безопасны и не меняют результат', async () => {
    const s = stand();
    const run = runner.start(base(s, { args: node('process.exit(0)') }));
    const result = await run.done;
    await run.kill();
    await run.interrupt();
    expect(await run.done).toEqual(result);
  });

  it('остановка уничтожает дочерние процессы, принадлежащие запуску', async () => {
    const s = stand();
    const pidFile = s.path('child.pid');
    const run = runner.start(base(s, {
      args: node(`const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000)`),
      stopGraceMs: 100, drainTimeoutMs: 300,
    }));
    expect(await waitFor(() => existsSync(pidFile))).toBe(true);
    const childPid = Number(readFileSync(pidFile, 'utf8'));
    expect(pidAlive(childPid)).toBe(true);
    await run.interrupt();
    expect((await run.done).completion.process.state).toBe('exited');
    expect(await waitFor(() => !pidAlive(childPid))).toBe(true);
  });

  it('detached потомок выходит из POSIX-группы: done не гарантирует остановку всего дерева', async () => {
    const s = stand();
    const marker = s.path('detached-finished.json');
    // Только собственный потомок; сам выходит через 1 с. PID не используется для убийства.
    const descendant = `setTimeout(()=>{require('node:fs').writeFileSync(${JSON.stringify(marker)},String(Date.now()));process.exit(0)},1000)`;
    const run = runner.start(base(s, {
      args: node(`const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:true,stdio:'ignore'});c.unref()`),
    }));
    expect(await run.done).toMatchObject({ exitCode: 0, signal: null,
      completion: { process: { state: 'exited' }, descendants: 'not_guaranteed' } });
    const completedAt = Date.now();
    expect(await waitFor(() => existsSync(marker))).toBe(true);
    // Свой потомок совершил запись ПОСЛЕ done родителя: это открытое ограничение 0C.
    expect(Number(readFileSync(marker, 'utf8'))).toBeGreaterThan(completedAt);
  });

  it('потомок, держащий pipes после выхода родителя, не подвешивает done и не остаётся жить', async () => {
    const s = stand();
    const pidFile = s.path('orphan.pid');
    const run = runner.start(base(s, {
      args: node(`const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));process.exit(0)`),
      drainTimeoutMs: 300,
    }));
    const started = Date.now();
    const result = await run.done;
    expect(result.completion.process).toEqual({ state: 'exited', exitCode: 0, signal: null });
    expect(result.completion.issues).toContainEqual(expect.objectContaining({ code: 'drain_timeout' }));
    expect(result.completion.stdout).toBe('forced_closed');
    expect(result.completion.stderr).toBe('forced_closed');
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await waitFor(() => existsSync(pidFile))).toBe(true);
    expect(await waitFor(() => !pidAlive(Number(readFileSync(pidFile, 'utf8'))))).toBe(true);
  });

  it('вывод сверх лимита очереди при непрочитанном stdout даёт output_limit', async () => {
    const s = stand();
    const run = runner.start(base(s, {
      args: node(`const l='x'.repeat(1024)+'\\n';(async()=>{for(let i=0;i<200000;i++){if(!process.stdout.write(l))await new Promise(r=>process.stdout.once('drain',r))}})()`),
      maxQueueBytes: 64 * 1024, stopGraceMs: 100, drainTimeoutMs: 300, timeoutMs: 20_000,
    }));
    const result = await run.done; // потребитель stdout не читает вообще
    expect(result.error).toBe('output_limit');
  });

  it('done не зависит от чтения потребителем stdout (малый вывод)', async () => {
    const s = stand();
    const run: ProcessRun = runner.start(base(s, { args: node('process.stdout.write("hi")') }));
    expect(await run.done).toMatchObject({ exitCode: 0 });
  });

  it('медленный потребитель в пределах лимита получает все данные без потерь', async () => {
    const s = stand();
    const run = runner.start(base(s, {
      args: node(`process.stdout.write('a'.repeat(20000))`), maxQueueBytes: 1024 * 1024,
    }));
    const parts: Buffer[] = [];
    for await (const chunk of run.stdout) { parts.push(Buffer.from(chunk)); await new Promise(r => setTimeout(r, 5)); }
    expect(Buffer.concat(parts).length).toBe(20000);
    await run.done;
  });
});
