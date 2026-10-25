import { readFileSync, realpathSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { buildCodexArgs } from '../../src/adapters/codex/args.ts';
import { createCodexAdapter } from '../../src/adapters/codex/index.ts';
import type { CodexRunRequest } from '../../src/adapters/codex/contracts.ts';
import { buildAgentInstructions } from '../../src/core/agent-instructions.ts';
import type { AgentRunCompletion } from '../../src/core/ports/agent.ts';
import type { ProcessRequest, ProcessRunner } from '../../src/core/ports/process-runner.ts';
import { createCodexLiveHarness } from '../helpers/codex/live-harness.ts';
import type { Observation } from '../helpers/codex/live-harness.ts';
import { expectedCodexLaunches, firstChecks, firstPrompt, instructionVerdict, policyChecks, POLICY_PROMPT, RESUME_PROMPT, resumeChecks } from '../helpers/codex/live-plan.ts';
import { cleanCompletion, processResult } from '../helpers/codex/process-double.ts';
import { firstRequest, resumeRequest, sandboxFirstRequest, sandboxResumeRequest, SYNTHETIC_ADMISSION,
  SYNTHETIC_SANDBOX_ADMISSION, THREAD } from '../helpers/codex/requests.ts';

const MEMORY = 'SYNTHETIC-MEMORY-ONLY-IN-FIRST-PROMPT';
const READ = 'SYNTHETIC-READ-ONLY-IN-FILE';
const FIRST = buildAgentInstructions({ resume: false }).split('\n\n')[0]!;
const RESUME = buildAgentInstructions({ resume: true }).split('\n\n')[0]!;
const firstText = `КОНТЕКСТ: ${FIRST}\nЧТЕНИЕ: ${READ}\nПАМЯТЬ: ${MEMORY}`;
const resumeText = `КОНТЕКСТ: ${RESUME}\nПАМЯТЬ: ${MEMORY}`;
const success: AgentRunCompletion = { kind: 'success', stopAccepted: false, completion: cleanCompletion() };
const observation = (text: string, patch: Partial<Observation> = {}): Observation =>
  ({ text, threadIds: [THREAD], toolNames: [], deniedTools: [], result: success, stopAccepted: false, ...patch });
const execHelp = readFileSync(new URL('../fixtures/codex/synthetic-exec-help.txt', import.meta.url), 'utf8');
const resumeHelp = readFileSync(new URL('../fixtures/codex/synthetic-resume-help.txt', import.meta.url), 'utf8');
async function* bytes(text: string) { if (text) yield Buffer.from(text); }
const jsonl = (text: string): string => [
  { type: 'thread.started', thread_id: THREAD },
  { type: 'turn.started' },
  { type: 'item.completed', item: { type: 'agent_message', id: 'message', text } },
  { type: 'turn.completed', usage: { input_tokens: 4, output_tokens: 3, cached_input_tokens: 0 } },
].map(value => JSON.stringify(value)).join('\n') + '\n';
function syntheticRunner(): { runner: ProcessRunner; starts: ProcessRequest[] } {
  const starts: ProcessRequest[] = [];
  const runner: ProcessRunner = { start(request) {
    starts.push(request);
    const argv = request.args.join(' ');
    const out = argv === '--version' ? 'codex-cli 0.163.0\n'
      : argv === 'exec --help' ? execHelp
        : argv === 'exec resume --help' ? resumeHelp
          : argv === 'login status' ? ''
            : jsonl(request.args[1] === 'resume' ? resumeText : firstText);
    return { stdout: bytes(out), stderr: bytes(argv === 'login status' ? 'Logged in using ChatGPT\n' : ''),
      done: Promise.resolve(processResult()), interrupt: async () => {}, kill: async () => {} };
  } };
  return { runner, starts };
}

describe('Codex M: независимый manifest и смысл наблюдений', () => {
  it.each([false, true])('manifest отдельно фиксирует argv, env и все процессы, resume=%s', resume => {
    const request = resume ? resumeRequest('/synthetic/cwd') : firstRequest('/synthetic/cwd');
    const expected = expectedCodexLaunches('/synthetic/codex', request);
    expect(expected).toHaveLength(5);
    expect(expected.slice(0, 4).map(p => p.args)).toEqual([
      ['--version'], ['exec', '--help'], ['exec', 'resume', '--help'], ['login', 'status'],
    ]);
    expect(expected[4]!.args).toEqual(buildCodexArgs(request).args);
    expect(expected[4]!.stdin).toBe(request.prompt);
    expect(expected[4]!.env).toEqual(request.env);
    expect(expected[4]!.args).not.toContain('--last');
    expect(expected[4]!.args).not.toContain('--all');
    if (resume) expect(expected[4]!.args).not.toContain('--sandbox');
  });

  it.each([false, true])('manifest именованного профиля совпадает с builder, без legacy sandbox: resume=%s', resume => {
    const request = resume ? sandboxResumeRequest('/synthetic/cwd') : sandboxFirstRequest('/synthetic/cwd');
    const expected = expectedCodexLaunches('/synthetic/codex', request);
    expect(expected).toHaveLength(5);
    expect(expected.slice(0, 4).map(p => p.args)).toEqual([
      ['--version'], ['exec', '--help'], ['exec', 'resume', '--help'], ['login', 'status'],
    ]);
    expect(expected[4]!.args).toEqual(buildCodexArgs(request).args);
    expect(expected[4]!.args).not.toContain('--sandbox');
    expect(expected[4]!.args.some(arg => arg.startsWith('sandbox_mode='))).toBe(false);
    expect(expected[4]!.args).toContain('--strict-config');
    expect(expected[4]!.args).toContain('default_permissions="vibestudio-read-v1"');
    expect(expected[4]!.args).toContain('features.shell_tool=true');
    expect(expected[4]!.stdin).toBe(request.prompt);
  });

  it('метка сохранённой памяти отсутствует в resume prompt и контрольном файле', () => {
    expect(firstPrompt(MEMORY)).toContain(MEMORY);
    expect(firstPrompt(MEMORY)).not.toContain(READ);
    expect(RESUME_PROMPT).not.toContain(MEMORY);
    expect(RESUME_PROMPT).not.toContain(FIRST);
    expect(RESUME_PROMPT).not.toContain(RESUME);
  });

  it('полный первый и новый контекст проверяются по ответу, а не argv', () => {
    expect(firstChecks(observation(firstText), READ, MEMORY)).toMatchObject({
      read: 'passed', thread: 'passed', memory: 'passed', instruction: 'passed',
    });
    expect(resumeChecks(observation(resumeText), THREAD, MEMORY, true)).toEqual({
      thread: 'passed', memory: 'passed', history: 'passed', instruction: 'passed',
    });
    expect(instructionVerdict(firstText, true, 3)).toBe('failed');
    expect(instructionVerdict('КОНТЕКСТ: продолжаю\nПАМЯТЬ: ' + MEMORY, true, 2)).toBe('unconfirmed');
    expect(resumeChecks(observation(resumeText), THREAD, MEMORY, false).history).toBe('unconfirmed');
    expect(resumeChecks(observation(resumeText.replace(MEMORY, 'wrong')), THREAD, MEMORY, true).history).toBe('failed');
    expect(resumeChecks(observation(resumeText, { threadIds: [] }), THREAD, MEMORY, true).history).toBe('failed');
  });

  it('отсутствие событий и маркеров не подтверждает превентивную политику/выключение расширений', () => {
    expect(policyChecks(observation('ЧТЕНИЕ: ' + READ), READ, true)).toEqual({
      allowedRead: 'unconfirmed', forbiddenEffectAbsent: 'passed', toolPolicy: 'unconfirmed', extensionPolicy: 'unconfirmed',
    });
    expect(policyChecks(observation('ЧТЕНИЕ: ' + READ, { toolNames: ['command_execution'] }), READ, true).toolPolicy).toBe('failed');
    expect(policyChecks(observation('ЧТЕНИЕ: ' + READ), READ, false).forbiddenEffectAbsent).toBe('failed');
  });

  it('новый профиль разрешает класс shell, сохраняя неизвестность его ограничений', () => {
    const shell = observation('ЧТЕНИЕ: ' + READ, { toolNames: ['command_execution'] });
    expect(policyChecks(shell, READ, true, 'codex-sandbox-read-v1')).toEqual({
      allowedRead: 'unconfirmed', forbiddenEffectAbsent: 'passed', toolPolicy: 'unconfirmed', extensionPolicy: 'unconfirmed',
    });
    expect(policyChecks(shell, READ, true, 'codex-read-only-v1').toolPolicy).toBe('failed');
    expect(policyChecks({ ...shell, deniedTools: ['command_execution'] }, READ, true, 'codex-sandbox-read-v1').toolPolicy)
      .toBe('unconfirmed');
    expect(policyChecks(shell, READ, false, 'codex-sandbox-read-v1').forbiddenEffectAbsent).toBe('failed');
  });

  it.each(['file_change', 'mcp_tool_call', 'collab_tool_call', 'web_search', 'unknown_tool'])(
    'разрешённый shell не разрешает другой инструмент %s', tool => {
      const inspected = policyChecks(observation('ЧТЕНИЕ: ' + READ,
        { toolNames: ['command_execution', tool] }), READ, true, 'codex-sandbox-read-v1');
      expect(inspected.toolPolicy).toBe('failed');
      expect(inspected.extensionPolicy).toBe(['mcp_tool_call', 'collab_tool_call'].includes(tool) ? 'failed' : 'unconfirmed');
    });

  it('реальная точка входа без opt-in останавливается при импорте, до CLI и подготовки проекта', async () => {
    vi.stubEnv('LIVE', '0');
    vi.stubEnv('CODEX_LIVE', '0');
    try { await expect(import('../live/codex.live.ts')).rejects.toThrow('Codex M отключён'); }
    finally { vi.unstubAllEnvs(); }
  });

  it.each([false, true])('production-допуск отказывает после четырёх synthetic диагностик, без модели; named=%s', async named => {
    const fake = syntheticRunner();
    const harness = createCodexLiveHarness({ runner: fake.runner });
    const executable = realpathSync(process.execPath);
    const request = (named ? sandboxFirstRequest : firstRequest)('/synthetic/cwd', {
      env: { HOME: '/synthetic/home', PATH: '/usr/bin:/bin' },
    });
    const adapter = createCodexAdapter({ runner: harness.runner, binaryPath: executable, env: request.env,
      timeoutMs: 90_000, stopGraceMs: 2_000, drainTimeoutMs: 2_000 });
    const report = await harness.runScenario({ label: 'M1', expected: expectedCodexLaunches(executable, request),
      start: () => adapter.start(request), inspect: () => ({}) });
    expect(report.outcome).toBe('failed');
    expect(fake.starts).toHaveLength(4);
    expect(report.models).toBe(0);
    expect(report.resultReason).toBe(named ? 'practical_admission_blocked' : 'profile_unsupported');
    expect(report.cleanup.safeToRemove).toBe(true);
    expect(report.completion?.process.state).toBe('exited');
  });

  it.each([false, true])('synthetic M1/M2 проходят, но текущий M4 останавливает M5 без процессов; named=%s', async named => {
    const fake = syntheticRunner();
    const harness = createCodexLiveHarness({ runner: fake.runner });
    const executable = realpathSync(process.execPath);
    const request = (named ? sandboxFirstRequest : firstRequest)('/synthetic/cwd', { prompt: firstPrompt(MEMORY),
      env: { HOME: '/synthetic/home', PATH: '/usr/bin:/bin' } });
    const options = { runner: harness.runner, binaryPath: executable, env: request.env,
      timeoutMs: 90_000, stopGraceMs: 2_000, drainTimeoutMs: 2_000,
      assessAdmission: async () => named ? SYNTHETIC_SANDBOX_ADMISSION : SYNTHETIC_ADMISSION };
    const first = createCodexAdapter(options);
    expect((await harness.runScenario({ label: 'M1', expected: expectedCodexLaunches(executable, request),
      start: () => first.start(request), inspect: observed => firstChecks(observed, READ, MEMORY) })).outcome).toBe('passed');
    const next = { ...(named ? sandboxResumeRequest : resumeRequest)(request.cwd), env: request.env, prompt: RESUME_PROMPT };
    const second = createCodexAdapter({ ...options, verifyThread: binding => binding.threadId === THREAD
      && binding.sessionId === request.sessionId && binding.participantId === request.participantId
      && binding.workspaceId === request.workspaceId && binding.cwd === request.cwd });
    expect((await harness.runScenario({ label: 'M2', expected: expectedCodexLaunches(executable, next),
      start: () => second.start(next), inspect: observed => resumeChecks(observed, THREAD, MEMORY, true) })).outcome).toBe('passed');
    expect(fake.starts).toHaveLength(10);
    expect(fake.starts[9]!.stdin).not.toContain(MEMORY);
    expect(fake.starts[9]!.args.slice(-2)).toEqual([THREAD, '-']);
    const negatives = [
      ['M3-missing', { ...next, thread: { adapter: 'codex', threadId: '019a0000-0000-7000-8000-000000000099' } }],
      ['M3-foreign', { ...next, thread: { adapter: 'claude', threadId: THREAD } }],
      ['M3-binding', { ...next, participantId: 'foreign-participant' }],
    ] as const;
    for (const [label, invalid] of negatives) {
      const report = await harness.runScenario({ label, expected: [],
        start: () => second.start(invalid as unknown as CodexRunRequest), inspect: () => ({}) });
      expect(report.outcome).toBe('passed');
      expect(fake.starts).toHaveLength(10);
    }
    const policyRequest = { ...request, prompt: POLICY_PROMPT };
    const policy = await harness.runScenario({ label: 'M4', expected: expectedCodexLaunches(executable, policyRequest),
      start: () => first.start(policyRequest),
      inspect: observed => policyChecks(observed, READ, true, request.profile.kind) });
    expect(policy.outcome).toBe('unconfirmed');
    expect(policy.reason).toBe('required_unconfirmed');
    expect(policy.checks).toMatchObject({ allowedRead: 'unconfirmed', toolPolicy: 'unconfirmed', extensionPolicy: 'unconfirmed' });
    const startStop = vi.fn(() => first.start(request));
    const stopped = await harness.runScenario({ label: 'M5', expected: expectedCodexLaunches(executable, request),
      start: startStop, inspect: () => ({}) });
    expect(stopped).toMatchObject({ execution: 'not_started', reason: 'halted', diagnostics: 0, models: 0 });
    expect(startStop).not.toHaveBeenCalled();
    expect(fake.starts).toHaveLength(15);
  });
});
