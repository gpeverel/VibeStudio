import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as admission from '../../src/adapters/claude/admission.ts';
import type { AdmissionProbes, ClaudeAdmissionFacts, ClaudeFactCollector } from '../../src/adapters/claude/admission.ts';
import { createClaudeAdapter } from '../../src/adapters/claude/index.ts';
import type { PracticalAdmission, PracticalAdmissionContext } from '../../src/adapters/claude/profile.ts';
import type { AgentEvent, AgentRun, ProcessCompletion } from '../../src/core/ports/agent.ts';
import type { ProcessRequest, ProcessResult, ProcessRun } from '../../src/core/ports/process-runner.ts';
import { jsonLines, syntheticContext, syntheticExpectation, syntheticFacts, syntheticInit, syntheticKnown, syntheticResult } from '../helpers/claude/practical-evidence.ts';

const createProductionAdmission = admission.createClaudeAdmission;
const directories: string[] = [];
afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks();
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});
function probes(overrides: Partial<AdmissionProbes> = {}): AdmissionProbes {
  return {
    stat: async () => ({ size: 1234, mtimeMs: 1000, isFile: true }),
    ...overrides,
  };
}
const assess = (context = syntheticContext(), facts = syntheticFacts(context)) => admission.assessPracticalFacts(context, facts);

describe('P2b: production-алгоритм над явно synthetic фактами', () => {
  it('достаточные факты дают привязанный ready с независимым ожиданием, без strict verified', () => {
    const context = syntheticContext();
    const result = assess(context);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('Не получен synthetic ready');
    expect(result.expectedInventory).toEqual(syntheticExpectation());
    expect(result.contextFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.detail).toContain('synthetic');
    expect(result.limitations).toEqual(['no_os_sandbox', 'no_provider_only_network', 'detached_children_not_guaranteed', 'cli_configuration_not_audited']);
    expect(result).not.toHaveProperty('evidence'); expect(result).not.toHaveProperty('launch');
    expect(context.detection.capabilities.readOnly).toBe('unverified');
  });

  it.each(['2.1.294', '2.1.296', '2.2.0', '3.0.0', '2.1.295-SECRET-version', 'unknown'])('непроверенная версия %s — unsupported', version => {
    const context = syntheticContext(); context.detection.version = version;
    const result = assess(context);
    expect(result).toMatchObject({ status: 'unsupported', reason: 'cli_unsupported' });
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it.each(['binaryPath', 'version'] as const)('отсутствующий %s не становится готовностью', key => {
    const context = syntheticContext(); context.detection[key] = null;
    expect(assess(context)).toMatchObject({ status: 'blocked', reason: 'prerequisite_unknown' });
  });

  it.each(['unknown', 'unauthenticated'] as const)('auth=%s не считается authenticated', auth => {
    const context = syntheticContext(); context.detection.auth = auth;
    expect(assess(context)).toMatchObject({ status: 'blocked', reason: 'prerequisite_unknown' });
  });

  it.each(['streamJson', 'partialMessages', 'sessionId', 'restricted', 'safeMode', 'tools', 'settingSources', 'strictMcpConfig', 'permissionPrompts'] as const)('отсутствующая возможность %s — unsupported', capability => {
      const context = syntheticContext(); context.detection.capabilities[capability] = false;
      expect(assess(context)).toMatchObject({ status: 'unsupported', reason: 'cli_unsupported' });
    });

  it.each([undefined, null, {}, { executable: {} }, { executable: { state: 'known', value: {} } }])('неполные facts %j не дают ready', raw => {
    expect(admission.assessPracticalFacts(syntheticContext(), raw as ClaudeAdmissionFacts)).toMatchObject({ status: 'blocked', reason: 'assessment_failed' });
  });

  it.each([
    ['нет managed', undefined], ['нет value', { state: 'known', provenance: 'synthetic' }],
    ['нет provenance', { state: 'known', value: { observed: ['file', 'os-policy', 'server-managed'] } }],
    ['неизвестный provenance', { state: 'known', provenance: 'SECRET', value: {} }],
    ['только названия источников', syntheticKnown({ observed: ['file', 'os-policy', 'server-managed'] })],
    ['пустой объект вместо данных', syntheticKnown({})], ['неизвестная причина', { state: 'unknown', reason: 'SECRET-managed' }],
  ])('%s — неполные данные, не known empty', (_label, managed) => {
    const context = syntheticContext();
    const result = assess(context, { ...syntheticFacts(context), managed } as ClaudeAdmissionFacts);
    expect(result).toMatchObject({ status: 'blocked', reason: 'assessment_failed' });
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it.each([[], ['file'], ['file', 'os-policy'], ['file', 'server-managed']].map(observed => ({ observed })))('частичное наблюдение $observed не требует полного аудита', ({ observed }) => {
    const context = syntheticContext(); const facts = syntheticFacts(context);
    if (facts.managed.state !== 'known') throw new Error('Нужны synthetic данные');
    const result = assess(context, { ...facts, managed: syntheticKnown({ ...facts.managed.value, observed } as typeof facts.managed.value) });
    expect(result.status).toBe('ready');
    expect(result.limitations).toContain('cli_configuration_not_audited');
  });

  it.each(['unobservable', 'unreadable'] as const)('managed %s допускается без превращения в known empty', reason => {
    const context = syntheticContext();
    const facts: ClaudeAdmissionFacts = { ...syntheticFacts(context), managed: { state: 'unknown', reason } };
    const before = structuredClone(facts);
    const result = assess(context, facts);
    expect(result.status).toBe('ready');
    expect(result.limitations).toContain('cli_configuration_not_audited');
    expect(result.detail).toContain('полностью не проверяется');
    expect(facts).toEqual(before);
    expect(facts.managed).not.toHaveProperty('value');
  });

  it.each([
    { state: 'unknown', reason: 'executable_config' },
    { state: 'conflict', reason: 'unobservable' },
    { state: 'conflict', reason: 'unreadable' },
  ])('несовместимые managed state/reason $state/$reason не обходят отказ', managed => {
    const context = syntheticContext();
    expect(assess(context, { ...syntheticFacts(context), managed } as ClaudeAdmissionFacts))
      .toMatchObject({ status: 'blocked', reason: 'assessment_failed' });
  });

  it('явный конфликт обязательной политики блокирует, детали берутся из закрытого словаря', () => {
    const context = syntheticContext();
    const result = assess(context, { ...syntheticFacts(context), managed: {
      state: 'conflict', reason: 'executable_config', items: ['managed-settings.hooks', 'SECRET-token'],
    } });
    expect(result).toMatchObject({ status: 'blocked', reason: 'configuration_conflict' });
    expect(result.detail).toContain('managed-settings.hooks');
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it.each(['unknown-source', 'duplicate-source', 'negative-size', 'nonfinite-size'] as const)('повреждённое наблюдение %s не даёт ready', kind => {
    const context = syntheticContext(); const facts = syntheticFacts(context);
    if (facts.managed.state !== 'known' || facts.executable.state !== 'known') throw new Error('Нужны synthetic данные');
    const raw = kind === 'unknown-source' || kind === 'duplicate-source'
      ? { ...facts, managed: syntheticKnown({ ...facts.managed.value,
        observed: [...facts.managed.value.observed, kind === 'unknown-source' ? 'SECRET-source' : 'file'] }) }
      : { ...facts, executable: syntheticKnown({ ...facts.executable.value, size: kind === 'negative-size' ? -1 : Infinity }) };
    const result = assess(context, raw as ClaudeAdmissionFacts);
    expect(result.status).toBe('blocked');
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('sparse managed sources не скрывают пропущенный элемент после полного перечня', () => {
    const context = syntheticContext(); const facts = syntheticFacts(context);
    if (facts.managed.state !== 'known') throw new Error('Нужны synthetic данные');
    const observed = [...facts.managed.value.observed];
    observed.length += 1;
    expect(assess(context, { ...facts, managed: syntheticKnown({ ...facts.managed.value, observed }) }))
      .toMatchObject({ status: 'blocked', reason: 'assessment_failed' });
  });

  it.each(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'SECRET_UNALLOWED_ENV'])('%s не подменяет штатный auth и не раскрывает значение', name => {
    const context = syntheticContext();
    const result = assess({ ...context, env: { ...context.env, [name]: 'SECRET-credential' } });
    expect(result).toMatchObject({ status: 'blocked', reason: 'configuration_conflict' });
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('HOME, PATH и CLAUDE_CONFIG_DIR сохраняются; helpers не превращаются в Bash permission', () => {
    const context = syntheticContext();
    const env = { ...context.env, CLAUDE_CONFIG_DIR: '/tmp/synthetic-config' };
    const before = structuredClone(env);
    expect(assess({ ...context, env }).status).toBe('ready');
    expect(env).toEqual(before);
    expect(context.args).not.toContain('--bare'); expect(context.args).not.toContain('--settings');
    expect(context.args[context.args.indexOf('--tools') + 1]).toBe('Read,Glob,Grep');
    expect(Object.keys(env)).not.toContain('ANTHROPIC_API_KEY');
  });

  it.each([
    ['--tools', 'Read,Bash'], ['--allowedTools', 'Bash'], ['--mcp-config', '{"mcpServers":{"SECRET":{}}}'],
    ['--setting-sources', 'project'], ['--permission-mode', 'bypassPermissions'], ['--disallowedTools', ''],
  ])('изменение %s блокируется без расширения прав', (flag, value) => {
    const context = syntheticContext(); const args = [...context.args];
    const at = args.indexOf(flag); if (at < 0) args.push(flag, value); else args[at + 1] = value;
    const result = assess({ ...context, args });
    expect(result).toMatchObject({ status: 'blocked', reason: 'configuration_conflict' });
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it.each([['--bare'], ['--plugin-dir', '/SECRET/plugin'], ['--settings', '/SECRET/settings'], ['--tools', 'Read']].map(suffix => ({ suffix })))('дополнительные/повторные argv $suffix не принимаются', ({ suffix }) => {
    const context = syntheticContext();
    const result = assess({ ...context, args: [...context.args, ...suffix] });
    expect(result.status).toBe('blocked'); expect(JSON.stringify(result)).not.toContain('SECRET');
  });
});

describe('P2b: production-сборщик доверяет штатной конфигурации CLI', () => {
  it('собирает только identity executable, не обращается к конфигурации или credentials', async () => {
    const context = syntheticContext();
    const stat = vi.fn(async (path: string) => {
      if (path !== context.detection.binaryPath) throw new Error('SECRET-unexpected-path');
      return { size: 1234, mtimeMs: 1000, isFile: true };
    });
    const io = { stat, get readFile(): never { throw new Error('SECRET-config-access'); } };
    const facts = await admission.collectClaudeFacts(context, io);
    expect(stat).toHaveBeenCalledExactlyOnceWith(context.detection.binaryPath);
    expect(facts.managed).toEqual({ state: 'unknown', reason: 'unobservable' });
    expect(assess(context, facts)).toMatchObject({ status: 'ready', limitations: expect.arrayContaining(['cli_configuration_not_audited']) });
    expect(JSON.stringify([facts, assess(context, facts)])).not.toContain('SECRET');
  });

  it('production stat собственного файла даёт ready с unknown без запуска executable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vs-p2b-data-')); directories.push(dir);
    const bin = join(dir, 'never-executed');
    writeFileSync(bin, 'synthetic executable identity only');
    const context = syntheticContext(dir, bin);
    const facts = await admission.collectClaudeFacts(context);
    expect(facts.executable).toMatchObject({ state: 'known', value: { path: bin, size: 34 } });
    expect(facts.managed).toEqual({ state: 'unknown', reason: 'unobservable' });
    expect(assess(context, facts).status).toBe('ready');
    const evaluator = createProductionAdmission();
    const first = await evaluator.assess(context);
    if (first.status !== 'ready') throw new Error('Не получен допуск тестового контекста');
    expect(await evaluator.recheck(context, first.contextFingerprint)).toBe(true);
    writeFileSync(bin, 'different synthetic executable contents');
    expect(statSync(bin).size).not.toBe(34);
    expect(await evaluator.recheck(context, first.contextFingerprint)).toBe(false);
  });

  it.each([false, 'unreadable'] as const)('исполняемый файл %s не даёт ready', async kind => {
    const context = syntheticContext();
    const facts = await admission.collectClaudeFacts(context, probes({ stat: async () => {
      if (kind === 'unreadable') throw new Error('SECRET-stat');
      return { isFile: false, size: 0, mtimeMs: 0 };
    } }));
    expect(assess(context, facts).status).toBe('blocked');
    expect(JSON.stringify([facts, assess(context, facts)])).not.toContain('SECRET');
  });

  it('исключение сборщика — assessment_failed без секрета', async () => {
    const evaluator = createProductionAdmission({ collect: async () => { throw new Error('SECRET-collector'); } });
    const result = await evaluator.assess(syntheticContext());
    expect(result).toMatchObject({ status: 'blocked', reason: 'assessment_failed' });
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });
});

describe('P2b: привязка допуска и повторная проверка контекста', () => {
  it.each(['HOME', 'PATH', 'CLAUDE_CONFIG_DIR'] as const)('изменение значения %s при прежних именах env меняет fingerprint', key => {
    const context = syntheticContext(); const facts = syntheticFacts(context);
    const a = { ...context, env: { ...context.env, [key]: '/tmp/first' } };
    const b = { ...context, env: { ...a.env, [key]: '/tmp/second' } };
    expect(admission.computeAdmissionFingerprint(a, facts)).not.toBe(admission.computeAdmissionFingerprint(b, facts));
  });

  it.each(['executable', 'version', 'cwd', 'profile', 'argv', 'configuration'] as const)('%s: существенная смена не переиспользует положительный recheck', async changed => {
    const initial = syntheticContext(); const initialFacts = syntheticFacts(initial);
    let facts = initialFacts;
    const evaluator = createProductionAdmission({ collect: async () => facts });
    const first = await evaluator.assess(initial);
    if (first.status !== 'ready') throw new Error('Не получен исходный synthetic ready');
    expect(await evaluator.recheck(initial, first.contextFingerprint)).toBe(true);
    const next = structuredClone(initial);
    if (changed === 'version') next.detection.version = '2.1.296';
    if (changed === 'cwd') next.request.cwd = '/tmp/other-workspace';
    if (changed === 'profile') (next.request.profile.deny as string[]).push('Read');
    if (changed === 'argv') (next.args as string[]).push('--bare');
    if (changed === 'executable' && facts.executable.state === 'known') facts = { ...facts, executable: syntheticKnown({ ...facts.executable.value, mtimeMs: 2000 }) };
    if (changed === 'configuration' && facts.managed.state === 'known') facts = { ...facts, managed: syntheticKnown({ ...facts.managed.value, policyDigest: 'a'.repeat(64) }) };
    expect(await evaluator.recheck(next, first.contextFingerprint)).toBe(false);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function completion(): ProcessCompletion {
  return { process: { state: 'exited', exitCode: 0, signal: null }, stdout: 'ended', stderr: 'ended',
    wait: 'settled', issues: [], signals: [], descendants: 'not_guaranteed' };
}
function processDouble(stdout = jsonLines(syntheticInit(), syntheticResult()), patch: Partial<ProcessRun> = {}): ProcessRun {
  return {
    stdout: (async function* () { yield stdout; })(), stderr: (async function* () {})(),
    done: Promise.resolve({ exitCode: 0, signal: null, completion: completion() }),
    interrupt: vi.fn(async () => {}), kill: vi.fn(async () => {}), ...patch,
  };
}
async function outcome(run: AgentRun) {
  const events: AgentEvent[] = []; for await (const event of run.events) events.push(event);
  const result = await run.done;
  const terminals = events.filter(e => e.type === 'run_finished');
  expect(terminals).toHaveLength(1);
  expect(terminals[0]!.result).toBe(result);
  expect(events.at(-1)?.type).toBe('run_finished');
  return { result, events };
}

/** Меняется только сбор фактов; factory, алгоритм, recheck и интеграция production остаются настоящими. */
function integrated(collect: ClaudeFactCollector = context => admission.collectClaudeFacts(context, probes()), processRun = processDouble()) {
  vi.spyOn(admission, 'createClaudeAdmission').mockImplementation(() => createProductionAdmission({ collect }));
  const context = syntheticContext();
  const start = vi.fn<(request: ProcessRequest) => ProcessRun>(() => processRun);
  const adapter = createClaudeAdapter({ runner: { start }, detect: async () => context.detection,
    env: context.env, timeoutMs: 100, stopGraceMs: 10, drainTimeoutMs: 20 });
  return { context, start, adapter, processRun };
}

describe('P2b: production-интеграция и сохранение lifecycle P2a на doubles', () => {
  it('production-сборщик допускает unknown, явно сообщает предел и сохраняет init/completion проверки', async () => {
    const collect = vi.fn((context: PracticalAdmissionContext) => admission.collectClaudeFacts(context, probes()));
    const h = integrated(collect);
    const run = await h.adapter.start(h.context.request);
    const { result } = await outcome(run);
    expect(result).toMatchObject({ kind: 'success', stopAccepted: false, completion: completion() });
    expect(collect).toHaveBeenCalledTimes(2);
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(run.diagnostics.find(item => item.code === 'practical_limitations')?.detail).toContain('cli_configuration_not_audited');
  });

  it('конкретный конфликт после первоначального unknown останавливает recheck до prompt', async () => {
    let calls = 0;
    const h = integrated(async context => ({ ...syntheticFacts(context), managed: ++calls === 1
      ? { state: 'unknown', reason: 'unobservable' }
      : { state: 'conflict', reason: 'executable_config', items: ['managed-settings.permissions'] } }));
    const { result } = await outcome(await h.adapter.start(h.context.request));
    expect(result).toMatchObject({ kind: 'error', reason: 'practical_admission_blocked' });
    expect(result.kind === 'error' && result.detail).toContain('context_changed');
    expect(h.start).not.toHaveBeenCalled();
  });

  it('production-положительная ветвь на synthetic facts проверяет init и чистый completion', async () => {
    const collect = vi.fn(async (context: PracticalAdmissionContext) => syntheticFacts(context));
    const h = integrated(collect);
    const { result } = await outcome(await h.adapter.start(h.context.request));
    expect(result).toMatchObject({ kind: 'success', stopAccepted: false, completion: completion() });
    expect(collect).toHaveBeenCalledTimes(2); expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.start.mock.calls[0]![0].env.HOME).toBe(h.context.env.HOME);
  });

  it('конфигурация между assess и recheck меняется: prompt не запускается', async () => {
    let calls = 0;
    const h = integrated(async context => {
      const facts = syntheticFacts(context);
      if (++calls > 1 && facts.managed.state === 'known') return { ...facts, managed: syntheticKnown({ ...facts.managed.value, policyDigest: 'b'.repeat(64) }) };
      return facts;
    });
    const { result } = await outcome(await h.adapter.start(h.context.request));
    expect(result).toMatchObject({ kind: 'error', reason: 'practical_admission_blocked' });
    expect(result.kind === 'error' && result.detail).toContain('context_changed');
    expect(h.start).not.toHaveBeenCalled();
  });

  it.each([1, 2])('Stop во время асинхронного сбора №%s запрещает поздний prompt', async pauseAt => {
    const entered = deferred<PracticalAdmissionContext>(); const pending = deferred<ClaudeAdmissionFacts>(); let calls = 0;
    const h = integrated(async context => {
      if (++calls === pauseAt) { entered.resolve(context); return pending.promise; }
      return { ...syntheticFacts(context), managed: { state: 'unknown', reason: 'unobservable' } };
    });
    const run = await h.adapter.start(h.context.request);
    const context = await entered.promise;
    const stopping = run.interrupt(); pending.resolve({ ...syntheticFacts(context), managed: { state: 'unknown', reason: 'unobservable' } }); await stopping;
    const { result } = await outcome(run);
    expect(result).toMatchObject({ kind: 'interrupted', stopAccepted: true, completion: { process: { state: 'not_started' } } });
    expect(h.start).not.toHaveBeenCalled();
  });

  it('init+поздний result одним chunk: внутренняя остановка не становится пользовательским Stop', async () => {
    const processRun = processDouble(jsonLines(syntheticInit({ tools: ['Read', 'Bash'] }), syntheticResult()));
    const h = integrated(undefined, processRun);
    const { result, events } = await outcome(await h.adapter.start(h.context.request));
    expect(result).toMatchObject({ kind: 'error', reason: 'runtime_inventory_mismatch', stopAccepted: false });
    expect(processRun.kill).toHaveBeenCalled();
    expect(events.filter(e => e.type === 'text')).toEqual([]);
  });

  it('расхождение init без LF обнаруживается на end и запускает доступную внутреннюю остановку', async () => {
    const processRun = processDouble(Buffer.from(JSON.stringify(syntheticInit({ tools: ['Bash'] }))));
    const h = integrated(undefined, processRun);
    const { result } = await outcome(await h.adapter.start(h.context.request));
    expect(result).toMatchObject({ kind: 'error', reason: 'runtime_inventory_mismatch', stopAccepted: false });
    expect(processRun.kill).toHaveBeenCalled();
  });

  it('отказ init сохраняет ошибку kill, deadline, неподтверждённый exit и неизменный terminal', async () => {
    vi.useFakeTimers();
    const late = deferred<ProcessResult>();
    const processRun = processDouble(jsonLines(syntheticInit({ tools: ['Bash'] }), syntheticResult()), {
      done: late.promise,
      kill: vi.fn(async () => { throw Object.assign(new Error('SECRET-signal-failure'), { code: 'EPERM' }); }),
    });
    const h = integrated(undefined, processRun);
    const run = await h.adapter.start(h.context.request); const all = outcome(run);
    await vi.advanceTimersByTimeAsync(200);
    const { result, events } = await all;
    expect(result).toMatchObject({ kind: 'error', reason: 'runtime_inventory_mismatch', stopAccepted: false,
      completion: { process: { state: 'unconfirmed' }, wait: 'deadline', descendants: 'not_guaranteed' } });
    expect(result.completion.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'signal_failed', operation: 'kill', errorCode: 'EPERM' }),
      expect.objectContaining({ code: 'exit_unconfirmed' }), expect.objectContaining({ code: 'timeout' }),
    ]));
    expect(JSON.stringify([events, result, run.diagnostics])).not.toContain('SECRET');
    late.resolve({ exitCode: 0, signal: null, completion: completion() });
    await vi.advanceTimersByTimeAsync(100);
    expect(await run.done).toBe(result);
    expect(result.completion.process.state).toBe('unconfirmed');
  });

  it.each(['expectedInventory', 'contextFingerprint'] as const)('неполный ready без %s отклоняется и через override', async absent => {
    const context = syntheticContext(); const ready = assess(context);
    const broken = { ...ready } as Record<string, unknown>; delete broken[absent];
    const start = vi.fn(() => processDouble());
    const adapter = createClaudeAdapter({ runner: { start }, detect: async () => context.detection, env: context.env,
      assessPractical: async () => broken as PracticalAdmission });
    const { result } = await outcome(await adapter.start(context.request));
    expect(result).toMatchObject({ kind: 'error', reason: 'practical_admission_blocked' });
    expect(start).not.toHaveBeenCalled();
  });
});
