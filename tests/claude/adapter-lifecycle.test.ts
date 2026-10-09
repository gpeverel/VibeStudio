import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createClaudeAdapter } from '../../src/adapters/claude/index.ts';
import type { ClaudeAdapterOptions } from '../../src/adapters/claude/index.ts';
import type { AccessVerification } from '../../src/adapters/claude/profile.ts';
import type { AgentCapabilities, AgentDetection, AgentEvent, AgentRun, AgentRunRequest, AgentRunResult } from '../../src/core/ports/agent.ts';
import { readOnlyProfile, request } from '../helpers/claude/requests.ts';
import { Stand, pidAlive, waitFor } from '../helpers/claude/stand.ts';
import type { FakeScenario, FakeStep } from '../helpers/claude/stand.ts';

/*
 * ВАЖНО: это синтетическая проверка оркестрации адаптера на двойнике CLI (tests/helpers/claude/fake-claude.mjs).
 * Подтверждение доступа (verifyAccess) здесь — тестовая подстановка. Тесты НЕ доказывают ни формат потока
 * настоящей CLI, ни ограничения её профиля: это закрывается только живой приёмкой (LIVE=1).
 */
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'claude');
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');
const FIXTURE_SESSION = '11111111-1111-4111-8111-111111111111';

const stands: Stand[] = [];
function stand(): Stand { const s = new Stand(); stands.push(s); return s; }
afterEach(() => { while (stands.length) stands.pop()?.cleanup(); });

const CAPS: AgentCapabilities = {
  streamJson: true, partialMessages: true, sessionId: true, resume: true, noSessionPersistence: true, maxTurns: true,
  restricted: true, safeMode: true, tools: true, settingSources: true, strictMcpConfig: true, permissionPrompts: true,
  readOnly: 'unverified',
};
const detection = (binaryPath: string | null, overrides: Partial<AgentDetection> = {}): AgentDetection => ({
  status: 'unavailable', binaryPath, version: '2.1.295', auth: 'authenticated', capabilities: CAPS,
  unavailable: [{ reason: 'profile_unverified', detail: 'не подтверждено' }], ...overrides,
});
const VERIFIED: AccessVerification = { status: 'verified', evidence: ['synthetic-test-stub'], detail: 'подстановка теста' };

interface Harness { s: Stand; bin: string; adapter: ReturnType<typeof createClaudeAdapter>; req: (o?: Partial<AgentRunRequest>) => AgentRunRequest }
function harness(scenario: FakeScenario, options: Partial<ClaudeAdapterOptions> = {}, det?: Partial<AgentDetection>): Harness {
  const s = stand();
  const bin = s.fakeClaude(scenario);
  const adapter = createClaudeAdapter({
    env: { HOME: s.dir, PATH: '/usr/bin:/bin' },
    detect: async () => detection(bin, det),
    verifyAccess: async () => VERIFIED,
    timeoutMs: 10_000, stopGraceMs: 200, drainTimeoutMs: 500,
    ...options,
  });
  return { s, bin, adapter, req: (o = {}) => request(s.dir, { agentSessionId: FIXTURE_SESSION, profile: readOnlyProfile(s.dir), ...o }) };
}
async function collect(run: AgentRun): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run.events) events.push(event);
  return events;
}
const out = (text: string, fragment?: number): FakeStep => ({ out: text, ...(fragment ? { fragment } : {}) });
const finished = (events: AgentEvent[]): AgentEvent[] => events.filter(e => e.type === 'run_finished');
const text = (events: AgentEvent[]): string => events.reduce((acc, e) => (e.type === 'text' ? (e.mode === 'delta' ? acc + e.text : e.text) : acc), '');
const runs = (s: Stand) => s.records().filter(r => r.probe === 'run');

describe('0C адаптер: успешный запуск и конверт событий', () => {
  it('success: конверт, монотонный seq, единственный run_finished, промпт через stdin', async () => {
    const h = harness({ steps: [out(fixture('success-simple.jsonl'))] });
    const run = await h.adapter.start(h.req({ prompt: 'ЗАПРОС-УНИК-7731 ж' }));
    const [events, result] = await Promise.all([collect(run), run.done]);
    expect(result).toMatchObject({ kind: 'success', text: 'Привет, мир 🌍' });
    expect(finished(events)).toHaveLength(1);
    expect(events.at(-1)?.type).toBe('run_finished');
    expect(events.filter(e => e.type === 'run_started')).toHaveLength(1);
    events.forEach((e, i) => {
      expect(e.schemaVersion).toBe(1);
      expect(e.sessionId).toBe('app-session-1');
      expect(e.turnId).toBe('turn-1');
      expect(e.participantId).toBe('participant-1');
      expect(Number.isNaN(Date.parse(e.timestamp))).toBe(false);
      if (i > 0) expect(e.seq).toBeGreaterThan(events[i - 1]!.seq);
    });
    expect(new Set(events.map(e => e.eventId)).size).toBe(events.length);
    const [record] = runs(h.s);
    expect(record?.stdin).toBe('ЗАПРОС-УНИК-7731 ж');
    expect(record?.argv.join('\n')).not.toContain('ЗАПРОС-УНИК');
    expect(record?.cwd).toBe(h.s.dir);
  });

  it('done и run_finished согласованы; повторное ожидание done возвращает тот же результат', async () => {
    const h = harness({ steps: [out(fixture('success-simple.jsonl'))] });
    const run = await h.adapter.start(h.req());
    const events = await collect(run);
    const result = await run.done;
    expect(await run.done).toBe(result);
    const last = events.at(-1);
    expect(last && last.type === 'run_finished' ? last.result : undefined).toEqual(result);
  });

  it('первый ход и resume: тот же agentSessionId, разные turnId, seq продолжается в рамках сессии приложения', async () => {
    const h = harness({ steps: [out(fixture('success-simple.jsonl'))] });
    const first = await h.adapter.start(h.req({ turnId: 'turn-1' }));
    const e1 = await collect(first);
    const second = await h.adapter.start(h.req({ turnId: 'turn-2', resume: true }));
    const e2 = await collect(second);
    expect(e1.every(e => e.turnId === 'turn-1')).toBe(true);
    expect(e2.every(e => e.turnId === 'turn-2')).toBe(true);
    expect(e2[0]!.seq).toBeGreaterThan(e1.at(-1)!.seq);
    const [a, b] = runs(h.s);
    expect(a!.argv).toContain('--session-id');
    expect(b!.argv).toContain('--resume');
    expect(b!.argv[b!.argv.indexOf('--resume') + 1]).toBe(FIXTURE_SESSION);
    expect(b!.argv.join(' ')).not.toContain('turn-2');
  });

  it('параллельные запуски разных сессий приложения не смешивают seq и события', async () => {
    const h = harness({ steps: [out(fixture('success-simple.jsonl'))] });
    const [r1, r2] = await Promise.all([
      h.adapter.start(h.req({ sessionId: 'app-A', turnId: 't-A' })),
      h.adapter.start(h.req({ sessionId: 'app-B', turnId: 't-B' })),
    ]);
    const [e1, e2] = await Promise.all([collect(r1), collect(r2)]);
    expect(e1.every(e => e.sessionId === 'app-A' && e.turnId === 't-A')).toBe(true);
    expect(e2.every(e => e.sessionId === 'app-B' && e.turnId === 't-B')).toBe(true);
    expect(e1[0]!.seq).toBe(1);
    expect(e2[0]!.seq).toBe(1);
  });

  it('произвольная фрагментация вывода CLI не меняет текст: дельты и snapshot не дублируются', async () => {
    const h = harness({ steps: [out(fixture('partial-deltas-then-snapshot.jsonl'), 3)] });
    const run = await h.adapter.start(h.req());
    const events = await collect(run);
    expect(await run.done).toMatchObject({ kind: 'success' });
    expect(text(events)).toBe('Привет, мир 🌍');
  });

  it('stderr отделён от stdout: содержимое не попадает ни в события, ни в диагностику, размер ограничен', async () => {
    const h = harness({ steps: [{ err: 'SECRET-TOKEN-abc123 '.repeat(5_000) }, out(fixture('success-simple.jsonl'))] }, { maxDiagBytes: 1_024 });
    const run = await h.adapter.start(h.req());
    const events = await collect(run);
    expect(await run.done).toMatchObject({ kind: 'success' });
    const dump = JSON.stringify([events, run.diagnostics]);
    expect(dump).not.toContain('SECRET-TOKEN');
    const bytes = run.diagnostics.reduce((n, d) => n + Buffer.byteLength(d.code + d.detail), 0);
    expect(bytes).toBeLessThanOrEqual(1_024);
  });

  it('неизвестные события дают ограниченную диагностику и не ломают запуск', async () => {
    const h = harness({ steps: [out(fixture('unknown-events.jsonl'))] }, { maxDiagBytes: 2_048 });
    const run = await h.adapter.start(h.req());
    await collect(run);
    expect(await run.done).toMatchObject({ kind: 'success' });
    expect(run.diagnostics.length).toBeGreaterThan(0);
    expect(JSON.stringify(run.diagnostics)).not.toContain('xxxxxxxxxx');
  });

  it('ошибки результата CLI сопоставляются: max_turns, error', async () => {
    const mt = harness({ steps: [out(fixture('error-max-turns.jsonl'))] });
    const r1 = await mt.adapter.start(mt.req());
    await collect(r1);
    expect((await r1.done).kind).toBe('max_turns');
    const er = harness({ steps: [out(fixture('error-execution.jsonl'))] });
    const r2 = await er.adapter.start(er.req());
    await collect(r2);
    expect((await r2.done).kind).toBe('error');
  });
});

describe('0C адаптер: повреждённый поток и завершение процесса не становятся success', () => {
  async function outcome(h: Harness, o: Partial<AgentRunRequest> = {}): Promise<{ result: AgentRunResult; events: AgentEvent[] }> {
    const run = await h.adapter.start(h.req(o));
    const [events, result] = await Promise.all([collect(run), run.done]);
    expect(finished(events)).toHaveLength(1);
    return { result, events };
  }

  it('нет result: missing_result', async () => {
    const { result } = await outcome(harness({ steps: [out(fixture('no-result.jsonl'))] }));
    expect(result).toMatchObject({ kind: 'error', reason: 'missing_result' });
  });

  it('оборванный result без LF: protocol_incompatible', async () => {
    const { result } = await outcome(harness({ steps: [out(fixture('truncated-result.jsonl'))] }));
    expect(result).toMatchObject({ kind: 'error', reason: 'protocol_incompatible' });
  });

  it('result success, но ненулевой exit: не success', async () => {
    const { result } = await outcome(harness({ steps: [out(fixture('success-simple.jsonl'))], exit: 3 }));
    expect(result.kind).toBe('error');
    expect(result).toMatchObject({ reason: 'nonzero_exit' });
  });

  it('result error + ненулевой exit остаётся ошибкой, а не успехом', async () => {
    const { result } = await outcome(harness({ steps: [out(fixture('error-execution.jsonl'))], exit: 1 }));
    expect(result.kind).toBe('error');
  });

  it('пустой вывод и exit 0: missing_result', async () => {
    const { result } = await outcome(harness({ steps: [] }));
    expect(result).toMatchObject({ kind: 'error', reason: 'missing_result' });
  });

  it('убийство процесса сигналом без result: ошибка, а не success', async () => {
    const { result } = await outcome(harness({ steps: [out(fixture('success-simple.jsonl')), { sleep: 50 }], exit: 0 }, {}), {});
    expect(result.kind).toBe('success'); // контроль: корректный поток проходит
    const sig = harness({ steps: [out(fixture('no-result.jsonl')), { hang: true }] }, { timeoutMs: 300 });
    const r = await outcome(sig);
    expect(r.result.kind).toBe('error');
  });

  it('событие после result и другой session_id отклоняются', async () => {
    expect((await outcome(harness({ steps: [out(fixture('events-after-result.jsonl'))] }))).result).toMatchObject({ kind: 'error', reason: 'protocol_incompatible' });
    expect((await outcome(harness({ steps: [out(fixture('other-session.jsonl'))] }))).result).toMatchObject({ kind: 'error', reason: 'protocol_incompatible' });
  });

  it('сломанная строка в середине потока: ошибка, процесс принудительно останавливается', async () => {
    const t0 = Date.now();
    const { result } = await outcome(harness({ steps: [out(fixture('corrupt-middle.jsonl')), { hang: true }] }));
    expect(result).toMatchObject({ kind: 'error', reason: 'protocol_incompatible' });
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it('невалидный UTF-8 в stdout: protocol_incompatible', async () => {
    const bad = Buffer.concat([Buffer.from('{"type":"system","subtype":"init","session_id":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}\n')]);
    const { result } = await outcome(harness({ steps: [{ out: bad.toString('base64'), base64: true }] }));
    expect(result).toMatchObject({ kind: 'error', reason: 'protocol_incompatible' });
  });

  it('строка длиннее лимита: output_limit, память не растёт неограниченно', async () => {
    const huge = `{"type":"future","pad":"${'a'.repeat(200_000)}"}\n`;
    const { result } = await outcome(harness({ steps: [out(huge)] }, { parserLimits: { maxLineBytes: 10_000 } }));
    expect(result).toMatchObject({ kind: 'error', reason: 'output_limit' });
  });

  it('таймаут процесса: error timeout за ограниченное время, процесс не остаётся', async () => {
    const h = harness({ steps: [{ hang: true }] }, { timeoutMs: 300 });
    const t0 = Date.now();
    const { result, events } = await outcome(h);
    expect(result).toMatchObject({ kind: 'error', reason: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(events.at(-1)?.type).toBe('run_finished');
  });

  it('ошибка spawn (бинарник исчез) завершается доменным результатом, а не исключением', async () => {
    const s = stand();
    const adapter = createClaudeAdapter({
      env: { HOME: s.dir }, detect: async () => detection(s.path('исчез-claude')), verifyAccess: async () => VERIFIED,
      timeoutMs: 3_000, stopGraceMs: 100, drainTimeoutMs: 300,
    });
    const run = await adapter.start(request(s.dir, { agentSessionId: FIXTURE_SESSION }));
    const [events, result] = await Promise.all([collect(run), run.done]);
    expect(result).toMatchObject({ kind: 'error', reason: 'spawn_failed' });
    expect(finished(events)).toHaveLength(1);
  });

  it('медленный/отсутствующий потребитель: очередь событий ограничена, done завершается output_limit без чтения events', async () => {
    const lines = Array.from({ length: 3_000 }, (_, i) => JSON.stringify({ type: 'assistant', message: { id: `m${i}`, content: [{ type: 'text', text: `t${i}` }] } })).join('\n') + '\n';
    const h = harness({ steps: [out(lines)] }, { maxQueue: 8, parserLimits: { maxMessages: 100_000, maxStateBytes: 50_000_000 } });
    const run = await h.adapter.start(h.req());
    const result = await Promise.race([run.done, new Promise<'hang'>(resolve => setTimeout(() => resolve('hang'), 8_000))]);
    expect(result).toMatchObject({ kind: 'error', reason: 'output_limit' });
    const events = await collect(run); // позже: в очереди только ограниченное число событий + терминал
    expect(events.length).toBeLessThanOrEqual(8 + 2);
    expect(finished(events)).toHaveLength(1);
    expect(events.at(-1)?.type).toBe('run_finished');
  });
});

describe('0C адаптер: остановка', () => {
  const startRunning = async (h: Harness, extra: Partial<AgentRunRequest> = {}): Promise<AgentRun> => {
    const run = await h.adapter.start(h.req(extra));
    const iterator = run.events[Symbol.asyncIterator]();
    const first = await iterator.next(); // run_started: процесс запущен
    expect(first.value?.type).toBe('run_started');
    return run;
  };

  it('interrupt до result: interrupted; повторные и параллельные вызовы идемпотентны; run_finished один', async () => {
    const h = harness({ steps: [out(fixture('no-result.jsonl')), { hang: true }] });
    const run = await startRunning(h);
    await Promise.all([run.interrupt(), run.interrupt(), run.kill()]);
    await run.interrupt();
    await run.kill();
    expect(await run.done).toEqual({ kind: 'interrupted' });
  });

  it('все события доступны после остановки и заканчиваются единственным run_finished(interrupted)', async () => {
    const h = harness({ steps: [out(fixture('no-result.jsonl')), { hang: true }] });
    const run = await h.adapter.start(h.req());
    const collected = collect(run);
    await waitFor(() => runs(h.s).length > 0);
    await run.interrupt();
    const events = await collected;
    expect(finished(events)).toHaveLength(1);
    const last = events.at(-1);
    expect(last && last.type === 'run_finished' ? last.result : undefined).toEqual({ kind: 'interrupted' });
  });

  it('interrupt после завершения запуска не меняет терминальный результат', async () => {
    const h = harness({ steps: [out(fixture('success-simple.jsonl'))] });
    const run = await h.adapter.start(h.req());
    await collect(run);
    const result = await run.done;
    await run.interrupt();
    await run.kill();
    expect(await run.done).toBe(result);
    expect(result.kind).toBe('success');
  });

  it('stop после получения result, но до завершения процесса: не «Готово»', async () => {
    const h = harness({ steps: [out(fixture('success-simple.jsonl')), { hang: true }] }, { timeoutMs: 20_000 });
    const run = await h.adapter.start(h.req());
    const seen: AgentEvent[] = [];
    const reader = (async () => { for await (const e of run.events) { seen.push(e); } })();
    await waitFor(() => seen.some(e => e.type === 'usage'));
    await run.interrupt();
    await reader;
    expect(await run.done).toEqual({ kind: 'interrupted' });
    expect(finished(seen)).toHaveLength(1);
  });

  it('interrupt, пока идёт диагностика (процесс ещё не создан): процесс не стартует', async () => {
    const s = stand();
    const bin = s.fakeClaude({ steps: [out(fixture('success-simple.jsonl'))] });
    const adapter = createClaudeAdapter({
      env: { HOME: s.dir },
      detect: async () => { await new Promise(r => setTimeout(r, 300)); return detection(bin); },
      verifyAccess: async () => VERIFIED, timeoutMs: 5_000, stopGraceMs: 100, drainTimeoutMs: 300,
    });
    const run = await adapter.start(request(s.dir, { agentSessionId: FIXTURE_SESSION }));
    await run.interrupt();
    expect(await run.done).toEqual({ kind: 'interrupted' });
    await new Promise(r => setTimeout(r, 200));
    expect(runs(s)).toHaveLength(0);
  });

  it('kill останавливает процесс, игнорирующий SIGTERM, и его дочерние процессы', async () => {
    const h = harness({ steps: [{ ignoreSigterm: true }, { spawnChild: '' }, out(fixture('no-result.jsonl')), { hang: true }] });
    const pidFile = h.s.path('child.pid');
    const scenario = h.s.fakeClaude({ steps: [{ ignoreSigterm: true }, { spawnChild: pidFile }, out(fixture('no-result.jsonl')), { hang: true }] });
    const adapter = createClaudeAdapter({
      env: { HOME: h.s.dir }, detect: async () => detection(scenario), verifyAccess: async () => VERIFIED,
      timeoutMs: 20_000, stopGraceMs: 150, drainTimeoutMs: 400,
    });
    const run = await adapter.start(request(h.s.dir, { agentSessionId: FIXTURE_SESSION }));
    expect(await waitFor(() => existsSync(pidFile))).toBe(true);
    const childPid = Number(readFileSync(pidFile, 'utf8'));
    expect(pidAlive(childPid)).toBe(true);
    await run.interrupt();
    expect(await run.done).toEqual({ kind: 'interrupted' });
    expect(await waitFor(() => !pidAlive(childPid))).toBe(true);
  });
});

describe('0C адаптер: диагностика блокирует запуск до создания процесса', () => {
  async function blocked(h: Harness, o: Partial<AgentRunRequest> = {}): Promise<AgentRunResult> {
    const run = await h.adapter.start(h.req(o));
    const [events, result] = await Promise.all([collect(run), run.done]);
    expect(finished(events)).toHaveLength(1);
    expect(runs(h.s)).toHaveLength(0); // CLI с промптом не запускался
    return result;
  }

  it('нет бинарника: binary_missing', async () => {
    const h = harness({}, {}, { binaryPath: null, unavailable: [{ reason: 'binary_missing', detail: 'не найден' }] });
    expect(await blocked(h)).toMatchObject({ kind: 'error', reason: 'binary_missing' });
  });

  it('нет авторизации: not_authenticated, отличается от остальных причин', async () => {
    const h = harness({}, {}, { auth: 'unauthenticated', unavailable: [{ reason: 'not_authenticated', detail: 'нужен вход' }] });
    expect(await blocked(h)).toMatchObject({ kind: 'error', reason: 'not_authenticated' });
  });

  it('несовместимая возможность: capability_missing', async () => {
    const h = harness({}, {}, { unavailable: [{ reason: 'capability_missing', detail: '--restricted' }] });
    expect(await blocked(h)).toMatchObject({ kind: 'error', reason: 'capability_missing' });
  });

  it('resume без поддержки resume в CLI блокируется', async () => {
    const h = harness({}, {}, { capabilities: { ...CAPS, resume: false } });
    expect(await blocked(h, { resume: true })).toMatchObject({ kind: 'error', reason: 'capability_missing' });
  });

  it('read-only без подтверждения: profile_unverified; production-умолчание (нет verifyAccess) тоже блокирует', async () => {
    const s = stand();
    const bin = s.fakeClaude({ steps: [out(fixture('success-simple.jsonl'))] });
    const adapter = createClaudeAdapter({ env: { HOME: s.dir }, detect: async () => detection(bin), timeoutMs: 3_000, stopGraceMs: 100, drainTimeoutMs: 300 });
    const run = await adapter.start(request(s.dir, { agentSessionId: FIXTURE_SESSION }));
    expect(await run.done).toMatchObject({ kind: 'error', reason: 'profile_unverified' });
    expect(runs(s)).toHaveLength(0);
  });

  it('verified без доказательств, unverified и unsupported не запускают CLI; unsupported не заменяется слабым профилем', async () => {
    const cases: [AccessVerification, string][] = [
      [{ status: 'verified', evidence: [], detail: 'пусто' }, 'profile_unverified'],
      [{ status: 'unverified', evidence: ['x'], detail: '' }, 'profile_unverified'],
      [{ status: 'unsupported', evidence: [], detail: 'нельзя' }, 'profile_unsupported'],
    ];
    for (const [verification, reason] of cases) {
      const h = harness({ steps: [out(fixture('success-simple.jsonl'))] }, { verifyAccess: async () => verification });
      expect(await blocked(h)).toMatchObject({ kind: 'error', reason });
    }
  });

  it('ослабленный профиль (Bash, запись, включённые hooks) отклоняется до диагностики и запуска', async () => {
    const weak: Record<string, unknown>[] = [
      { tools: ['Read', 'Bash'] },
      { fs: { readRoots: [], writeRoots: ['/x'], runtimeWriteRoots: [], protectedPaths: [] } },
      { configPolicy: { settingSources: [], loadHooks: true, loadMcp: false, loadPlugins: false } },
    ];
    for (const patch of weak) {
      let detectCalled = false;
      const h = harness({}, { detect: async () => { detectCalled = true; return detection(null); } });
      const profile = { ...readOnlyProfile(h.s.dir), ...patch } as AgentRunRequest['profile'];
      const result = await blocked(h, { profile });
      expect(result).toMatchObject({ kind: 'error', reason: 'profile_unsupported' });
      expect(detectCalled).toBe(false);
    }
  });

  it('некорректный запрос (не UUID, пустой turnId) — invalid_request без запуска', async () => {
    const h = harness({});
    expect(await blocked(h, { agentSessionId: 'не-uuid' })).toMatchObject({ kind: 'error', reason: 'invalid_request' });
    expect(await blocked(h, { turnId: '' })).toMatchObject({ kind: 'error', reason: 'invalid_request' });
  });

  it('verifyAccess получает контекст запуска: argv с --tools и allowlist-окружение', async () => {
    let context: Parameters<NonNullable<ClaudeAdapterOptions['verifyAccess']>>[0] | undefined;
    const h = harness({ steps: [out(fixture('success-simple.jsonl'))] }, { verifyAccess: async c => { context = c; return VERIFIED; } });
    const run = await h.adapter.start(h.req({ env: { HOME: h.s.dir, NODE_OPTIONS: '--require /evil.js' } }));
    await collect(run);
    expect(context?.args).toContain('--tools');
    expect(context?.env).not.toHaveProperty('NODE_OPTIONS');
    const [record] = runs(h.s);
    expect(record?.env).not.toHaveProperty('NODE_OPTIONS');
    expect(record?.argv).toEqual(context?.args);
  });
});
