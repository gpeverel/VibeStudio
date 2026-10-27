import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCodexAdapter } from '../../src/adapters/codex/index.ts';
import type { CodexAdapterOptions } from '../../src/adapters/codex/index.ts';
import type { CodexAdmission, CodexAdmissionContext, CodexRunRequest } from '../../src/adapters/codex/contracts.ts';
import type { AgentEvent, AgentRun, AgentRunCompletion } from '../../src/core/ports/agent.ts';
import type { ProcessCompletion } from '../../src/core/ports/process-runner.ts';
import { createProcessRunner } from '../../src/adapters/process-runner/index.ts';
import { CodexStand } from '../helpers/codex/stand.ts';
import { cleanCompletion, deferred, processDouble, processResult } from '../helpers/codex/process-double.ts';
import { detection, firstRequest, resumeRequest, SYNTHETIC_ADMISSION, THREAD } from '../helpers/codex/requests.ts';

// Доказательства оркестрации на synthetic doubles. Ни одной установленной CLI или provider request.
const SUCCESS = readFileSync(new URL('../fixtures/codex/synthetic-success.jsonl', import.meta.url), 'utf8');
const stands: CodexStand[] = [];
const doubles: ReturnType<typeof processDouble>[] = [];
const runs: AgentRun[] = [];
function stand() { const s = new CodexStand(); stands.push(s); return s; }
afterEach(async () => {
  for (const d of doubles.splice(0)) { d.stdout.end(); d.stderr.end(); d.result.resolve(processResult()); }
  const stopping = Promise.all(runs.splice(0).map(run => run.kill()));
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(10_000);
  await stopping;
  vi.useRealTimers();
  while (stands.length) stands.pop()?.cleanup();
});
function harness(options: Partial<CodexAdapterOptions> = {}) {
  const s = stand();
  const d = processDouble(); doubles.push(d);
  const binary = s.fake();
  const adapter = createCodexAdapter({
    runner: d.runner, env: { HOME: s.dir, PATH: '/usr/bin:/bin' }, detect: async () => detection(binary),
    assessAdmission: async () => SYNTHETIC_ADMISSION, timeoutMs: 100, stopGraceMs: 10, drainTimeoutMs: 20, ...options,
  });
  return { s, d, binary, adapter };
}
async function start(h: ReturnType<typeof harness>, request = firstRequest(h.s.dir), consume = true) {
  const run = await h.adapter.start(request); runs.push(run);
  const events: AgentEvent[] = [];
  const reading = consume ? (async () => { for await (const event of run.events) events.push(event); })() : Promise.resolve();
  return { ...h, run, request, events, reading };
}
async function boot(options: Partial<CodexAdapterOptions> = {}) {
  vi.useFakeTimers();
  const h = await start(harness(options));
  await h.d.launched.promise;
  return h;
}
function finishProcess(h: { d: ReturnType<typeof processDouble> }, completion = cleanCompletion(), stdout = SUCCESS) {
  h.d.stdout.end(stdout); h.d.stderr.end(); h.d.result.resolve(processResult(completion));
}
async function terminal(h: Awaited<ReturnType<typeof start>>) {
  const result = await h.run.done;
  await h.reading;
  const terminalEvents = h.events.filter(e => e.type === 'run_finished');
  expect(terminalEvents).toHaveLength(1);
  expect(terminalEvents[0]!.result).toBe(result);
  expect(h.events.at(-1)?.type).toBe('run_finished');
  expect(result.completion.descendants).toBe('not_guaranteed');
  return result;
}

describe('Codex P2a: единый terminal, exit/EOF и принятый Stop', () => {
  it('успех требует result, exit(0) и оба EOF; ID приложения не подменяется CLI-ID', async () => {
    const h = await boot();
    expect(h.events).toEqual([]);
    finishProcess(h);
    const result = await terminal(h);
    expect(result).toMatchObject({ kind: 'success', stopAccepted: false, completion: cleanCompletion() });
    expect(h.events[0]).toMatchObject({ type: 'run_started', agentSessionId: THREAD, sessionId: h.request.sessionId, turnId: h.request.turnId });
    expect(h.events.every((event, i) => i === 0 || event.seq > h.events[i - 1]!.seq)).toBe(true);
  });

  it('nonzero exit после протокольного success даёт ошибку', async () => {
    const h = await boot();
    finishProcess(h, cleanCompletion({ process: { state: 'exited', exitCode: 7, signal: null } }));
    expect(await terminal(h)).toMatchObject({ kind: 'error', reason: 'nonzero_exit', stopAccepted: false });
  });

  it('exit(0)/EOF без turn.completed не даёт success', async () => {
    const h = await boot();
    finishProcess(h, cleanCompletion(), `{"type":"thread.started","thread_id":"${THREAD}"}\n`);
    expect(await terminal(h)).toMatchObject({ kind: 'error', reason: 'missing_result' });
  });

  it.each(['interrupt', 'kill'] as const)('принятый %s побеждает поздний success', async method => {
    const h = await boot();
    const stopping = h.run[method]();
    finishProcess(h);
    await stopping;
    expect(await terminal(h)).toMatchObject({ kind: 'interrupted', stopAccepted: true });
  });

  it.each(['interrupt', 'kill'] as const)('ошибка %s сохраняется при гонке с done', async method => {
    const h = await boot();
    h.d[method].mockImplementation(() => {
      finishProcess(h);
      return Promise.reject(Object.assign(new Error('SECRET-SIGNAL-ERROR'), { code: 'EPERM' }));
    });
    await h.run[method]();
    const result = await terminal(h);
    expect(result).toMatchObject({ kind: 'interrupted', stopAccepted: true });
    expect(result.completion.issues).toContainEqual(expect.objectContaining({ code: 'signal_failed', operation: method, errorCode: 'EPERM' }));
    expect(JSON.stringify(result)).not.toContain('SECRET-SIGNAL-ERROR');
  });

  it('синхронный throw stop-метода не теряется', async () => {
    const h = await boot();
    h.d.interrupt.mockImplementation(() => { throw Object.assign(new Error('synthetic'), { code: 'EACCES' }); });
    const stopping = h.run.interrupt(); finishProcess(h); await stopping;
    expect((await terminal(h)).completion.issues).toContainEqual(expect.objectContaining({ code: 'signal_failed', operation: 'interrupt', errorCode: 'EACCES' }));
  });

  it('повтор Stop после terminal безопасен и не меняет снимок', async () => {
    const h = await boot();
    const stopping = h.run.interrupt(); finishProcess(h); await stopping;
    const result = await terminal(h);
    const before = JSON.stringify(result);
    const calls = h.d.interrupt.mock.calls.length + h.d.kill.mock.calls.length;
    await h.run.interrupt(); await h.run.kill();
    expect(await h.run.done).toBe(result);
    expect(JSON.stringify(result)).toBe(before);
    expect(h.d.interrupt.mock.calls.length + h.d.kill.mock.calls.length).toBe(calls);
  });

  it('deadline после Stop: нет выдуманного exit, позднее завершение снимок не меняет', async () => {
    const h = await boot();
    const stopping = h.run.interrupt();
    await vi.advanceTimersByTimeAsync(500); await stopping;
    const result = await terminal(h);
    expect(result).toMatchObject({ kind: 'interrupted', completion: { process: { state: 'unconfirmed' }, wait: 'deadline' } });
    expect(result.completion.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'timeout' }), expect.objectContaining({ code: 'exit_unconfirmed' }),
    ]));
    const snapshot = JSON.stringify(result);
    finishProcess(h); await vi.advanceTimersByTimeAsync(1);
    expect(JSON.stringify(await h.run.done)).toBe(snapshot);
  });

  it('Stop сохраняет вместе signal_failed, stream_failed и deadline', async () => {
    const h = await boot();
    h.d.interrupt.mockRejectedValue(Object.assign(new Error('synthetic'), { code: 'EPERM' }));
    const stopping = h.run.interrupt();
    h.d.stdout.destroy(Object.assign(new Error('synthetic'), { code: 'EIO' }));
    await vi.advanceTimersByTimeAsync(500); await stopping;
    const result = await terminal(h);
    expect(result).toMatchObject({ kind: 'interrupted', completion: { process: { state: 'unconfirmed' }, stdout: 'errored', wait: 'deadline' } });
    expect(result.completion.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'signal_failed', errorCode: 'EPERM' }),
      expect.objectContaining({ code: 'stream_failed', errorCode: 'EIO' }),
      expect.objectContaining({ code: 'timeout' }),
    ]));
  });

  it('drain timeout запрещает success и сохраняет известные EOF runner', async () => {
    const h = await boot();
    h.d.stdout.write(SUCCESS);
    h.d.result.resolve(processResult());
    await vi.advanceTimersByTimeAsync(50);
    const result = await terminal(h);
    expect(result).toMatchObject({ kind: 'error', reason: 'drain_timeout', completion: { stdout: 'ended', stderr: 'ended', wait: 'deadline' } });
    expect(result.completion.issues).toContainEqual(expect.objectContaining({ code: 'drain_timeout' }));
  });

  it.each([false, true])('rejected process.done сохраняется, Stop=%s', async stop => {
    const h = await boot();
    const stopping = stop ? h.run.interrupt() : undefined;
    h.d.stdout.end(); h.d.stderr.end();
    h.d.result.reject(Object.assign(new Error('SECRET-DONE-ERROR'), { code: 'EIO' }));
    await vi.advanceTimersByTimeAsync(100); await stopping;
    const result = await terminal(h);
    expect(result.kind).toBe(stop ? 'interrupted' : 'error');
    expect(result.completion.process.state).toBe('unconfirmed');
    expect(result.completion.issues).toContainEqual(expect.objectContaining({ code: 'process_result_failed', operation: 'done', errorCode: 'EIO' }));
    expect(JSON.stringify(result)).not.toContain('SECRET-DONE-ERROR');
  });

  it.each(['stdout', 'stderr'] as const)('ошибка %s сохраняется вместе со Stop', async stream => {
    const h = await boot();
    const stopping = h.run.interrupt();
    h.d[stream].destroy(Object.assign(new Error('SECRET-STREAM'), { code: 'EIO' }));
    h.d[stream === 'stdout' ? 'stderr' : 'stdout'].end();
    h.d.result.resolve(processResult());
    await vi.advanceTimersByTimeAsync(50); await stopping;
    const result = await terminal(h);
    expect(result.kind).toBe('interrupted');
    expect(result.completion[stream]).toBe('errored');
    expect(result.completion.issues).toContainEqual(expect.objectContaining({ code: 'stream_failed', operation: stream, errorCode: 'EIO' }));
  });

  it('зависший stop Promise отражён отдельным timeout, даже при exit/EOF', async () => {
    const h = await boot();
    const pending = deferred<void>();
    h.d.interrupt.mockReturnValue(pending.promise);
    const stopping = h.run.interrupt(); finishProcess(h);
    await vi.advanceTimersByTimeAsync(50); await stopping;
    const result = await terminal(h);
    expect(result).toMatchObject({ kind: 'interrupted', completion: { wait: 'deadline' } });
    expect(result.completion.issues).toContainEqual(expect.objectContaining({ code: 'timeout', operation: 'interrupt' }));
    pending.resolve();
  });

  it('неподтверждённый exit с EOF не даёт success', async () => {
    const h = await boot();
    finishProcess(h, cleanCompletion({ process: { state: 'unconfirmed' } }));
    expect((await terminal(h)).kind).toBe('error');
  });

  it('поздняя мутация вложенного completion runner не изменяет done', async () => {
    const h = await boot();
    const completion = cleanCompletion(); finishProcess(h, completion);
    const result = await terminal(h);
    const before = JSON.stringify(result);
    (completion as { process: ProcessCompletion['process'] }).process = { state: 'unconfirmed' };
    expect(JSON.stringify(result)).toBe(before);
  });

  it('terminal usage независим от события usage и не допускает мутацию', async () => {
    const h = await boot(); finishProcess(h);
    const result = await terminal(h);
    const usage = h.events.find(event => event.type === 'usage');
    expect(result.kind).toBe('success'); expect(usage).toBeDefined();
    if (result.kind !== 'success' || !result.usage || !usage) throw new Error('Нет ожидаемого usage');
    const before = JSON.stringify(result);
    Reflect.set(usage.usage, 'inputTokens', 999);
    expect(JSON.stringify(result)).toBe(before);
    expect(result.usage).not.toBe(usage.usage);
    expect(Object.isFrozen(result.usage)).toBe(true);
    expect(Reflect.set(result.usage, 'inputTokens', 888)).toBe(false);
    expect(JSON.stringify(await h.run.done)).toBe(before);
  });
});

describe('Codex start: допуск, история и ограничения до prompt', () => {
  it.each([null, undefined])('повреждённый запрос %s даёт один конечный invalid_request', async input => {
    vi.useFakeTimers();
    const h = harness();
    const run = await h.adapter.start(input as unknown as CodexRunRequest);
    // Не регистрируем в cleanup, ожидающем run.kill(): регрессия именно на зависший done.
    // Процесс не создаётся, оба controlled stream освобождаются общим afterEach.
    const events: AgentEvent[] = [];
    const reading = (async () => { for await (const event of run.events) events.push(event); })();
    let settled: AgentRunCompletion | undefined;
    void run.done.then(result => { settled = result; });
    await vi.advanceTimersByTimeAsync(500);
    expect(settled).toMatchObject({ kind: 'error', reason: 'invalid_request', completion: { process: { state: 'not_started' } } });
    await reading;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'run_finished', result: settled });
    expect(events[0]?.type === 'run_finished' && events[0].result).toBe(settled);
    expect(h.d.start).not.toHaveBeenCalled();
    await run.interrupt(); await run.kill();
    expect(await run.done).toBe(settled);
  });

  it('production отказ после available: prompt-процесс не запускается', async () => {
    const h = await start(harness({ assessAdmission: undefined }));
    expect(await terminal(h)).toMatchObject({ kind: 'error', reason: 'profile_unsupported', completion: { process: { state: 'not_started' } } });
    expect(h.d.start).not.toHaveBeenCalled();
  });

  it.each(['missing', 'directory'] as const)('available не заменяет проверку файла перед admission: %s', async replacement => {
    const assessAdmission = vi.fn(async () => SYNTHETIC_ADMISSION);
    const h0 = harness({ assessAdmission });
    rmSync(h0.binary);
    if (replacement === 'directory') mkdirSync(h0.binary);
    const h = await start(h0);
    expect(await terminal(h)).toMatchObject({ kind: 'error', reason: 'practical_admission_blocked',
      completion: { process: { state: 'not_started' } } });
    expect(assessAdmission).not.toHaveBeenCalled();
    expect(h.d.start).not.toHaveBeenCalled();
  });

  it.each(['replace', 'remove', 'rewrite'] as const)('изменение executable во время admission запрещает prompt: %s', async change => {
    const entered = deferred<CodexAdmissionContext>(); const pending = deferred<CodexAdmission>();
    const h = await start(harness({ assessAdmission: context => { entered.resolve(context); return pending.promise; } }));
    await entered.promise;
    if (change === 'replace') {
      const replacement = h.s.path('replacement');
      writeFileSync(replacement, readFileSync(h.binary), { mode: 0o755 });
      renameSync(replacement, h.binary);
    } else if (change === 'remove') rmSync(h.binary);
    else writeFileSync(h.binary, '#!/bin/sh\nexit 79\n');
    pending.resolve(SYNTHETIC_ADMISSION);
    const result = await terminal(h);
    expect(result).toMatchObject({ kind: 'error', reason: 'practical_admission_blocked',
      detail: expect.stringContaining('context_changed'), completion: { process: { state: 'not_started' } } });
    expect(h.d.start).not.toHaveBeenCalled();
    expect(h.events.some(event => event.type === 'run_started')).toBe(false);
  });

  it('Stop во время detect запрещает поздний launch', async () => {
    const pending = deferred<ReturnType<typeof detection>>();
    const h = await start(harness({ detect: () => pending.promise }));
    const stopping = h.run.interrupt(); pending.resolve(detection(h.binary)); await stopping;
    expect(await terminal(h)).toMatchObject({ kind: 'interrupted', completion: { process: { state: 'not_started' } } });
    expect(h.d.start).not.toHaveBeenCalled();
  });

  it('Stop во время admission запрещает поздний synthetic-ready launch', async () => {
    const entered = deferred<void>(); const pending = deferred<CodexAdmission>();
    const h = await start(harness({ assessAdmission: () => { entered.resolve(); return pending.promise; } }));
    await entered.promise;
    const stopping = h.run.interrupt(); pending.resolve(SYNTHETIC_ADMISSION); await stopping;
    expect((await terminal(h)).kind).toBe('interrupted');
    expect(h.d.start).not.toHaveBeenCalled();
  });

  it('зависший admission имеет конечный deadline и не запускается позднее', async () => {
    vi.useFakeTimers();
    const entered = deferred<void>(); const pending = deferred<CodexAdmission>();
    const h = await start(harness({ assessAdmission: () => { entered.resolve(); return pending.promise; } }));
    await entered.promise;
    await vi.advanceTimersByTimeAsync(500);
    expect(await terminal(h)).toMatchObject({ kind: 'error', reason: 'timeout' });
    pending.resolve(SYNTHETIC_ADMISSION); await vi.advanceTimersByTimeAsync(1);
    expect(h.d.start).not.toHaveBeenCalled();
  });

  it('оценённые argv/env и запрос не меняются при мутации исходного объекта', async () => {
    vi.useFakeTimers();
    const entered = deferred<CodexAdmissionContext>(); const pending = deferred<CodexAdmission>();
    const h0 = harness({ assessAdmission: context => { entered.resolve(context); return pending.promise; } });
    const request = firstRequest(h0.s.dir);
    const h = await start(h0, request);
    const context = await entered.promise;
    request.prompt = 'поздняя мутация';
    expect(Object.isFrozen(context)).toBe(true);
    pending.resolve(SYNTHETIC_ADMISSION);
    const launched = await h.d.launched.promise;
    expect(launched.args).toEqual(context.args);
    expect(launched.env).toEqual(context.env);
    expect(launched.stdin).toBe('Синтетическая задача');
    finishProcess(h); await terminal(h);
  });

  it.each(['resume', 'ephemeral', 'model'] as const)('неподдерживаемая %s не игнорируется', async capability => {
    const h0 = harness();
    const value = detection(h0.binary); value.capabilities[capability] = false;
    // Только подстановка доверенной synthetic-записи, чтобы дойти до проверки capability.
    const h1 = harness({ detect: async () => value, verifyThread: async () => true });
    const request = capability === 'resume' ? resumeRequest(h1.s.dir) : firstRequest(h1.s.dir, capability === 'model' ? { model: 'synthetic-model' } : { persistSession: false });
    const h = await start(h1, request);
    expect(await terminal(h)).toMatchObject({ kind: 'error', reason: 'capability_missing' });
    expect(h.d.start).not.toHaveBeenCalled();
  });

  it('запрещённый env отвергается до prompt', async () => {
    const h0 = harness();
    const h = await start(h0, firstRequest(h0.s.dir, { env: { NODE_OPTIONS: '--trace-warnings' } }));
    expect(await terminal(h)).toMatchObject({ kind: 'error', reason: 'invalid_request' });
    expect(h.d.start).not.toHaveBeenCalled();
  });

  it('resume с новым ID в thread.started не маскирует потерю истории', async () => {
    vi.useFakeTimers();
    const h0 = harness({ verifyThread: async () => true }); // Synthetic запись прежнего Codex-хода.
    const h = await start(h0, resumeRequest(h0.s.dir, '019a0000-0000-7000-8000-000000000002'));
    await h.d.launched.promise; finishProcess(h);
    expect(await terminal(h)).toMatchObject({ kind: 'error', reason: 'protocol_incompatible' });
  });

  it('тег codex и UUID без известной привязки недостаточны для resume', async () => {
    const h0 = harness();
    const h = await start(h0, resumeRequest(h0.s.dir));
    expect(await terminal(h)).toMatchObject({ kind: 'error', reason: 'invalid_request', completion: { process: { state: 'not_started' } } });
    expect(h.d.start).not.toHaveBeenCalled();
  });

  it.each(['sessionId', 'participantId', 'workspaceId', 'cwd'] as const)('полученный ID нельзя перенести в другой %s', async field => {
    const first = await boot(); finishProcess(first); await terminal(first);
    const request = resumeRequest(first.s.dir);
    request[field] = `${request[field]}-another`;
    if (field === 'cwd') request.profile = { ...request.profile, workspaceRoot: request.cwd };
    const resumed = await start(first, request);
    expect(await terminal(resumed)).toMatchObject({ kind: 'error', reason: 'invalid_request' });
    expect(first.d.start).toHaveBeenCalledTimes(1);
  });

  it('соседний экземпляр адаптера не наследует историю без доверенной записи', async () => {
    const first = await boot(); finishProcess(first); await terminal(first);
    const another = harness();
    const resumed = await start(another, resumeRequest(first.s.dir));
    expect(await terminal(resumed)).toMatchObject({ kind: 'error', reason: 'invalid_request' });
    expect(another.d.start).not.toHaveBeenCalled();
  });

  it('NUL внутри sessionId и participantId не позволяет перенести известный thread', async () => {
    vi.useFakeTimers();
    const h0 = harness();
    const first = await start(h0, firstRequest(h0.s.dir, { sessionId: 'session\0participant', participantId: 'one' }));
    await first.d.launched.promise; finishProcess(first); await terminal(first);
    const request = { ...resumeRequest(h0.s.dir), sessionId: 'session', participantId: 'participant\0one' };
    const resumed = await start(h0, request);
    expect(await terminal(resumed)).toMatchObject({ kind: 'error', reason: 'invalid_request' });
    expect(h0.d.start).toHaveBeenCalledTimes(1);
  });

  it.each(['false', 'reject'] as const)('неподтверждённая trusted-store привязка отклоняется: %s', async mode => {
    const verifyThread = vi.fn(async () => {
      if (mode === 'reject') throw new Error('SECRET STORE FAILURE');
      return false;
    });
    const h0 = harness({ verifyThread });
    const h = await start(h0, resumeRequest(h0.s.dir));
    const result = await terminal(h);
    expect(result).toMatchObject({ kind: 'error', reason: 'invalid_request' });
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(h.d.start).not.toHaveBeenCalled();
  });

  it('доверенная запись получает неизменяемую полную привязку и допускает resume', async () => {
    vi.useFakeTimers();
    const verifyThread = vi.fn<NonNullable<CodexAdapterOptions['verifyThread']>>(async () => true); // Synthetic Store, не реальная история.
    const h0 = harness({ verifyThread });
    const request = resumeRequest(h0.s.dir);
    const h = await start(h0, request);
    await h.d.launched.promise;
    expect(verifyThread).toHaveBeenCalledWith({ threadId: THREAD, sessionId: request.sessionId,
      participantId: request.participantId, workspaceId: request.workspaceId, cwd: request.cwd });
    expect(Object.isFrozen(verifyThread.mock.calls[0]?.[0])).toBe(true);
    finishProcess(h);
    expect((await terminal(h)).kind).toBe('success');
  });

  it('production detect на synthetic CLI: first→resume получает CLI-ID и продолжает seq', async () => {
    const s = stand();
    const help = (name: string) => readFileSync(new URL(`../fixtures/codex/synthetic-${name}-help.txt`, import.meta.url), 'utf8');
    const binary = s.fake({ probes: { execHelp: { stdout: help('exec') }, resumeHelp: { stdout: help('resume') } }, steps: [{ out: SUCCESS }] });
    const adapter = createCodexAdapter({ runner: createProcessRunner(), binaryPath: binary,
      env: { HOME: s.dir, PATH: '/usr/bin:/bin' }, assessAdmission: async () => SYNTHETIC_ADMISSION, timeoutMs: 5_000 });
    const first = await adapter.start(firstRequest(s.dir)); runs.push(first);
    const firstEvents: AgentEvent[] = []; for await (const event of first.events) firstEvents.push(event);
    expect((await first.done).kind).toBe('success');
    const started = firstEvents.find(e => e.type === 'run_started');
    expect(started?.agentSessionId).toBe(THREAD);
    const next = await adapter.start(resumeRequest(s.dir, started!.agentSessionId)); runs.push(next);
    const nextEvents: AgentEvent[] = []; for await (const event of next.events) nextEvents.push(event);
    expect((await next.done).kind).toBe('success');
    expect(nextEvents[0]!.seq).toBeGreaterThan(firstEvents.at(-1)!.seq);
    expect(nextEvents[0]).toMatchObject({ type: 'run_started', agentSessionId: THREAD, turnId: 'app-turn-synthetic-2' });
    const records = s.records().filter(r => r.probe === 'run');
    expect(records).toHaveLength(2);
    expect(records[0]!.argv.slice(0, 1)).toEqual(['exec']);
    expect(records[1]!.argv.slice(0, 2)).toEqual(['exec', 'resume']);
    expect(records[1]!.argv.slice(-2)).toEqual([THREAD, '-']);
    expect(s.records().map(record => record.probe)).toEqual([
      'version', 'execHelp', 'resumeHelp', 'auth', 'run', 'version', 'execHelp', 'resumeHelp', 'auth', 'run',
    ]);
  });

  it('неожиданный command_execution после ready прекращает ход', async () => {
    const h = await boot();
    finishProcess(h, cleanCompletion(), readFileSync(new URL('../fixtures/codex/synthetic-tools.jsonl', import.meta.url), 'utf8'));
    expect(await terminal(h)).toMatchObject({ kind: 'error', reason: 'runtime_inventory_mismatch' });
    expect(h.d.kill).toHaveBeenCalled();
  });

  it('stderr обрабатывается отдельно и ограниченно, не как JSONL', async () => {
    const h = await boot({ maxDiagBytes: 256 });
    h.d.stderr.write('SECRET-STDERR not json\n'.repeat(100));
    finishProcess(h);
    expect((await terminal(h)).kind).toBe('success');
    expect(JSON.stringify(h.run.diagnostics)).not.toContain('SECRET-STDERR');
    expect(h.run.diagnostics.reduce((n, d) => n + Buffer.byteLength(d.code + d.detail), 0)).toBeLessThanOrEqual(256);
  });

  it('переполнение очереди медленного потребителя даёт один terminal output_limit', async () => {
    vi.useFakeTimers();
    const h = await start(harness({ maxQueue: 1 }), undefined, false);
    await h.d.launched.promise; finishProcess(h);
    const result = await h.run.done;
    for await (const event of h.run.events) h.events.push(event);
    expect(await terminal(h)).toBe(result);
    expect(result).toMatchObject({ kind: 'error', reason: 'output_limit', stopAccepted: false });
  });

  it('настоящий локальный fake executable передаёт stdin и отдельный stderr', async () => {
    const s = stand();
    const binary = s.fake({ steps: [{ err: 'synthetic stderr' }, { out: SUCCESS, fragment: 1 }] });
    const adapter = createCodexAdapter({ runner: createProcessRunner(), detect: async () => detection(binary),
      env: { HOME: s.dir, PATH: '/usr/bin:/bin' }, assessAdmission: async () => SYNTHETIC_ADMISSION, timeoutMs: 5_000 });
    const request = firstRequest(s.dir, { prompt: 'строка 🌍\n$(не-команда)'.repeat(10_000) });
    const run = await adapter.start(request); runs.push(run);
    const events: AgentEvent[] = []; for await (const event of run.events) events.push(event);
    const result = await run.done;
    expect(result).toMatchObject({ kind: 'success', completion: { process: { state: 'exited', exitCode: 0 }, stdout: 'ended', stderr: 'ended' } });
    expect(events.filter(e => e.type === 'run_finished')).toHaveLength(1);
    expect(s.records().find(record => record.probe === 'run')?.stdin).toBe(request.prompt);
  });

  it('Stop собственного fake, игнорирующего SIGTERM, подтверждает SIGKILL и EOF', async () => {
    const s = stand();
    const binary = s.fake({ steps: [{ ignoreSigterm: true }, { out: `{"type":"thread.started","thread_id":"${THREAD}"}\n` }, { hang: true }] });
    const adapter = createCodexAdapter({ runner: createProcessRunner(), detect: async () => detection(binary),
      env: { HOME: s.dir, PATH: '/usr/bin:/bin' }, assessAdmission: async () => SYNTHETIC_ADMISSION,
      timeoutMs: 5_000, stopGraceMs: 50, drainTimeoutMs: 300 });
    const run = await adapter.start(firstRequest(s.dir)); runs.push(run);
    const active = deferred<void>(); const events: AgentEvent[] = [];
    const reading = (async () => { for await (const event of run.events) { events.push(event); if (event.type === 'run_started') active.resolve(); } })();
    await active.promise; await run.interrupt(); await reading;
    const result = await run.done;
    expect(result).toMatchObject({ kind: 'interrupted', stopAccepted: true, completion: {
      process: { state: 'exited', signal: 'SIGKILL' }, stdout: 'ended', stderr: 'ended', descendants: 'not_guaranteed',
    } });
    expect(result.completion.signals).toEqual(expect.arrayContaining([
      expect.objectContaining({ signal: 'SIGTERM', target: 'group', status: 'sent' }),
      expect.objectContaining({ signal: 'SIGKILL', target: 'group', status: 'sent' }),
    ]));
    expect(events.filter(e => e.type === 'run_finished')).toHaveLength(1);
  });
});
