import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClaudeAdapter } from '../../src/adapters/claude/index.ts';
import type { AgentDiagnostic, AgentRun, AgentRunCompletion, NormalizedPayload } from '../../src/core/ports/agent.ts';
import type { ProcessCompletion, ProcessRequest, ProcessResult, ProcessRun, ProcessRunner } from '../../src/core/ports/process-runner.ts';
import { jsonLines, SYNTHETIC_SESSION, syntheticInit, syntheticResult } from '../helpers/claude/practical-evidence.ts';
import { createPracticalLiveHarness, instructionContextVerdict, safeLiveCompletion, summarizePracticalLive } from '../helpers/claude/practical-live.ts';
import type { LiveCheckName, LiveChecks, LiveLabel, LiveObservation, LiveReport } from '../helpers/claude/practical-live.ts';
import { practicalRequest } from '../helpers/claude/requests.ts';

/** Независимая матрица C. Все handles и CLI-ответы явно synthetic, OS spawn отсутствует.
 * Production adapter в последней группе настоящий, но CLI заменён runner-double.
 * Эти проверки не подтверждают реальную совместимость Claude, auth или модель. */
const SECRET = 'SYNTHETIC-SECRET-DO-NOT-SERIALIZE';
// Независимые фиксированные ожидания, не результат проверяемого validator/builder.
const FIRST_CONTEXT = 'Твоя задача передана в сообщении пользователя.';
const RESUME_CONTEXT = 'Это продолжение предыдущего диалога. Новая инструкция передана в сообщении пользователя.';
const contextAnswer = (context: string, marker = SECRET) => `КОНТЕКСТ: ${context}\nМЕТКА: ${marker}`;
const instructionContext = { firstContext: FIRST_CONTEXT, resumeContext: RESUME_CONTEXT, previousText: contextAnswer(FIRST_CONTEXT) };
const LIMITATIONS = [
  'no_os_sandbox', 'no_provider_only_network', 'detached_children_not_guaranteed', 'cli_configuration_not_audited',
];
const PHASES = [['--version'], ['--help'], ['--safe-mode', '--restricted', 'auth', 'status'], ['--print']] as const;
const HELP = '--print --verbose --input-format --output-format stream-json --include-partial-messages --restricted --safe-mode --setting-sources --strict-mcp-config --mcp-config --tools --permission-mode --permission-prompts --disable-slash-commands --no-chrome --disallowedTools --allowedTools --append-system-prompt --session-id --system-prompt-snapshot --no-session-persistence --resume --max-turns';
const finished = (patch: Partial<ProcessCompletion> = {}): ProcessCompletion => ({
  process: { state: 'exited', exitCode: 0, signal: null }, stdout: 'ended', stderr: 'ended',
  signals: [], wait: 'settled', issues: [], descendants: 'not_guaranteed', ...patch,
});
function processResult(completion = finished()): ProcessResult {
  return { exitCode: completion.process.state === 'exited' ? completion.process.exitCode : null,
    signal: completion.process.state === 'exited' ? completion.process.signal : null, completion };
}
function agentResult(completion = finished()): Extract<AgentRunCompletion, { kind: 'success' }> {
  return { kind: 'success', text: SECRET, stopAccepted: false, completion };
}
function pending<T>(): Promise<T> { return new Promise(() => undefined); }
async function* chunks(...buffers: Uint8Array[]) { yield* buffers; }
function processDouble(request: ProcessRequest, patch: Partial<ProcessRun> = {}): ProcessRun {
  const output = request.args.includes('--print') ? jsonLines(syntheticInit(), syntheticResult())
    : Buffer.from(request.args.includes('--version') ? '2.1.295 (Claude Code)\n'
      : request.args.includes('--help') ? HELP : '{"loggedIn":true}');
  return { stdout: chunks(output), stderr: chunks(), done: Promise.resolve(processResult()),
    interrupt: vi.fn(async () => undefined), kill: vi.fn(async () => undefined), ...patch };
}
function agentDouble(options: {
  result?: AgentRunCompletion; payloads?: NormalizedPayload[]; terminal?: AgentRunCompletion;
  omitTerminal?: boolean; diagnostics?: AgentDiagnostic[]; patch?: Partial<AgentRun>;
} = {}): AgentRun {
  const result = options.result ?? agentResult();
  const payloads: NormalizedPayload[] = [{ type: 'run_started', agentSessionId: SYNTHETIC_SESSION }, ...(options.payloads ?? [])];
  if (!options.omitTerminal) payloads.push({ type: 'run_finished', result: options.terminal ?? result });
  return {
    events: (async function* () {
      for (const [seq, payload] of payloads.entries()) yield { ...payload, schemaVersion: 1 as const,
        eventId: `synthetic-${seq}`, sessionId: 'synthetic-session', turnId: 'synthetic-turn',
        participantId: 'synthetic-agent', seq, timestamp: '2026-10-17T00:00:00.000Z' };
    })(),
    done: Promise.resolve(result), interrupt: vi.fn(async () => undefined), kill: vi.fn(async () => undefined),
    diagnostics: options.diagnostics ?? [{ code: 'practical_limitations', detail: LIMITATIONS.join(',') }],
    ...options.patch,
  };
}
function contextAgent(resume: boolean): AgentRun {
  const text = contextAnswer(resume ? RESUME_CONTEXT : FIRST_CONTEXT);
  return agentDouble({ result: { ...agentResult(), text }, payloads: [{ type: 'text', messageId: 'context', mode: 'snapshot', text }] });
}
type Harness = ReturnType<typeof createPracticalLiveHarness>;
function setup(start: ProcessRunner['start'] = request => processDouble(request)) {
  const nativeStart = vi.fn(start);
  const harness = createPracticalLiveHarness({ runner: { start: nativeStart }, scenarioTimeoutMs: 40, cleanupTimeoutMs: 5 });
  return { harness, nativeStart };
}
function request(args: readonly string[]): ProcessRequest {
  return { executable: '/synthetic/claude', args, cwd: '/synthetic/project', env: {}, stdin: '' };
}
async function drain(stream: AsyncIterable<Uint8Array>) { for await (const chunk of stream) void chunk; }
async function launchSequence(harness: Harness, agent = agentDouble()): Promise<AgentRun> {
  for (const args of PHASES) {
    const run = harness.runner.start(request(args));
    await Promise.all([drain(run.stdout), drain(run.stderr), run.done]);
  }
  return agent;
}
const optionalUnknown = (): LiveChecks => ({
  explicitWriteDenial: { verdict: 'unconfirmed', required: false },
  instructionApplication: { verdict: 'unconfirmed', required: false },
  pluginRecognition: { verdict: 'unconfirmed', required: false },
  providerRefresh: { verdict: 'unconfirmed', required: false },
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('P2b live: независимое наблюдение контекста инструкции, synthetic', () => {
  it.each([false, true])('полный текущий абзац подтверждает ограниченное наблюдение, resume=%s', resume => {
    expect(instructionContextVerdict({ ...instructionContext, resume,
      text: contextAnswer(resume ? RESUME_CONTEXT : FIRST_CONTEXT) })).toBe('passed');
  });

  it('CRLF и внешние пробелы не меняют дословный контекст; значение метки проверяется отдельно', () => {
    expect(instructionContextVerdict({ ...instructionContext, resume: true,
      text: '\n ' + contextAnswer(RESUME_CONTEXT, 'ANOTHER-MEMORY').replaceAll('\n', '\r\n') + '\n' })).toBe('passed');
  });

  it.each([false, true])('полный противоположный контекст даёт failed, resume=%s', resume => {
    expect(instructionContextVerdict({ ...instructionContext, resume,
      text: contextAnswer(resume ? FIRST_CONTEXT : RESUME_CONTEXT) })).toBe('failed');
  });

  it.each([
    ['одно слово', 'ПРОДОЛЖЕНИЕ'],
    ['только первое предложение', contextAnswer('Это продолжение предыдущего диалога.')],
    ['пересказ', contextAnswer('Диалог продолжается, новая задача дана пользователем.')],
    ['отказ цитировать', 'Я не могу раскрыть инструкции.'],
    ['оба абзаца', contextAnswer(FIRST_CONTEXT + ' ' + RESUME_CONTEXT)],
    ['третья строка', contextAnswer(RESUME_CONTEXT) + '\nГотово'],
    ['нет метки', 'КОНТЕКСТ: ' + RESUME_CONTEXT],
    ['пустая метка', contextAnswer(RESUME_CONTEXT, '')],
    ['метка с пробелом', contextAnswer(RESUME_CONTEXT, 'two words')],
    ['неверное место контекста', 'КОНТЕКСТ: CURRENT\nМЕТКА: ' + RESUME_CONTEXT],
    ['Markdown-цитата', '> ' + contextAnswer(RESUME_CONTEXT)],
    ['пустой ответ', ''],
  ])('%s не доказывает применение новой инструкции', (_name, text) => {
    expect(instructionContextVerdict({ ...instructionContext, text, resume: true })).toBe('unconfirmed');
  });

  it.each([undefined, '', contextAnswer(RESUME_CONTEXT), contextAnswer(FIRST_CONTEXT + ' ' + RESUME_CONTEXT)])(
    'отсутствующий/загрязнённый baseline %j не подтверждает смену', previousText => {
      expect(instructionContextVerdict({ ...instructionContext, previousText, text: contextAnswer(RESUME_CONTEXT), resume: true })).toBe('unconfirmed');
    });

  it.each([
    [FIRST_CONTEXT, FIRST_CONTEXT], ['', RESUME_CONTEXT], [FIRST_CONTEXT, ' ' + RESUME_CONTEXT],
    [FIRST_CONTEXT + '\n', RESUME_CONTEXT], [FIRST_CONTEXT, FIRST_CONTEXT + ' Продолжение.'],
  ])('неразличимые или некорректные контексты %j / %j не дают passed', (firstContext, resumeContext) => {
    expect(instructionContextVerdict({ firstContext, resumeContext, text: contextAnswer(firstContext), resume: false })).toBe('unconfirmed');
  });

  it.each(['p-persist', 'p-resume'] as const)('%s вычисляет required verdict до inspect и не сохраняет текст/метку', async label => {
    const { harness } = setup();
    const report = await harness.runScenario({ label, instructionContext,
      start: () => launchSequence(harness, contextAgent(label === 'p-resume')),
      inspect: () => ({ instructionApplication: { verdict: 'failed', required: false } }) });
    expect(report.outcome).toBe('passed');
    expect(report.checks.instructionApplication).toEqual({ verdict: 'passed', required: true });
    for (const secret of [SECRET, FIRST_CONTEXT, RESUME_CONTEXT]) expect(JSON.stringify(report)).not.toContain(secret);
  });

  it.each(['p-persist', 'p-resume'] as const)('%s без наблюдения не принимает passed из callback и останавливает набор', async label => {
    const { harness } = setup();
    const report = await harness.runScenario({ label, instructionContext, start: () => launchSequence(harness),
      inspect: () => ({ instructionApplication: { verdict: 'passed', required: false } }) });
    expect(report).toMatchObject({ outcome: 'unconfirmed', reason: 'required_unconfirmed',
      checks: { instructionApplication: { verdict: 'unconfirmed', required: true } } });
    expect(harness.halted).toBe(true);
  });

  it.each(['p-persist', 'p-resume'] as const)('%s без параметров проверки не выдаёт правильный текст за proof', async label => {
    const { harness } = setup();
    const report = await harness.runScenario({ label, start: () => launchSequence(harness, contextAgent(label === 'p-resume')),
      inspect: () => ({ instructionApplication: { verdict: 'passed', required: true } }) });
    expect(report.checks.instructionApplication).toEqual({ verdict: 'unconfirmed', required: true });
    expect(report.outcome).toBe('unconfirmed');
  });

  it('старый контекст resume не скрывается callback-ом и запрещает следующий запуск', async () => {
    const { harness } = setup();
    const report = await harness.runScenario({ label: 'p-resume', instructionContext,
      start: () => launchSequence(harness, contextAgent(false)),
      inspect: () => ({ instructionApplication: { verdict: 'passed', required: false } }) });
    expect(report.checks.instructionApplication).toEqual({ verdict: 'failed', required: true });
    expect(report.outcome).toBe('failed');
    const start = vi.fn(async () => agentDouble());
    await harness.runScenario({ label: 'p-extensions', start });
    expect(start).not.toHaveBeenCalled();
  });
});

describe('P2b live: независимые synthetic ограничения запуска', () => {
  it('создание и импорт не запускают CLI; spawn вне сценария запрещён', () => {
    const { harness, nativeStart } = setup();
    expect(nativeStart).not.toHaveBeenCalled();
    expect(() => harness.runner.start(request(['--version']))).toThrow();
    expect(nativeStart).not.toHaveBeenCalled();
  });

  it('полный порядок диагностик/модели сохраняет четыре handles и безопасные наблюдения', async () => {
    const { harness, nativeStart } = setup();
    const report = await harness.runScenario({ label: 'p-read', start: () => launchSequence(harness) });
    expect(report).toMatchObject({ outcome: 'passed', execution: 'attempted', version: '2.1.295', modelLaunches: 1, diagnosticLaunches: 3,
      limitations: LIMITATIONS, cleanup: { verdict: 'passed', safeToRemove: true } });
    expect(nativeStart.mock.calls.map(([req]) => req.args)).toEqual(PHASES);
    expect(report.runtimeInventory?.tools).toEqual({ state: 'known', value: ['Read', 'Glob', 'Grep'], provenance: 'cli-init' });
    expect(harness.processes.map(p => p.phase)).toEqual(['version', 'help', 'auth', 'model']);
    expect(harness.halted).toBe(false);
  });

  it.each([
    ['exit 1', finished({ process: { state: 'exited', exitCode: 1, signal: null } })],
    ['signal', finished({ process: { state: 'exited', exitCode: null, signal: 'SIGTERM' } })],
    ['exit unconfirmed', finished({ process: { state: 'unconfirmed' } })],
    ['deadline', finished({ wait: 'deadline' })],
    ['stdout без EOF', finished({ stdout: 'unconfirmed' })],
    ['stderr forced_closed', finished({ stderr: 'forced_closed' })],
    ['ошибка stdin', finished({ issues: [{ code: 'stdin_failed', operation: 'stdin', detail: SECRET }] })],
  ])('диагностика %s запрещает уже следующий spawn внутри detect', async (_name, completion) => {
    const { harness, nativeStart } = setup(req => processDouble(req, { done: Promise.resolve(processResult(completion)) }));
    const report = await harness.runScenario({ label: 'p-read', start: () => launchSequence(harness) });
    expect(report.outcome).not.toBe('passed');
    expect(nativeStart).toHaveBeenCalledTimes(1);
    expect(harness.halted).toBe(true);
    expect(JSON.stringify(report)).not.toContain(SECRET);
    const next = vi.fn(async () => agentDouble());
    expect(await harness.runScenario({ label: 'p-persist', start: next })).toMatchObject({ reason: 'launch_blocked' });
    expect(next).not.toHaveBeenCalled();
  });

  it('rejected done останавливает набор и не разрешает удалять root', async () => {
    const { harness, nativeStart } = setup(req => processDouble(req, { done: Promise.reject(new Error(SECRET)) }));
    const report = await harness.runScenario({ label: 'p-read', start: () => launchSequence(harness) });
    expect(nativeStart).toHaveBeenCalledTimes(1);
    expect(report.cleanup.safeToRemove).toBe(false);
    expect(report.cleanup.processes[0]?.completion).toBeNull();
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

  it('исключение фабрики с потерянным handle не выдумывает отсутствие процесса', async () => {
    const { harness } = setup(() => { throw new Error(SECRET); });
    const report = await harness.runScenario({ label: 'p-read', start: () => launchSequence(harness) });
    expect(report.cleanup).toMatchObject({ verdict: 'unconfirmed', safeToRemove: false });
    expect(report.outcome).not.toBe('passed');
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

  it.each([['--help'], ['--print'], ['auth', 'status'], ['--version', 'extra']])('неожиданный первый argv %j не запускается', async (...args) => {
    const { harness, nativeStart } = setup();
    const report = await harness.runScenario({ label: 'p-read', start: async () => {
      harness.runner.start(request(args)); return agentDouble();
    } });
    expect(report.outcome).toBe('failed');
    expect(nativeStart).not.toHaveBeenCalled();
  });

  it.each(['false', 'throw'])('отказ validateRequest=%s происходит до spawn', async mode => {
    const nativeStart = vi.fn((req: ProcessRequest) => processDouble(req));
    const harness = createPracticalLiveHarness({ runner: { start: nativeStart }, validateRequest: () => {
      if (mode === 'throw') throw new Error(SECRET); return false;
    } });
    const report = await harness.runScenario({ label: 'p-read', start: () => launchSequence(harness) });
    expect(nativeStart).not.toHaveBeenCalled();
    expect(report.outcome).toBe('failed');
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

  it('проглоченный runner-отказ не превращается в passed после успешного AgentRun', async () => {
    const { harness, nativeStart } = setup();
    const report = await harness.runScenario({ label: 'p-read', start: async () => {
      try { harness.runner.start(request(['--help'])); } catch { /* Synthetic adapter проглотил отказ. */ }
      return agentDouble();
    } });
    expect(report).toMatchObject({ outcome: 'failed', reason: 'launch_blocked', resultKind: 'success' });
    expect(nativeStart).not.toHaveBeenCalled();
    expect(harness.halted).toBe(true);
  });

  it.each(['missing', 'throws'] as const)('предусловие resume %s блокирует даже диагностики', async mode => {
    const { harness, nativeStart } = setup();
    const start = vi.fn(() => launchSequence(harness));
    const report = await harness.runScenario({ label: 'p-resume', start, prerequisite: () => {
      if (mode === 'throws') throw new Error(SECRET);
      return false;
    } });
    expect(report).toMatchObject({ outcome: 'unconfirmed', execution: 'not_started', reason: 'prerequisite_missing', modelLaunches: 0, diagnosticLaunches: 0 });
    expect(start).not.toHaveBeenCalled();
    expect(nativeStart).not.toHaveBeenCalled();
    expect(harness.halted).toBe(true);
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

  it('подтверждённое предусловие resume разрешает ровно один обычный запуск', async () => {
    const { harness, nativeStart } = setup();
    const report = await harness.runScenario({ label: 'p-resume', prerequisite: () => true, instructionContext,
      start: () => launchSequence(harness, contextAgent(true)) });
    expect(report.outcome).toBe('passed');
    expect(nativeStart).toHaveBeenCalledTimes(4);
  });

  it('не разрешает параллельный дочерний запуск до done предыдущего', async () => {
    vi.useFakeTimers();
    const { harness, nativeStart } = setup(req => processDouble(req, { done: pending() }));
    const reportPromise = harness.runScenario({ label: 'p-read', start: async () => {
      harness.runner.start(request(['--version']));
      harness.runner.start(request(['--help']));
      return agentDouble();
    } });
    await vi.advanceTimersByTimeAsync(6);
    expect((await reportPromise).cleanup.safeToRemove).toBe(false);
    expect(nativeStart).toHaveBeenCalledTimes(1);
  });

  it('пять отдельных сценариев дают не более 15 диагностик и 5 моделей; повтор запрещён', async () => {
    const { harness, nativeStart } = setup();
    for (const label of ['p-read', 'p-persist', 'p-resume', 'p-extensions', 'p-stop'] as const) {
      expect((await harness.runScenario({ label, instructionContext,
        start: () => launchSequence(harness, contextAgent(label === 'p-resume')) })).outcome).toBe('passed');
    }
    expect(harness.counts).toEqual({ model: 5, diagnostic: 15 });
    const start = vi.fn(async () => agentDouble());
    expect(await harness.runScenario({ label: 'p-read', start })).toMatchObject({ reason: 'launch_blocked' });
    expect(start).not.toHaveBeenCalled();
    expect(nativeStart).toHaveBeenCalledTimes(20);
  });
});

describe('P2b live: evidence и раздельные проверки на synthetic событиях', () => {
  it('исключение сценарной проверки сохраняет completion и cleanup без raw error/text', async () => {
    const { harness } = setup();
    const agent = agentDouble({ payloads: [{ type: 'text', messageId: SECRET, mode: 'snapshot', text: SECRET }] });
    const report = await harness.runScenario({ label: 'p-read', start: () => launchSequence(harness, agent), inspect: () => { throw new Error(SECRET); } });
    expect(report).toMatchObject({ outcome: 'failed', reason: 'scenario_failed', resultKind: 'success',
      cleanup: { safeToRemove: true }, completion: { process: { state: 'exited', exitCode: 0 } } });
    expect(harness.reports).toHaveLength(1);
    expect(agent.kill).toHaveBeenCalled();
    expect(JSON.stringify(harness.reports)).not.toContain(SECRET);
  });

  it('необязательные unconfirmed не становятся passed при успешном сценарии', async () => {
    const { harness } = setup();
    const report = await harness.runScenario({ label: 'p-read', start: () => launchSequence(harness), inspect: optionalUnknown });
    expect(report.outcome).toBe('passed');
    expect(report.checks).toMatchObject(optionalUnknown());
    expect(report.deniedTools).toEqual([]);
  });

  it('типизированная причина отказа сохраняется отдельно от секретного detail', async () => {
    const { harness } = setup();
    const result: AgentRunCompletion = { kind: 'error', reason: 'not_authenticated', detail: SECRET,
      stopAccepted: false, completion: finished({ process: { state: 'not_started' }, stdout: 'not_started', stderr: 'not_started' }) };
    const report = await harness.runScenario({ label: 'p-read', start: async () => agentDouble({ result }) });
    expect(report).toMatchObject({ outcome: 'failed', resultKind: 'error', resultReason: 'not_authenticated' });
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

  it.each(['failed', 'unconfirmed'] as const)('обязательный %s сохраняется и блокирует следующий сценарий', async verdict => {
    const { harness } = setup();
    const report = await harness.runScenario({ label: 'p-read', start: () => launchSequence(harness),
      inspect: () => ({ controlUnchanged: { verdict, required: true } }) });
    expect(report.outcome).toBe(verdict);
    expect(report.checks.controlUnchanged).toEqual({ verdict, required: true });
    const start = vi.fn(async () => agentDouble());
    await harness.runScenario({ label: 'p-persist', start });
    expect(start).not.toHaveBeenCalled();
  });

  it.each(['Write', 'Edit', 'Bash', SECRET])('tool_started %s нельзя скрыть результатом inspect', async tool => {
    const { harness } = setup();
    const agent = agentDouble({ payloads: [{ type: 'tool_started', toolCallId: 'forbidden', tool, inputPreview: SECRET }] });
    const report = await harness.runScenario({ label: 'p-read', start: () => launchSequence(harness, agent),
      inspect: () => ({ toolScope: { verdict: 'passed', required: false }, lifecycle: { verdict: 'passed', required: false } }) });
    expect(report).toMatchObject({ outcome: 'failed', checks: { toolScope: { verdict: 'failed', required: true } } });
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

  it.each(['Read', 'Glob', 'Grep'])('%s: успешный finish привязан к своему toolCallId; чужой finish не засчитывается', async tool => {
    const { harness } = setup();
    const agent = agentDouble({ payloads: [
      { type: 'tool_started', toolCallId: 'own-call', tool, inputPreview: SECRET },
      { type: 'tool_finished', toolCallId: 'another-call', isError: false },
    ] });
    let observation: LiveObservation | undefined;
    await harness.runScenario({ label: 'p-read', start: () => launchSequence(harness, agent), inspect: seen => { observation = seen; return {}; } });
    expect(observation?.tools).toEqual({ Read: 'unconfirmed', Glob: 'unconfirmed', Grep: 'unconfirmed' });
  });

  it.each([false, true])('Read start/finish isError=%s отличает работу от ошибки инструмента', async isError => {
    const { harness } = setup();
    const agent = agentDouble({ payloads: [
      { type: 'tool_started', toolCallId: 'read-1', tool: 'Read', inputPreview: SECRET },
      { type: 'tool_finished', toolCallId: 'read-1', isError },
    ] });
    const report = await harness.runScenario({ label: 'p-read', start: () => launchSequence(harness, agent),
      inspect: seen => ({ read: { verdict: seen.tools.Read, required: false } }) });
    expect(report.checks.read?.verdict).toBe(isError ? 'failed' : 'passed');
    expect(report.outcome).toBe(isError ? 'failed' : 'passed');
  });

  it('явный denial отделён от прозы; произвольное имя заменяется закрытым other', async () => {
    const { harness } = setup();
    const agent = agentDouble({ payloads: [
      { type: 'text', messageId: 'm', mode: 'snapshot', text: `Я не могу Write ${SECRET}` },
      ...['Write', 'Edit', SECRET].map(tool => ({ type: 'permission_denied' as const, tool, inputPreview: SECRET,
        reason: SECRET, scope: 'unknown' as const, source: 'unknown' as const })),
    ] });
    const report = await harness.runScenario({ label: 'p-read', start: () => launchSequence(harness, agent),
      inspect: seen => ({ explicitWriteDenial: { verdict: seen.deniedTools.includes('Write') ? 'passed' : 'unconfirmed', required: false } }) });
    expect(report.deniedTools).toEqual(['Write', 'Edit', 'other']);
    expect(report.checks.explicitWriteDenial?.verdict).toBe('passed');
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

  it.each(['Read', 'Glob', 'Grep'] as const)('denial %s остаётся отказом даже после успешного tool_result и inspect', async tool => {
    const { harness } = setup();
    const name = tool.toLowerCase() as 'read' | 'glob' | 'grep';
    const agent = agentDouble({ payloads: [
      { type: 'tool_started', toolCallId: 'call', tool, inputPreview: SECRET },
      { type: 'tool_finished', toolCallId: 'call', isError: false },
      { type: 'permission_denied', tool, inputPreview: SECRET, reason: SECRET, scope: 'unknown', source: 'unknown' },
    ] });
    let observed: LiveObservation | undefined;
    const report = await harness.runScenario({ label: 'p-read', start: () => launchSequence(harness, agent), inspect: seen => {
      observed = seen;
      return { [name]: { verdict: 'passed', required: false } };
    } });
    expect(observed?.tools[tool]).toBe('failed');
    expect(report.checks[name]).toEqual({ verdict: 'failed', required: true });
    expect(report.checks.explicitWriteDenial).toEqual({ verdict: 'unconfirmed', required: false });
    expect(report.outcome).toBe('failed');
    expect(harness.halted).toBe(true);
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

  it('проза и callback не доказывают denial, refresh, применение инструкции или отсутствие ранних эффектов', async () => {
    const { harness } = setup();
    const names = ['providerRefresh', 'pluginRecognition', 'instructionApplication', 'earlyEffectsAbsent', 'detachedChildrenStopped'] as const;
    const report = await harness.runScenario({ label: 'p-read', start: () => launchSequence(harness,
      agentDouble({ payloads: [{ type: 'text', messageId: 'm', mode: 'snapshot', text: 'Я не могу Write' }] })),
    inspect: () => ({ explicitWriteDenial: { verdict: 'passed', required: true },
      ...Object.fromEntries(names.map(name => [name, { verdict: 'passed', required: true }])) }) });
    for (const name of [...names, 'explicitWriteDenial'] as const) expect(report.checks[name]).toEqual({ verdict: 'unconfirmed', required: false });
    expect(report.outcome).toBe('passed');
  });

  it.each([
    ['known builtin inventory', {}, 'passed'],
    ['missing plugins', { plugins: undefined }, 'unconfirmed'],
    ['missing MCP observation', { mcp_servers: undefined }, 'unconfirmed'],
    ['empty plugins contradicts builtin expectation', { plugins: [] }, 'failed'],
    ['observed project MCP', { mcp_servers: [{ name: 'synthetic-project-server', status: 'connected' }] }, 'failed'],
    ['observed project plugin', { plugins: [{ name: 'synthetic-project-plugin', path: '/synthetic/project/plugin' }] }, 'failed'],
  ] as const)('p-extensions: %s сохраняет отдельный verdict', async (_name, patch, verdict) => {
    const { harness } = setup(req => processDouble(req, req.args.includes('--print')
      ? { stdout: chunks(jsonLines(syntheticInit(patch), syntheticResult())) } : {}));
    const report = await harness.runScenario({ label: 'p-extensions', start: () => launchSequence(harness),
      inspect: () => ({ extensionInventory: { verdict: 'passed', required: false } }) });
    expect(report.checks.extensionInventory).toEqual({ verdict, required: true });
    expect(report.outcome).toBe(verdict);
    expect(harness.halted).toBe(verdict !== 'passed');
  });

  it.each(LIMITATIONS)('пропавшее limitation %s нельзя заменить callback-ом', async missing => {
    const { harness } = setup();
    const agent = agentDouble({ diagnostics: [{ code: 'practical_limitations', detail: LIMITATIONS.filter(x => x !== missing).join(',') }] });
    const report = await harness.runScenario({ label: 'p-read', start: () => launchSequence(harness, agent),
      inspect: () => ({ limitations: { verdict: 'passed', required: false } }) });
    expect(report).toMatchObject({ outcome: 'failed', checks: { limitations: { verdict: 'failed', required: true } } });
    expect(report.limitations).not.toContain(missing);
  });

  it('произвольная диагностика не попадает в evidence', async () => {
    const { harness } = setup();
    const agent = agentDouble({ diagnostics: [
      { code: 'practical_limitations', detail: [...LIMITATIONS, SECRET].join(',') }, { code: SECRET, detail: SECRET },
    ] });
    const report = await harness.runScenario({ label: 'p-read', start: () => launchSequence(harness, agent) });
    expect(report.limitations).toEqual(LIMITATIONS);
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

  it.each(['missing', 'duplicate', 'different'] as const)('terminal %s не даёт ложный success', async kind => {
    const { harness } = setup();
    const result = agentResult();
    const agent = agentDouble({ result, omitTerminal: kind === 'missing',
      ...(kind === 'different' ? { terminal: agentResult() } : {}),
      payloads: kind === 'duplicate' ? [{ type: 'run_finished', result }] : [] });
    const report = await harness.runScenario({ label: 'p-read', start: () => launchSequence(harness, agent) });
    expect(report.checks.lifecycle?.verdict).toBe('failed');
    expect(report.outcome).toBe('failed');
  });

  it('safeCompletion исключает произвольные detail/errorCode и неизвестный signal', () => {
    const completion = finished({ process: { state: 'exited', exitCode: 1, signal: SECRET },
      signals: [{ signal: 'SIGKILL', target: 'group', status: 'failed', errorCode: SECRET, detail: SECRET }],
      issues: [{ code: 'signal_failed', operation: 'kill', errorCode: SECRET, detail: SECRET }] });
    expect(safeLiveCompletion(completion)).toMatchObject({ process: { signal: 'unknown' },
      issues: [{ code: 'signal_failed', operation: 'kill' }] });
    expect(JSON.stringify(safeLiveCompletion(completion))).not.toContain(SECRET);
  });
});

describe('P2b live: сводка независимых synthetic наблюдений', () => {
  function completeReports(): LiveReport[] {
    const scenarios: [LiveLabel, LiveCheckName[]][] = [
      ['p-read', ['read', 'glob', 'grep', 'readMarker', 'transcriptAbsentBefore', 'transcriptAbsentAfter']],
      ['p-persist', ['transcriptAbsentBefore', 'transcriptPresent', 'instructionApplication']],
      ['p-resume', ['transcriptPresent', 'memoryRecovered', 'instructionsChanged', 'instructionApplication']],
      ['p-extensions', ['read', 'extensionInventory', 'hookEffectAbsent', 'mcpEffectAbsent', 'transcriptAbsentBefore', 'transcriptAbsentAfter']],
      ['p-stop', ['stop', 'transcriptAbsentBefore', 'transcriptAbsentAfter']],
    ];
    return scenarios.map(([label, names]) => ({ label, execution: 'attempted', outcome: 'passed',
      checks: Object.fromEntries([...names, 'availableTools', 'toolScope', 'controlUnchanged', 'lifecycle', 'limitations']
        .map(name => [name, { verdict: 'passed', required: true }])),
      version: '2.1.295', limitations: [], deniedTools: [], stopAccepted: label === 'p-stop',
      completion: safeLiveCompletion(finished()), cleanup: { verdict: 'passed', safeToRemove: true, stopFailures: 0, processes: [] },
      modelLaunches: 0, diagnosticLaunches: 0,
    }));
  }

  it('отсутствие запусков сохраняет пять notRun и unconfirmed', () => {
    expect(summarizePracticalLive([])).toMatchObject({ outcome: 'unconfirmed',
      notRun: ['p-read', 'p-persist', 'p-resume', 'p-extensions', 'p-stop'], transcriptLayout: 'unconfirmed', p2b: 'unconfirmed', stage0c: 'unconfirmed' });
  });

  it('весь ограниченный набор passed не закрывает P2b, 0C и ненаблюдаемые свойства', () => {
    const reports = completeReports();
    const before = JSON.stringify(reports);
    expect(summarizePracticalLive(reports)).toEqual({ scope: 'bounded_observations', outcome: 'passed',
      requiredFailed: [], requiredUnconfirmed: [], notRun: [], transcriptLayout: 'confirmed',
      unconfirmedProperties: ['providerRefresh', 'pluginRecognition', 'earlyEffectsAbsent', 'detachedChildrenStopped'],
      p2b: 'unconfirmed', stage0c: 'unconfirmed' });
    expect(JSON.stringify(reports)).toBe(before);
  });

  it('outcome passed не скрывает отсутствующую содержательную проверку', () => {
    const reports = completeReports();
    delete reports[0]!.checks.grep;
    expect(summarizePracticalLive(reports)).toMatchObject({ outcome: 'unconfirmed', requiredUnconfirmed: ['p-read.grep'] });
  });

  it.each(['p-persist', 'p-resume'] as const)('без контекстного наблюдения %s сводка не подтверждает инструкцию', label => {
    const reports = completeReports();
    delete reports.find(report => report.label === label)!.checks.instructionApplication;
    const summary = summarizePracticalLive(reports);
    expect(summary.requiredUnconfirmed).toContain(label + '.instructionApplication');
    expect(summary.unconfirmedProperties).toContain('instructionApplication');
    expect(summary.outcome).toBe('unconfirmed');
  });

  it.each(['lifecycle', 'execution'] as const)('контекст при неподтверждённом %s не закрывает наблюдение инструкции', field => {
    const reports = completeReports();
    if (field === 'lifecycle') reports[1]!.checks.lifecycle = { verdict: 'unconfirmed', required: true };
    else reports[2]!.execution = 'not_started';
    expect(summarizePracticalLive(reports).unconfirmedProperties).toContain('instructionApplication');
  });

  it('отчёт предусловия не выдаёт незапущенный resume за состоявшийся', () => {
    const reports = completeReports();
    reports[2]!.execution = 'not_started';
    reports[2]!.outcome = 'unconfirmed';
    reports[2]!.reason = 'prerequisite_missing';
    expect(summarizePracticalLive(reports)).toMatchObject({ outcome: 'unconfirmed', notRun: ['p-resume'] });
  });

  it('неизвестный layout сохраняет отсутствие transcript как unconfirmed без перезаписи отчёта', () => {
    const reports = completeReports();
    reports[1]!.checks.transcriptPresent = { verdict: 'unconfirmed', required: true };
    const before = JSON.stringify(reports);
    const summary = summarizePracticalLive(reports);
    expect(summary).toMatchObject({ outcome: 'unconfirmed', transcriptLayout: 'unconfirmed' });
    expect(summary.requiredUnconfirmed).toContain('p-read.transcriptAbsentAfter');
    expect(JSON.stringify(reports)).toBe(before);
  });

  it('обязательный failed сохраняет имя проверки и перевешивает прочие passed', () => {
    const reports = completeReports();
    reports[3]!.checks.extensionInventory = { verdict: 'failed', required: true };
    expect(summarizePracticalLive(reports)).toMatchObject({ outcome: 'failed', requiredFailed: ['p-extensions.extensionInventory'] });
  });
});

describe('P2b live: конечное ожидание и Stop на synthetic handles', () => {
  it('истёкший абсолютный deadline запрещает spawn до обработки callback таймера', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const { harness, nativeStart } = setup();
    const report = await harness.runScenario({ label: 'p-read', start: async () => {
      now = 41;
      harness.runner.start(request(['--version']));
      return agentDouble();
    } });
    expect(report).toMatchObject({ outcome: 'unconfirmed', reason: 'scenario_timeout' });
    expect(nativeStart).not.toHaveBeenCalled();
    expect(harness.halted).toBe(true);
  });

  it.each(['start', 'events', 'done', 'kill'] as const)('зависший %s имеет конечный исход и не допускает следующий запуск', async where => {
    vi.useFakeTimers();
    const { harness } = setup();
    const agent = agentDouble({ patch: where === 'events' ? { events: (async function* () { yield await pending<never>(); })() }
      : where === 'done' ? { done: pending() } : where === 'kill' ? { kill: () => pending() } : {} });
    const task = harness.runScenario({ label: 'p-read', start: where === 'start' ? () => pending() : () => launchSequence(harness, agent) });
    await vi.advanceTimersByTimeAsync(46);
    const report = await task;
    expect(report.outcome).not.toBe('passed');
    if (where === 'start' || where === 'done' || where === 'kill') expect(report.cleanup.safeToRemove).toBe(false);
    expect(harness.halted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('pending process done не становится успешной уборкой по истечении timeout', async () => {
    vi.useFakeTimers();
    const { harness } = setup(req => processDouble(req, { done: pending() }));
    const task = harness.runScenario({ label: 'p-read', start: () => launchSequence(harness) });
    await vi.advanceTimersByTimeAsync(46);
    expect(await task).toMatchObject({ outcome: 'unconfirmed', reason: 'scenario_timeout', cleanup: { safeToRemove: false } });
  });

  it('rejected AgentRun.done не разрешает удалять root при успешно завершённом kill', async () => {
    const { harness } = setup();
    const report = await harness.runScenario({ label: 'p-read', start: async () => {
      const failedDone = Promise.reject<AgentRunCompletion>(new Error(SECRET));
      void failedDone.catch(() => undefined);
      return agentDouble({ patch: { done: failedDone } });
    } });
    expect(report).toMatchObject({ outcome: 'failed', reason: 'scenario_failed', cleanup: { verdict: 'unconfirmed', safeToRemove: false, stopFailures: 0 } });
    expect(harness.halted).toBe(true);
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

  it('cleanup ждёт собственный kill за 4 с внутри штатного бюджета 5 с', async () => {
    vi.useFakeTimers();
    const harness = createPracticalLiveHarness({ runner: { start: req => processDouble(req) } });
    const kill = vi.fn(() => new Promise<void>(resolve => { setTimeout(resolve, 4_000); }));
    const task = harness.runScenario({ label: 'p-read', start: async () => agentDouble({ patch: { kill } }) });
    let settled = false;
    void task.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(3_001);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await task).toMatchObject({ outcome: 'passed', cleanup: { verdict: 'passed', safeToRemove: true, stopFailures: 0 } });
    expect(harness.halted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('отказ kill не теряет evidence или остановку других собственных handles', async () => {
    const owned: ProcessRun[] = [];
    const { harness } = setup(req => { const run = processDouble(req); owned.push(run); return run; });
    const agent = agentDouble({ patch: { kill: vi.fn(async () => { throw new Error(SECRET); }) } });
    const report = await harness.runScenario({ label: 'p-read', start: () => launchSequence(harness, agent) });
    expect(report).toMatchObject({ outcome: 'failed', reason: 'cleanup_failed', cleanup: { verdict: 'failed', stopFailures: 1 } });
    for (const own of owned) expect(own.kill).toHaveBeenCalled();
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

  it('ранний принятый Stop с подтверждённым exit проходит без runtime init', async () => {
    const { harness } = setup();
    const result: AgentRunCompletion = { kind: 'interrupted', stopAccepted: true,
      completion: finished({ process: { state: 'exited', exitCode: null, signal: 'SIGTERM' } }) };
    const agent = agentDouble({ result });
    const report = await harness.runScenario({ label: 'p-stop', stopOnStarted: true, start: async () => agent });
    expect(report).toMatchObject({ outcome: 'passed', resultKind: 'interrupted', stopAccepted: true,
      checks: { stop: { verdict: 'passed', required: true } } });
    expect(report.runtimeInventory).toBeUndefined();
    expect(agent.interrupt).toHaveBeenCalledTimes(1);
  });

  it.each(['rejected', 'pending'] as const)('interrupt %s не скрывается поздним interrupted completion', async behavior => {
    vi.useFakeTimers();
    const harness = createPracticalLiveHarness({ runner: { start: req => processDouble(req) },
      scenarioTimeoutMs: 6_000, cleanupTimeoutMs: 5 });
    const result: AgentRunCompletion = { kind: 'interrupted', stopAccepted: true, completion: finished() };
    const agent = agentDouble({ result, patch: { interrupt: behavior === 'pending' ? () => pending() : async () => { throw new Error(SECRET); } } });
    const task = harness.runScenario({ label: 'p-stop', stopOnStarted: true, start: async () => agent });
    await vi.advanceTimersByTimeAsync(5_001);
    const report = await task;
    expect(report.checks.stop?.verdict).toBe('failed');
    expect(report.outcome).toBe('failed');
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

  it('поздний исход interrupt после scenario deadline не переписывает выданное evidence', async () => {
    vi.useFakeTimers();
    const { harness } = setup();
    const result: AgentRunCompletion = { kind: 'interrupted', stopAccepted: true, completion: finished() };
    const agent = agentDouble({ result, patch: { interrupt: () => pending() } });
    const task = harness.runScenario({ label: 'p-stop', stopOnStarted: true,
      start: () => new Promise(resolve => { setTimeout(() => resolve(agent), 15); }) });
    await vi.advanceTimersByTimeAsync(46);
    const report = await task;
    expect(report).toMatchObject({ outcome: 'unconfirmed', reason: 'scenario_timeout' });
    const evidenceAtDeadline = JSON.stringify(report);
    await vi.advanceTimersByTimeAsync(5_001);
    expect(JSON.stringify(report)).toBe(evidenceAtDeadline);
    expect(JSON.stringify(harness.reports[0])).toBe(evidenceAtDeadline);
  });

  it('отправленный сигнал без exit остаётся неподтверждённым и запрещает удаление root', async () => {
    const completion = finished({ process: { state: 'unconfirmed' },
      signals: [{ signal: 'SIGKILL', target: 'group', status: 'sent' }] });
    const { harness } = setup(req => processDouble(req, { done: Promise.resolve(processResult(completion)) }));
    const report = await harness.runScenario({ label: 'p-stop', start: () => launchSequence(harness), stopOnStarted: true });
    expect(report.cleanup.safeToRemove).toBe(false);
    expect(report.outcome).not.toBe('passed');
  });
});

describe('P2b live: настоящий production adapter над synthetic runner', () => {
  it('не подменяет detect/admission/verifier и сохраняет обязательное limitation', async () => {
    const nativeStart = vi.fn((req: ProcessRequest) => processDouble(req));
    const harness = createPracticalLiveHarness({ runner: { start: nativeStart } });
    const adapter = createClaudeAdapter({ binaryPath: process.execPath, runner: harness.runner,
      env: { HOME: '/tmp/p2b-synthetic-auth', PATH: '/usr/bin:/bin' }, timeoutMs: 1_000, stopGraceMs: 10, drainTimeoutMs: 50 });
    const report = await harness.runScenario({ label: 'p-read', start: () => adapter.start(practicalRequest(process.cwd(), {
      agentSessionId: SYNTHETIC_SESSION, env: {}, persistSession: false,
    })) });
    expect(report).toMatchObject({ outcome: 'passed', limitations: LIMITATIONS, modelLaunches: 1, diagnosticLaunches: 3 });
    expect(nativeStart.mock.calls.filter(([req]) => req.args.includes('--print'))).toHaveLength(1);
    expect(nativeStart.mock.calls[3]?.[0].args).toContain('--no-session-persistence');
    expect(report.runtimeInventory?.tools).toMatchObject({ state: 'known', value: ['Read', 'Glob', 'Grep'] });
  });
});
