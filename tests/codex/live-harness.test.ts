import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRun, AgentRunCompletion, NormalizedPayload, ProcessCompletion } from '../../src/core/ports/agent.ts';
import type { ProcessRequest, ProcessRun } from '../../src/core/ports/process-runner.ts';
import { createCodexLiveHarness, M_BUDGET, M_LABELS, safeCodexCompletion } from '../helpers/codex/live-harness.ts';
import type { Checks, MLabel } from '../helpers/codex/live-harness.ts';
import { cleanCompletion, deferred, processResult } from '../helpers/codex/process-double.ts';

const SECRET = 'SYNTHETIC-SECRET-NOT-FOR-EVIDENCE';
const phases = [['--version'], ['exec', '--help'], ['exec', 'resume', '--help'], ['login', 'status'], ['exec', '--json', '-']];
const manifest = (): ProcessRequest[] => phases.map(args => ({ executable: '/synthetic/codex', args,
  cwd: '/synthetic/workspace', env: { HOME: '/synthetic/home', PATH: '/synthetic/bin' },
  stdin: args.at(-1) === '-' ? SECRET : '', timeoutMs: 90_000, stopGraceMs: 2_000, drainTimeoutMs: 2_000, maxQueueBytes: 1_048_576 }));
const positive: Checks = { read: 'passed', thread: 'passed', history: 'passed', instruction: 'passed',
  memory: 'passed', allowedRead: 'passed', forbiddenEffectAbsent: 'passed', toolPolicy: 'passed', extensionPolicy: 'passed' };
const limitations = 'os_isolation_not_attested,network_not_restricted,detached_children_not_guaranteed,cli_configuration_not_audited';
async function* bytes(value = '') { if (value) yield Buffer.from(value); }
const event = (payload: NormalizedPayload, seq: number): AgentEvent => ({
  schemaVersion: 1, eventId: String(seq), sessionId: 'synthetic-session', turnId: 'synthetic-turn',
  participantId: 'synthetic-codex', seq, timestamp: new Date(0).toISOString(), ...payload,
});
const finished = (patch: Partial<AgentRunCompletion> = {}): AgentRunCompletion =>
  ({ kind: 'success', stopAccepted: false, completion: cleanCompletion(), ...patch }) as AgentRunCompletion;
function processStub(patch: Partial<ProcessRun> = {}): ProcessRun {
  return { stdout: bytes(), stderr: bytes(), done: Promise.resolve(processResult()),
    interrupt: vi.fn(async () => {}), kill: vi.fn(async () => {}), ...patch };
}
type Harness = ReturnType<typeof createCodexLiveHarness>;

/** Портовая подстановка: никакой CLI/модели, все утверждения inspector явно synthetic. */
function syntheticAgent(harness: Harness, label: MLabel, expected = manifest(), options: {
  duplicate?: boolean;
  mismatch?: boolean;
  text?: string;
  inspectRun?: (run: AgentRun) => void;
} = {}): () => Promise<AgentRun> {
  return async () => {
    const negative = label.startsWith('M3-');
    let stopped = false;
    const done = deferred<AgentRunCompletion>();
    const run: AgentRun = {
      diagnostics: negative ? [] : [{ code: 'codex_limitations', detail: limitations }],
      interrupt: vi.fn(async () => { stopped = true; }),
      kill: vi.fn(async () => {}),
      done: done.promise,
      events: {
        async *[Symbol.asyncIterator]() {
          for (const request of negative ? [] : expected) {
            const child = harness.runner.start(request);
            await Promise.all([
              (async () => { for await (const chunk of child.stdout) void chunk; })(),
              (async () => { for await (const chunk of child.stderr) void chunk; })(),
              child.done,
            ]);
          }
          let seq = 0;
          if (!negative) {
            yield event({ type: 'run_started', agentSessionId: '019a0000-0000-7000-8000-000000000001' }, ++seq);
            if (label === 'M5') expect(stopped).toBe(false);
            yield event({ type: 'text', messageId: 'm', mode: 'delta', text: options.text ?? SECRET }, ++seq);
            yield event({ type: 'text', messageId: 'm', mode: 'snapshot', text: options.text ?? SECRET }, ++seq);
          }
          const result: AgentRunCompletion = negative
            ? { kind: 'error', reason: 'invalid_request', detail: SECRET, stopAccepted: false,
              completion: cleanCompletion({ process: { state: 'not_started' }, stdout: 'not_started', stderr: 'not_started' }) }
            : finished(stopped ? { kind: 'interrupted', stopAccepted: true } : {});
          yield event({ type: 'run_finished', result }, ++seq);
          if (options.duplicate) yield event({ type: 'run_finished', result }, ++seq);
          done.resolve(options.mismatch ? finished({ kind: 'interrupted' }) : result);
        },
      },
    };
    options.inspectRun?.(run);
    return run;
  };
}
function setup(make: (request: ProcessRequest) => ProcessRun = () => processStub()) {
  const start = vi.fn(make);
  const harness = createCodexLiveHarness({ runner: { start }, scenarioTimeoutMs: 200, cleanupTimeoutMs: 10, stopTimeoutMs: 10 });
  const scenario = (label: MLabel = 'M1', overrides: Partial<Parameters<Harness['runScenario']>[0]> = {}) =>
    harness.runScenario({ label, expected: label.startsWith('M3-') ? [] : manifest(),
      start: syntheticAgent(harness, label), inspect: () => positive, ...overrides });
  return { start, harness, scenario };
}

describe('Codex M: независимый надзор, только synthetic', () => {
  it('импорт/создание не запускают процессов; запуск вне сценария запрещён', () => {
    const { harness, start } = setup();
    expect(start).not.toHaveBeenCalled();
    expect(() => harness.runner.start(manifest()[0]!)).toThrow();
    expect(start).not.toHaveBeenCalled();
  });

  it('полный маршрут учитывает 16 диагностик и 4 модели; M3 не создаёт процессов', async () => {
    const { harness, scenario, start } = setup();
    for (const label of M_LABELS) {
      const report = await scenario(label);
      expect(report.outcome, JSON.stringify(report)).toBe('passed');
      expect(report.terminalCount).toBe(1);
      expect(report.cleanup.safeToRemove).toBe(true);
      expect(report.models).toBe(label.startsWith('M3-') ? 0 : 1);
    }
    expect(start).toHaveBeenCalledTimes(M_BUDGET.processes);
    expect(harness.processes.filter(p => p.phase === 'model')).toHaveLength(4);
    expect(harness.processes.filter(p => p.phase !== 'model')).toHaveLength(16);
    expect(JSON.stringify({ reports: harness.reports, processes: harness.processes })).not.toContain(SECRET);
    expect(JSON.stringify(harness.processes)).not.toContain('/synthetic/');
    await expect(scenario('M1')).rejects.toThrow('порядок');
    expect(start).toHaveBeenCalledTimes(20);
  });

  it('не принимает manifest, который считает только модель и забывает detect', async () => {
    const { scenario, start } = setup();
    await expect(scenario('M1', { expected: manifest().slice(-1) })).rejects.toThrow('четыре диагностики');
    expect(start).not.toHaveBeenCalled();
  });

  it.each([
    (r: ProcessRequest) => ({ ...r, executable: '/foreign/codex' }),
    (r: ProcessRequest) => ({ ...r, args: ['login', 'status'] }),
    (r: ProcessRequest) => ({ ...r, cwd: '/foreign' }),
    (r: ProcessRequest) => ({ ...r, env: { ...r.env, NODE_OPTIONS: SECRET } }),
    (r: ProcessRequest) => ({ ...r, env: { ...r.env, HOME: '/foreign' } }),
    (r: ProcessRequest) => ({ ...r, timeoutMs: undefined }),
    (r: ProcessRequest) => ({ ...r, stdin: SECRET }),
  ])('изменение argv/env/cwd/deadline отклонено до запуска', async mutate => {
    const { scenario, start, harness } = setup();
    const altered = manifest(); altered[0] = mutate(altered[0]!);
    const report = await scenario('M1', { start: syntheticAgent(harness, 'M1', altered) });
    expect(report.outcome).toBe('failed');
    expect(start).not.toHaveBeenCalled();
    expect(harness.halted).toBe(true);
  });

  it.each([{ duplicate: true }, { mismatch: true }])('terminal/done не могут расходиться: %j', async options => {
    const { scenario, harness } = setup();
    const report = await scenario('M1', { start: syntheticAgent(harness, 'M1', manifest(), options) });
    expect(report.checks.terminal).toBe('failed');
    expect(report.outcome).toBe('failed');
    expect((await scenario('M2')).execution).toBe('not_started');
  });

  it('не удваивает текст snapshot после delta; inspector не видит дубликат', async () => {
    const { scenario } = setup();
    const inspect = vi.fn(observed => { expect(observed.text).toBe(SECRET); return positive; });
    expect((await scenario('M1', { inspect })).outcome).toBe('passed');
    expect(inspect).toHaveBeenCalledOnce();
  });

  it('неизвестный обязательный критерий не становится passed и блокирует M2', async () => {
    const { scenario, start } = setup();
    const report = await scenario('M1', { inspect: () => ({ ...positive, instruction: 'unconfirmed' }) });
    expect(report.outcome).toBe('unconfirmed');
    expect(report.reason).toBe('required_unconfirmed');
    expect((await scenario('M2')).execution).toBe('not_started');
    expect(start).toHaveBeenCalledTimes(5);
  });

  it('нет чтения/контекста в argv: строковая передача не заменяет наблюдение', async () => {
    const { scenario } = setup();
    const report = await scenario('M1', { inspect: () => ({ thread: 'passed', history: 'passed' }) });
    expect(report.checks.instruction).toBe('unconfirmed');
    expect(report.checks.read).toBe('unconfirmed');
    expect(report.outcome).toBe('unconfirmed');
  });

  it.each([
    cleanCompletion({ stdout: 'forced_closed' }),
    cleanCompletion({ process: { state: 'unconfirmed' } }),
    cleanCompletion({ process: { state: 'exited', exitCode: 1, signal: null } }),
    cleanCompletion({ issues: [{ code: 'signal_failed', operation: 'kill', detail: SECRET }] }),
  ])('ошибка завершения первой диагностики запрещает следующую', async completion => {
    const { scenario, start } = setup(() => processStub({ done: Promise.resolve(processResult(completion)) }));
    const report = await scenario();
    expect(report.outcome).toBe('failed');
    expect(start).toHaveBeenCalledTimes(1);
    expect(report.cleanup.safeToRemove).toBe(false);
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

  it('rejected done не означает exit и не разрешает очистку стенда', async () => {
    const { scenario, harness } = setup(() => processStub({ done: Promise.reject(new Error(SECRET)) }));
    const report = await scenario();
    expect(report.cleanup.safeToRemove).toBe(false);
    expect(harness.processes[0]?.completion).toBeNull();
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

  it('ошибка фабрики с неизвестным handle сохраняет неопределённость cleanup', async () => {
    const { scenario } = setup(() => { throw new Error(SECRET); });
    const report = await scenario();
    expect(report.cleanup).toMatchObject({ safeToRemove: false, lostHandle: true });
    expect(report.diagnostics).toBe(1);
    expect(report.outcome).toBe('failed');
  });

  it('переполнение stdout останавливает процесс и не продолжает диагностики', async () => {
    const kill = vi.fn(async () => {});
    const { scenario, start } = setup(() => processStub({ stdout: bytes('x'.repeat(M_BUDGET.diagnosticBytes + 1)), kill }));
    const report = await scenario();
    expect(report.outcome).toBe('failed');
    expect(start).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalled();
  });

  it('зависший start имеет конечное ожидание и не разрешает удаление корня', async () => {
    const start = deferred<AgentRun>();
    const harness = createCodexLiveHarness({ runner: { start: () => processStub() }, scenarioTimeoutMs: 10, cleanupTimeoutMs: 10 });
    const report = await harness.runScenario({ label: 'M1', expected: manifest(), start: () => start.promise, inspect: () => positive });
    expect(report.reason).toBe('scenario_timeout');
    expect(report.cleanup).toMatchObject({ safeToRemove: false, pendingStarts: 1 });
    const late = { done: Promise.resolve(finished()), events: { async *[Symbol.asyncIterator]() {} },
      diagnostics: [], interrupt: vi.fn(async () => {}), kill: vi.fn(async () => {}) };
    start.resolve(late);
    await Promise.resolve(); await Promise.resolve();
    expect(late.kill).toHaveBeenCalled();
    expect(() => harness.runner.start(manifest()[0]!)).toThrow();
  });

  it('ошибка Stop не теряется за success done процесса', async () => {
    const { scenario, harness } = setup();
    for (const label of M_LABELS.slice(0, -1)) expect((await scenario(label)).outcome).toBe('passed');
    const report = await scenario('M5', { start: syntheticAgent(harness, 'M5', manifest(), {
      inspectRun: run => { run.interrupt = async () => { throw new Error(SECRET); }; },
    }) });
    expect(report.outcome).toBe('failed');
    expect(report.cleanup.stopFailures).toBeGreaterThan(0);
    expect(report.cleanup.safeToRemove).toBe(false);
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

  it('исключение inspector сохраняет lifecycle и безопасный отчёт', async () => {
    const { scenario } = setup();
    const report = await scenario('M1', { inspect: () => { throw new Error(SECRET); } });
    expect(report.reason).toBe('scenario_failed');
    expect(report.completion?.process.state).toBe('exited');
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

  it('безопасная проекция не экспортирует произвольные коды/детали', () => {
    const completion = cleanCompletion({ issues: [{ code: SECRET, operation: SECRET, detail: SECRET, errorCode: SECRET }] as unknown as ProcessCompletion['issues'] });
    expect(JSON.stringify(safeCodexCompletion(completion))).not.toContain(SECRET);
    expect(safeCodexCompletion(completion).issues).toEqual([{ code: 'unknown', operation: 'unknown' }]);
  });

  it('сохранённый report не меняется через возвращённую ссылку', async () => {
    const { scenario, harness } = setup();
    const report = await scenario();
    report.checks.instruction = 'failed';
    expect(harness.reports[0]!.checks.instruction).toBe('passed');
  });
});
