import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildClaudeArgs } from '../../src/adapters/claude/args.ts';
import { createClaudeAdapter } from '../../src/adapters/claude/index.ts';
import type { ClaudeAdapterOptions } from '../../src/adapters/claude/index.ts';
import { validateAccessProfile } from '../../src/adapters/claude/profile.ts';
import type { PracticalAdmission, PracticalAdmissionContext } from '../../src/adapters/claude/profile.ts';
import { createProcessRunner } from '../../src/adapters/process-runner/index.ts';
import type { AgentCapabilities, AgentDetection, AgentEvent, AgentRun, AgentRunRequest } from '../../src/core/ports/agent.ts';
import type { ProcessRequest } from '../../src/core/ports/process-runner.ts';
import { flagValue, legacyStrictProfile, legacyStrictRequest, practicalLocalReadProfile, practicalRequest, readOnlyProfile, request } from '../helpers/claude/requests.ts';
import { Stand } from '../helpers/claude/stand.ts';
import type { FakeScenario } from '../helpers/claude/stand.ts';

// P1: synthetic admission проверяет только маршрутизацию на двойнике CLI.
// Эти тесты не аттестуют настоящие CLI/auth/config и не заменяют приёмку P2b.
const SYNTHETIC_READY: PracticalAdmission = {
  status: 'ready', detail: 'synthetic: разрешение только тестов P1',
  limitations: ['no_os_sandbox', 'no_provider_only_network', 'detached_children_not_guaranteed'],
};
const CAPS: AgentCapabilities = {
  streamJson: true, partialMessages: true, sessionId: true, resume: true, noSessionPersistence: true, maxTurns: true,
  restricted: true, safeMode: true, tools: true, settingSources: true, strictMcpConfig: true, permissionPrompts: true,
  readOnly: 'unverified',
};
const SESSION = '11111111-1111-4111-8111-111111111111';
const fixture = (name: string): string => readFileSync(new URL('../fixtures/claude/' + name, import.meta.url), 'utf8');
const success = (): FakeScenario => ({ steps: [{ out: fixture('success-simple.jsonl') }] });
const stands: Stand[] = [];
afterEach(() => { vi.useRealTimers(); while (stands.length) stands.pop()?.cleanup(); });

function harness(options: Partial<ClaudeAdapterOptions> = {}, scenario = success(), detectionPatch: Partial<AgentDetection> = {}) {
  const s = new Stand();
  stands.push(s);
  const binaryPath = s.fakeClaude(scenario);
  const detection: AgentDetection = {
    status: 'available', binaryPath, version: '2.1.295', auth: 'authenticated',
    capabilities: { ...CAPS }, unavailable: [], ...detectionPatch,
  };
  const runner = createProcessRunner();
  const launch = vi.fn((input: ProcessRequest) => runner.start(input));
  const assess = vi.fn(async (): Promise<PracticalAdmission> => SYNTHETIC_READY);
  const verify = vi.fn(async () => { throw new Error('Practical не должен вызывать strict verifier'); });
  const detect = vi.fn(async () => detection);
  const adapter = createClaudeAdapter({
    runner: { start: launch }, detect, assessPractical: assess, verifyAccess: verify,
    env: { HOME: s.dir, PATH: '/usr/bin:/bin' }, timeoutMs: 5_000, stopGraceMs: 100, drainTimeoutMs: 300,
    ...options,
  });
  const req = (patch: Partial<AgentRunRequest> = {}): AgentRunRequest => practicalRequest(s.dir, {
    agentSessionId: SESSION, env: { HOME: s.dir }, ...patch,
  });
  return { s, detection, launch, assess, verify, detect, adapter, req };
}

async function outcome(run: AgentRun) {
  const events: AgentEvent[] = [];
  for await (const event of run.events) events.push(event);
  const result = await run.done;
  const terminal = events.filter(event => event.type === 'run_finished');
  expect(terminal).toHaveLength(1);
  expect(terminal[0]).toMatchObject({ result });
  expect(events.at(-1)?.type).toBe('run_finished');
  expect(result.completion.descendants).toBe('not_guaranteed');
  expect(typeof result.stopAccepted).toBe('boolean');
  if (result.kind === 'success') expect(result).toMatchObject({ stopAccepted: false, completion: {
    process: { state: 'exited', exitCode: 0, signal: null }, stdout: 'ended', stderr: 'ended', wait: 'settled', issues: [],
  } });
  return { events, result };
}

async function blocked(h: ReturnType<typeof harness>, req = h.req()) {
  const run = await h.adapter.start(req);
  const result = await outcome(run);
  expect(result.result.kind).toBe('error');
  expect(result.result.completion).toMatchObject({ process: { state: 'not_started' }, stdout: 'not_started', stderr: 'not_started', signals: [] });
  expect(h.launch).not.toHaveBeenCalled();
  expect(h.s.records().filter(record => record.probe === 'run')).toEqual([]);
  expect(result.events.some(event => event.type === 'run_started')).toBe(false);
  return { ...result, run };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('P1: legacy strict не получает практический допуск', () => {
  it('старые helpers сохраняют профиль без kind и строгие fs/network', () => {
    expect(readOnlyProfile('/tmp/p1')).toEqual(legacyStrictProfile('/tmp/p1'));
    expect(request('/tmp/p1')).toEqual(legacyStrictRequest('/tmp/p1'));
    expect(request('/tmp/p1').profile).not.toHaveProperty('kind');
    expect(request('/tmp/p1').profile).toHaveProperty('network', 'provider-only');
    expect(practicalRequest('/tmp/p1').profile).not.toHaveProperty('fs');
    expect(practicalRequest('/tmp/p1').profile).not.toHaveProperty('network');
  });

  it('available и synthetic practical-ready не разрешают strict без verifier', async () => {
    const h = harness({ verifyAccess: undefined });
    const { result } = await blocked(h, h.req({ profile: legacyStrictProfile(h.s.dir) }));
    expect(result).toMatchObject({ reason: 'profile_unverified' });
    expect(h.assess).not.toHaveBeenCalled();
    expect(h.detection.capabilities.readOnly).toBe('unverified');
  });

  it('strict verified/evidence без launch не переключается на runner или practical', async () => {
    const h = harness({ verifyAccess: async () => ({ status: 'verified', evidence: ['synthetic-unbound'], detail: 'нет launch' }) });
    const { result } = await blocked(h, h.req({ profile: legacyStrictProfile(h.s.dir) }));
    expect(result).toMatchObject({ reason: 'profile_unverified' });
    expect(h.assess).not.toHaveBeenCalled();
  });

  it('strict использует только связанный launch даже при наличии practical-ready', async () => {
    const boundLaunch = vi.fn(createProcessRunner().start);
    const h = harness({ verifyAccess: async () => ({ status: 'verified', evidence: ['synthetic-strict'], detail: 'synthetic', launch: boundLaunch }) });
    const { result } = await outcome(await h.adapter.start(h.req({ profile: legacyStrictProfile(h.s.dir) })));
    expect(result.kind).toBe('success');
    expect(boundLaunch).toHaveBeenCalledTimes(1);
    expect(h.launch).not.toHaveBeenCalled();
    expect(h.assess).not.toHaveBeenCalled();
  });
});

describe('P1: practical требует отдельную полную оценку', () => {
  it('нет assessPractical: явный недопуск, strict verifier не вызывается', async () => {
    const h = harness({ assessPractical: undefined });
    const { result, run } = await blocked(h);
    expect(result).toMatchObject({ reason: 'practical_admission_blocked' });
    expect(JSON.stringify([result, run.diagnostics])).toContain('assessment_missing');
    expect(h.verify).not.toHaveBeenCalled();
  });

  it.each(['project_untrusted', 'prerequisite_unknown', 'configuration_conflict'] as const)('blocked/%s запрещает prompt без fallback', async reason => {
    const h = harness({ assessPractical: async () => ({ ...SYNTHETIC_READY, status: 'blocked', reason, detail: 'synthetic: недопуск' }) });
    const { result, run } = await blocked(h);
    expect(result).toMatchObject({ reason: 'practical_admission_blocked' });
    expect(JSON.stringify([result, run.diagnostics])).toContain(reason);
    expect(h.verify).not.toHaveBeenCalled();
  });

  it('unsupported/cli_unsupported сохраняет отдельную причину', async () => {
    const h = harness({ assessPractical: async () => ({ ...SYNTHETIC_READY, status: 'unsupported', reason: 'cli_unsupported', detail: 'synthetic: несовместимость' }) });
    const { result, run } = await blocked(h);
    expect(result).toMatchObject({ reason: 'practical_admission_unsupported' });
    expect(JSON.stringify([result, run.diagnostics])).toContain('cli_unsupported');
    expect(h.verify).not.toHaveBeenCalled();
  });

  it.each([
    ['нет результата', undefined], ['null', null], ['пустой объект', {}],
    ['verified вместо ready', { status: 'verified', evidence: ['synthetic'] }],
    ['нет обязательных данных', { status: 'ready' }],
    ['пустое пояснение', { ...SYNTHETIC_READY, detail: '' }],
    ['нет ограничений', { status: 'ready', detail: 'synthetic', limitations: [] }],
    ['часть ограничений отсутствует', { status: 'ready', detail: 'synthetic', limitations: ['no_os_sandbox'] }],
    ['ограничение неизвестно', { status: 'ready', detail: 'synthetic', limitations: ['unknown'] }],
    ['ограничения дублируются', { ...SYNTHETIC_READY, limitations: [...SYNTHETIC_READY.limitations, 'no_os_sandbox'] }],
  ])('ошибочная runtime-оценка: %s', async (_name, admission) => {
    const h = harness({ assessPractical: async () => admission as PracticalAdmission });
    const { result } = await blocked(h);
    expect(result).toMatchObject({ reason: 'practical_admission_blocked' });
    expect(h.verify).not.toHaveBeenCalled();
  });

  it.each(['ready', 'blocked', 'unsupported'] as const)('%s с неизвестным ограничением не раскрывает его в диагностике', async status => {
    const admission = {
      ...SYNTHETIC_READY, status, reason: 'configuration_conflict',
      limitations: [...SYNTHETIC_READY.limitations, 'SECRET-unknown-limitation'],
    } as unknown as PracticalAdmission;
    const h = harness({ assessPractical: async () => admission });
    const { result, run } = await blocked(h);
    expect(result).toMatchObject({ reason: status === 'unsupported' ? 'practical_admission_unsupported' : 'practical_admission_blocked' });
    expect(JSON.stringify([result, run.diagnostics])).not.toContain('SECRET');
    const diagnostic = run.diagnostics.find(item => item.code === 'practical_limitations');
    expect(diagnostic?.detail.split(',').sort()).toEqual([
      'detached_children_not_guaranteed', 'no_os_sandbox', 'no_provider_only_network',
    ]);
  });

  it('исключение оценщика — assessment_failed, а не разрешение запуска', async () => {
    const h = harness({ assessPractical: async () => { throw new Error('SECRET-assessment-failure'); } });
    const { result, run } = await blocked(h);
    expect(result).toMatchObject({ reason: 'practical_admission_blocked' });
    expect(JSON.stringify([result, run.diagnostics])).toContain('assessment_failed');
    expect(JSON.stringify([result, run.diagnostics])).not.toContain('SECRET');
  });

  it('ready/verified из данных запроса не заменяют доверенную оценку', async () => {
    const h = harness({ assessPractical: undefined });
    const injected = { ...h.req(), admission: SYNTHETIC_READY, verified: true };
    const { result } = await blocked(h, injected);
    expect(result).toMatchObject({ reason: 'practical_admission_blocked' });
  });

  it('функция assessPractical внутри запроса отклоняется как invalid_request', async () => {
    const h = harness({ assessPractical: undefined });
    const injected = { ...h.req(), assessPractical: async () => SYNTHETIC_READY };
    const { result } = await blocked(h, injected);
    expect(result).toMatchObject({ reason: 'invalid_request' });
    expect(h.detect).not.toHaveBeenCalled();
  });
});

describe('P1: проверка practical-профиля и самостоятельные ошибки', () => {
  it.each([
    ['неизвестный kind', { kind: 'practical-local-v2' }], ['kind null', { kind: null }],
    ['нет явного kind', { kind: undefined }], ['нет доверия', { projectTrust: undefined }],
    ['проект недоверенный', { projectTrust: 'untrusted' }], ['другая область', { workspaceRoot: '/' }],
    ['не тот режим', { mode: 'workspace-write' }], ['Bash', { tools: ['Read', 'Bash'] }],
    ['Write', { tools: ['Write'] }], ['Agent', { tools: ['Read', 'Agent'] }],
    ['расширенный allow', { allow: ['Bash'] }], ['нет tools', { tools: undefined }],
    ['некорректный deny', { deny: [1] }], ['нет configPolicy', { configPolicy: undefined }],
    ['смешение со strict fs', { fs: {} }], ['смешение со strict network', { network: 'provider-only' }],
    ['общепроцессное обещание loadPlugins', { configPolicy: { settingSources: [], projectHooks: 'disabled', projectMcp: 'disabled', projectPlugins: 'disabled', loadPlugins: false } }],
    ['project settings', { configPolicy: { settingSources: ['project'], projectHooks: 'disabled', projectMcp: 'disabled', projectPlugins: 'disabled' } }],
    ['hooks включены', { configPolicy: { settingSources: [], projectHooks: 'enabled', projectMcp: 'disabled', projectPlugins: 'disabled' } }],
    ['MCP включены', { configPolicy: { settingSources: [], projectHooks: 'disabled', projectMcp: 'enabled', projectPlugins: 'disabled' } }],
    ['plugins включены', { configPolicy: { settingSources: [], projectHooks: 'disabled', projectMcp: 'disabled', projectPlugins: 'enabled' } }],
  ])('отказ до detect/оценки: %s', async (_name, patch) => {
    const h = harness();
    const profile = { ...practicalLocalReadProfile(h.s.dir), ...patch } as AgentRunRequest['profile'];
    expect(validateAccessProfile(profile, h.s.dir).length).toBeGreaterThan(0);
    const { result } = await blocked(h, h.req({ profile }));
    expect(result).toMatchObject({ reason: 'projectTrust' in patch ? 'practical_admission_blocked' : 'profile_unsupported' });
    expect(h.detect).not.toHaveBeenCalled();
    expect(h.assess).not.toHaveBeenCalled();
    expect(h.verify).not.toHaveBeenCalled();
  });

  it('неизвестный kind у валидной strict-формы также не получает fallback', async () => {
    const h = harness();
    const profile = { ...legacyStrictProfile(h.s.dir), kind: 'unknown' } as unknown as AgentRunRequest['profile'];
    const { result } = await blocked(h, h.req({ profile }));
    expect(result).toMatchObject({ reason: 'profile_unsupported' });
    expect(h.detect).not.toHaveBeenCalled();
  });

  it.each(['inherited', 'non-enumerable'] as const)('неизвестный %s kind не теряется при snapshot и не выбирает strict', async form => {
    const h = harness();
    const profile = legacyStrictProfile(h.s.dir);
    if (form === 'inherited') Object.setPrototypeOf(profile, { kind: 'unknown' });
    else Object.defineProperty(profile, 'kind', { value: 'unknown', enumerable: false });
    expect(validateAccessProfile(profile, h.s.dir)).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'profile_unsupported' }),
    ]));
    const { result } = await blocked(h, h.req({ profile }));
    expect(result).toMatchObject({ reason: 'profile_unsupported' });
    expect(h.detect).not.toHaveBeenCalled();
    expect(h.verify).not.toHaveBeenCalled();
    expect(h.assess).not.toHaveBeenCalled();
  });

  it.each(['NODE_OPTIONS', 'DYLD_INSERT_LIBRARIES', 'HTTPS_PROXY', 'ANTHROPIC_BASE_URL', 'BASH_ENV', 'DISABLE_AUTOUPDATER'])('запрещённый явный env %s блокирует practical', async name => {
    const h = harness();
    await blocked(h, h.req({ env: { HOME: h.s.dir, [name]: 'forbidden-value' } }));
    expect(h.assess).not.toHaveBeenCalled();
  });

  it('некорректное значение разрешённого env не заменяется готовым окружением', async () => {
    const h = harness();
    await blocked(h, h.req({ env: { HOME: 'bad\0path' } }));
    expect(h.assess).not.toHaveBeenCalled();
  });

  it.each([
    ['нет бинарника', 'binary_missing', { binaryPath: null, unavailable: [{ reason: 'binary_missing', detail: 'нет' }] }],
    ['нет auth', 'not_authenticated', { auth: 'unauthenticated', unavailable: [{ reason: 'not_authenticated', detail: 'нет входа' }] }],
    ['нет возможности', 'capability_missing', { unavailable: [{ reason: 'capability_missing', detail: '--tools' }] }],
  ] as const)('%s: практический выбор не скрывает исходную причину', async (_name, reason, patch) => {
    const h = harness({}, success(), { ...patch, unavailable: [...patch.unavailable] });
    const { result } = await blocked(h);
    expect(result).toMatchObject({ reason });
    expect(h.assess).not.toHaveBeenCalled();
  });

  it.each([
    ['resume', { resume: true }, { resume: false }],
    ['maxTurns', { maxTurns: 2 }, { maxTurns: false }],
    ['persistSession', { persistSession: false }, { noSessionPersistence: false }],
  ] as const)('запрошенная возможность %s отсутствует: capability_missing', async (_name, patch, caps) => {
    const h = harness({}, success(), { capabilities: { ...CAPS, ...caps } });
    const { result } = await blocked(h, h.req(patch));
    expect(result).toMatchObject({ reason: 'capability_missing' });
    expect(h.assess).not.toHaveBeenCalled();
  });

  it.each([{ agentSessionId: 'not-uuid' }, { turnId: '' }, { maxTurns: 0 }, { resume: true, persistSession: false }])('некорректный запрос сохраняет invalid_request: %j', async patch => {
    const h = harness();
    const { result } = await blocked(h, h.req(patch));
    expect(result).toMatchObject({ reason: 'invalid_request' });
    expect(h.assess).not.toHaveBeenCalled();
  });
});

describe('P1: synthetic practical-ready запускает только точный оценённый запрос', () => {
  it('закрытые argv/env не расширяются относительно strict; allow не отменяет deny', () => {
    const cwd = '/tmp/p1-contract';
    const policy = { tools: ['Read', 'Glob', 'Grep'] as const, allow: ['Read'], deny: ['Read'] };
    const practical = buildClaudeArgs(practicalRequest(cwd, { profile: practicalLocalReadProfile(cwd, policy) }));
    const strict = buildClaudeArgs(legacyStrictRequest(cwd, { profile: legacyStrictProfile(cwd, policy) }));
    expect(practical).toEqual(strict);
    expect(flagValue(practical.args, '--tools')).toBe('Read,Glob,Grep');
    expect(flagValue(practical.args, '--allowedTools')).toBe('Read');
    const denied = flagValue(practical.args, '--disallowedTools')?.split(',');
    for (const tool of ['Read', 'Bash', 'PowerShell', 'Edit', 'Write', 'NotebookEdit', 'Agent', 'Task', 'Skill', 'WebFetch', 'WebSearch']) expect(denied).toContain(tool);
    expect(flagValue(practical.args, '--setting-sources')).toBe('');
    expect(flagValue(practical.args, '--mcp-config')).toBe('{"mcpServers":{}}');
    expect(practical.args).toContain('--strict-mcp-config');
    expect(flagValue(practical.args, '--permission-mode')).toBe('dontAsk');
    expect(flagValue(practical.args, '--permission-prompts')).toBe('none');
    for (const flag of ['--bare', '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--plugin-dir', '--settings', '--add-dir', '--agents']) expect(practical.args).not.toContain(flag);
  });

  it('runner получает те же args/env, stdin и ID; strict verifier не вызывается и verified не выдаётся', async () => {
    let context: PracticalAdmissionContext | undefined;
    const h = harness({ assessPractical: async value => { context = value; return SYNTHETIC_READY; } });
    const req = h.req({ prompt: 'Точный synthetic-запрос P1\nВторая строка' });
    const { result } = await outcome(await h.adapter.start(req));
    expect(result).toMatchObject({ kind: 'success', text: 'Привет, мир 🌍' });
    expect(h.launch).toHaveBeenCalledTimes(1);
    expect(h.verify).not.toHaveBeenCalled();
    const launched = h.launch.mock.calls[0]![0];
    expect(launched.args).toBe(context?.args);
    expect(launched.env).toBe(context?.env);
    expect(launched.executable).toBe(context?.detection.binaryPath);
    expect(launched.cwd).toBe(context?.request.cwd);
    expect(launched.stdin).toBe(context?.request.prompt);
    expect(context?.detection.capabilities.readOnly).toBe('unverified');
    expect(SYNTHETIC_READY).not.toHaveProperty('evidence');
    expect(SYNTHETIC_READY).not.toHaveProperty('launch');
    const [record] = h.s.records();
    expect(record?.stdin).toBe(req.prompt);
    expect(record?.argv).toEqual(launched.args);
    expect(record?.argv.join(' ')).not.toContain(req.prompt);
    expect(flagValue(record!.argv, '--session-id')).toBe(SESSION);
  });

  it('первый ход/resume сохраняют ID, точный stdin и один terminal на ход', async () => {
    const h = harness();
    const first = await outcome(await h.adapter.start(h.req({ prompt: 'Первый' })));
    const next = await outcome(await h.adapter.start(h.req({ prompt: 'Продолжение', resume: true, turnId: 'turn-2' })));
    expect(first.result.kind).toBe('success');
    expect(next.result.kind).toBe('success');
    const [a, b] = h.s.records();
    expect(a?.stdin).toBe('Первый');
    expect(b?.stdin).toBe('Продолжение');
    expect(flagValue(a!.argv, '--session-id')).toBe(SESSION);
    expect(a?.argv).not.toContain('--resume');
    expect(flagValue(b!.argv, '--resume')).toBe(SESSION);
    expect(b?.argv).not.toContain('--session-id');
    expect(next.events[0]!.seq).toBeGreaterThan(first.events.at(-1)!.seq);
    expect(h.assess).toHaveBeenCalledTimes(2);
  });

  it('снимок делается до detect, затем request/profile/detection/args/env неизменяемы во время оценки', async () => {
    const detected = deferred<AgentDetection>();
    const entered = deferred<PracticalAdmissionContext>();
    const admission = deferred<PracticalAdmission>();
    const h = harness({ detect: () => detected.promise, assessPractical: context => { entered.resolve(context); return admission.promise; } });
    const req = h.req({ prompt: 'Исходный prompt' });
    const originalEnv = req.env as Record<string, string>;
    const originalProfile = req.profile;
    const run = await h.adapter.start(req);
    req.prompt = 'Подменённый prompt'; req.cwd = '/'; req.agentSessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    originalEnv.HOME = '/wrong-home';
    (originalProfile.tools as string[]).push('Bash');
    detected.resolve(h.detection);
    const context = await entered.promise;
    for (const value of [context, context.request, context.request.profile, context.request.profile.tools, context.request.profile.allow,
      context.request.profile.deny, context.request.profile.configPolicy, context.request.profile.configPolicy.settingSources,
      context.request.env, context.args, context.env, context.detection, context.detection.capabilities, context.detection.unavailable]) expect(Object.isFrozen(value)).toBe(true);
    expect(Reflect.set(context, 'args', ['--bare'])).toBe(false);
    expect(Reflect.set(context.request, 'prompt', 'MUTATED')).toBe(false);
    expect(Reflect.set(context.env, 'HOME', '/mutated')).toBe(false);
    expect(Reflect.set(context.args, '0', '--bare')).toBe(false);
    expect(Reflect.set(context.request.profile.tools, '0', 'Bash')).toBe(false);
    expect(Reflect.set(context.detection, 'binaryPath', '/wrong-binary')).toBe(false);
    h.detection.binaryPath = '/changed-after-assessment';
    h.detection.capabilities.tools = false;
    admission.resolve(SYNTHETIC_READY);
    const { result } = await outcome(run);
    expect(result.kind).toBe('success');
    const [record] = h.s.records();
    expect(record?.stdin).toBe('Исходный prompt');
    expect(record?.cwd).toBe(h.s.dir);
    expect(record?.env.HOME).toBe(h.s.dir);
    expect(flagValue(record!.argv, '--tools')).toBe('Read,Glob,Grep');
    expect(flagValue(record!.argv, '--session-id')).toBe(SESSION);
    expect(h.launch.mock.calls[0]![0].args).toBe(context.args);
    expect(h.launch.mock.calls[0]![0].env).toBe(context.env);
  });

  it.each([
    ['нет result', { steps: [] }, 'missing_result'],
    ['success с ненулевым exit', { ...success(), exit: 3 }, 'nonzero_exit'],
    ['ошибка CLI', { steps: [{ out: fixture('error-execution.jsonl') }], exit: 1 }, undefined],
  ] as const)('после practical launch %s сохраняет ошибку и один terminal', async (_name, scenario, reason) => {
    const h = harness({}, { ...scenario, steps: [...(scenario.steps ?? [])] });
    const { result } = await outcome(await h.adapter.start(h.req()));
    expect(result.kind).toBe('error');
    if (reason) expect(result).toMatchObject({ reason });
    expect(h.launch).toHaveBeenCalledTimes(1);
  });
});

describe('P1: stop/error/deadline оценки запрещают поздний prompt', () => {
  it.each(['strict', 'practical'] as const)('P2a: Stop во время detect для %s не допускает поздний prompt', async profile => {
    vi.useFakeTimers();
    const detected = deferred<AgentDetection>();
    const h = harness({ detect: () => detected.promise, timeoutMs: 100, stopGraceMs: 10, drainTimeoutMs: 20 });
    const run = await h.adapter.start(profile === 'strict' ? legacyStrictRequest(h.s.dir) : h.req());
    const stopping = run.interrupt();
    await vi.advanceTimersByTimeAsync(500);
    await stopping;
    const before = await outcome(run);
    expect(before.result).toMatchObject({ kind: 'interrupted', stopAccepted: true,
      completion: { process: { state: 'not_started' }, stdout: 'not_started', stderr: 'not_started', signals: [] } });
    detected.resolve(h.detection);
    await vi.advanceTimersByTimeAsync(1);
    expect(await run.done).toBe(before.result);
    expect(h.launch).not.toHaveBeenCalled();
    expect(h.assess).not.toHaveBeenCalled();
    expect(h.verify).not.toHaveBeenCalled();
    expect(h.s.records()).toEqual([]);
  });

  it.each(['interrupt', 'kill'] as const)('%s во время оценки: поздний ready не запускает runner', async method => {
    const entered = deferred<PracticalAdmissionContext>();
    const admission = deferred<PracticalAdmission>();
    const h = harness({ assessPractical: context => { entered.resolve(context); return admission.promise; } });
    const run = await h.adapter.start(h.req());
    await entered.promise;
    const stopped = run[method]();
    admission.resolve(SYNTHETIC_READY);
    await stopped;
    const { result } = await outcome(run);
    expect(result).toMatchObject({ kind: 'interrupted', stopAccepted: true, completion: {
      process: { state: 'not_started' }, stdout: 'not_started', stderr: 'not_started', signals: [],
    } });
    expect(h.launch).not.toHaveBeenCalled();
    expect(h.s.records()).toEqual([]);
  });

  it('ошибка оценки после Stop не создаёт второй terminal или prompt', async () => {
    const entered = deferred<PracticalAdmissionContext>();
    const admission = deferred<PracticalAdmission>();
    const h = harness({ assessPractical: context => { entered.resolve(context); return admission.promise; } });
    const run = await h.adapter.start(h.req());
    await entered.promise;
    const stopped = run.interrupt();
    admission.reject(new Error('synthetic failure after stop'));
    await stopped;
    expect((await outcome(run)).result).toMatchObject({ kind: 'interrupted', stopAccepted: true,
      completion: { process: { state: 'not_started' }, signals: [] } });
    expect(h.launch).not.toHaveBeenCalled();
  });

  it('ready между deadline и отложенным finish не запускает prompt', async () => {
    vi.useFakeTimers();
    const entered = deferred<PracticalAdmissionContext>();
    const admission = deferred<PracticalAdmission>();
    const h = harness({ timeoutMs: 100, stopGraceMs: 10, drainTimeoutMs: 100,
      assessPractical: context => { entered.resolve(context); return admission.promise; } });
    const run = await h.adapter.start(h.req());
    await entered.promise;
    await vi.advanceTimersByTimeAsync(211);
    admission.resolve(SYNTHETIC_READY);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.launch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect((await outcome(run)).result).toMatchObject({ kind: 'error', reason: 'timeout' });
    expect(h.s.records()).toEqual([]);
  });

  it('ready после окончательного timeout не создаёт второй terminal', async () => {
    vi.useFakeTimers();
    const entered = deferred<PracticalAdmissionContext>();
    const admission = deferred<PracticalAdmission>();
    const h = harness({ timeoutMs: 100, stopGraceMs: 10, drainTimeoutMs: 100,
      assessPractical: context => { entered.resolve(context); return admission.promise; } });
    const run = await h.adapter.start(h.req());
    await entered.promise;
    await vi.advanceTimersByTimeAsync(400);
    const before = await outcome(run);
    expect(before.result).toMatchObject({ kind: 'error', reason: 'timeout' });
    admission.resolve(SYNTHETIC_READY);
    await vi.advanceTimersByTimeAsync(1);
    expect(await run.done).toBe(before.result);
    expect(h.launch).not.toHaveBeenCalled();
    expect(h.s.records()).toEqual([]);
  });
});
