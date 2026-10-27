import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCodexAdapter } from '../../src/adapters/codex/index.ts';
import type { AgentEvent, AgentRun } from '../../src/core/ports/agent.ts';
import type { ProcessCompletion, ProcessRequest } from '../../src/core/ports/process-runner.ts';
import { CodexStand } from '../helpers/codex/stand.ts';
import { cleanCompletion, deferred, processDouble, processResult } from '../helpers/codex/process-double.ts';
import { firstRequest, SYNTHETIC_ADMISSION } from '../helpers/codex/requests.ts';

// Настоящий detectCodex, но runner полностью управляемый. Созданный файл лишь stat/access:
// ни установленная CLI, ни fake executable в этом наборе не исполняются.
type Double = ReturnType<typeof processDouble>;
const stands: CodexStand[] = [];
const doubles: Double[] = [];
const runs: AgentRun[] = [];
function complete(d: Double, completion: ProcessCompletion = cleanCompletion()) {
  d.stdout.end('codex-cli 0.163.0\n'); d.stderr.end(); d.result.resolve(processResult(completion));
}
afterEach(async () => {
  for (const d of doubles) complete(d);
  const stopping = Promise.all(runs.splice(0).map(run => run.kill()));
  await vi.advanceTimersByTimeAsync(10_000);
  await stopping;
  doubles.splice(0); vi.useRealTimers();
  while (stands.length) stands.pop()?.cleanup();
});
async function boot(drainTimeoutMs = 20) {
  vi.useFakeTimers();
  const s = new CodexStand(); stands.push(s);
  const entered = deferred<Double>();
  let count = 0;
  const start = vi.fn((request: ProcessRequest) => {
    const d = processDouble(); doubles.push(d);
    if (count++ === 0) entered.resolve(d);
    else complete(d); // Поздние probes видны в счётчике, а cleanup не виснет на них.
    return d.start(request);
  });
  const assessAdmission = vi.fn(async () => SYNTHETIC_ADMISSION);
  const adapter = createCodexAdapter({ runner: { start }, binaryPath: s.fake(), env: { HOME: s.dir, PATH: '/usr/bin:/bin' },
    assessAdmission, timeoutMs: 100, stopGraceMs: 10, drainTimeoutMs });
  const run = await adapter.start(firstRequest(s.dir)); runs.push(run);
  const events: AgentEvent[] = [];
  const reading = (async () => { for await (const event of run.events) events.push(event); })();
  const d = await entered.promise;
  expect(start.mock.calls[0]?.[0].args).toEqual(['--version']);
  return { run, d, start, assessAdmission, events, reading };
}
async function terminal(h: Awaited<ReturnType<typeof boot>>) {
  const result = await h.run.done; await h.reading;
  const events = h.events.filter(event => event.type === 'run_finished');
  expect(events).toHaveLength(1);
  expect(events[0]!.result).toBe(result);
  expect(h.assessAdmission).not.toHaveBeenCalled();
  return result;
}

describe('Stop владеет диагностикой production detectCodex', () => {
  it.each(['interrupt', 'kill'] as const)('%s останавливает активный probe и не запускает следующие', async method => {
    const h = await boot();
    const signal = method === 'interrupt' ? 'SIGTERM' : 'SIGKILL';
    h.d[method].mockImplementation(async () => complete(h.d, cleanCompletion({
      process: { state: 'exited', exitCode: null, signal }, signals: [{ signal, target: 'group', status: 'sent' }],
    })));
    const stopping = h.run[method]();
    await vi.advanceTimersByTimeAsync(500); await stopping;
    const result = await terminal(h);
    expect(h.d[method]).toHaveBeenCalled();
    expect(result).toMatchObject({ kind: 'interrupted', stopAccepted: true,
      completion: { process: { state: 'exited', signal }, stdout: 'ended', stderr: 'ended' } });
    expect(result.completion.signals).toContainEqual({ signal, target: 'group', status: 'sent' });
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  it('ошибка Stop диагностики и неподтверждённый exit сохраняются; поздний done не запускает probes', async () => {
    const h = await boot();
    h.d.interrupt.mockRejectedValue(Object.assign(new Error('SECRET diagnostic stop'), { code: 'EPERM' }));
    const stopping = h.run.interrupt();
    await vi.advanceTimersByTimeAsync(500); await stopping;
    const result = await terminal(h);
    expect(result).toMatchObject({ kind: 'interrupted', completion: { process: { state: 'unconfirmed' }, wait: 'deadline' } });
    expect(result.completion.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'signal_failed', operation: 'interrupt', errorCode: 'EPERM' }),
      expect.objectContaining({ code: 'exit_unconfirmed' }),
    ]));
    const before = JSON.stringify(result);
    complete(h.d); await vi.advanceTimersByTimeAsync(10);
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(await h.run.done)).toBe(before);
    expect(before).not.toContain('SECRET');
  });

  it('deadline диагностики вызывает kill, запрещает поздние probes и не выдумывает not_started', async () => {
    const h = await boot();
    await vi.advanceTimersByTimeAsync(500);
    const result = await terminal(h);
    expect(h.d.kill).toHaveBeenCalled();
    expect(result).toMatchObject({ kind: 'error', reason: 'timeout', stopAccepted: false,
      completion: { process: { state: 'unconfirmed' }, wait: 'deadline' } });
    complete(h.d); await vi.advanceTimersByTimeAsync(10);
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  it('поздний EPERM после diagnostic done сохраняется до terminal в пределах drain-бюджета', async () => {
    const h = await boot(50);
    h.d.interrupt.mockImplementation(() => {
      complete(h.d);
      const pending = deferred<void>();
      setTimeout(() => pending.reject(Object.assign(new Error('SECRET late stop'), { code: 'EPERM' })), 10);
      return pending.promise;
    });
    let settled = false;
    void h.run.done.then(() => { settled = true; });
    const stopping = h.run.interrupt();
    await vi.advanceTimersByTimeAsync(5);
    const finishedBeforeStopSettled = settled;
    await vi.advanceTimersByTimeAsync(20); await stopping;
    const result = await terminal(h);
    expect(result).toMatchObject({ kind: 'interrupted', stopAccepted: true,
      completion: { process: { state: 'exited' }, wait: 'settled' } });
    expect(result.completion.issues).toContainEqual(expect.objectContaining({ code: 'signal_failed', operation: 'interrupt', errorCode: 'EPERM' }));
    expect(result.completion.issues.some(issue => issue.code === 'timeout' && issue.operation === 'interrupt')).toBe(false);
    expect(finishedBeforeStopSettled).toBe(false);
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it.each(['stdout', 'stderr'] as const)('ошибка %s диагностики вызывает cleanup до deadline и сохраняет stream_failed', async stream => {
    const h = await boot();
    h.d[stream].destroy(Object.assign(new Error('SECRET diagnostic stream'), { code: 'EIO' }));
    await vi.advanceTimersByTimeAsync(5);
    const killsBeforeDeadline = h.d.kill.mock.calls.length;
    await vi.advanceTimersByTimeAsync(500);
    const result = await terminal(h);
    expect(killsBeforeDeadline).toBeGreaterThan(0);
    expect(result).toMatchObject({ kind: 'error', stopAccepted: false,
      completion: { process: { state: 'unconfirmed' }, [stream]: 'errored' } });
    expect(result.completion.issues).toContainEqual(expect.objectContaining({ code: 'stream_failed', operation: stream, errorCode: 'EIO' }));
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('SECRET');
    const before = JSON.stringify(result);
    complete(h.d); await vi.advanceTimersByTimeAsync(10);
    expect(JSON.stringify(await h.run.done)).toBe(before);
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  it('внутренний kill после stream EIO сохраняет поздний отказ, даже если diagnostic done уже получен', async () => {
    const h = await boot(50);
    h.d.kill.mockImplementation(() => {
      complete(h.d, cleanCompletion({ stdout: 'errored' }));
      const pending = deferred<void>();
      setTimeout(() => pending.reject(Object.assign(new Error('SECRET cleanup failure'), { code: 'EPERM' })), 10);
      return pending.promise;
    });
    h.d.stdout.destroy(Object.assign(new Error('SECRET diagnostic stream'), { code: 'EIO' }));
    await vi.advanceTimersByTimeAsync(30);
    const result = await terminal(h);
    expect(result.kind).toBe('error');
    expect(h.d.kill).toHaveBeenCalled();
    expect(result.completion.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'stream_failed', operation: 'stdout', errorCode: 'EIO' }),
      expect.objectContaining({ code: 'signal_failed', operation: 'kill', errorCode: 'EPERM' }),
    ]));
    expect(result.completion.issues.some(issue => issue.code === 'timeout')).toBe(false);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });
});
