// Отдельная редакция M сохраняет побайтно исходный live-harness.ts, закреплённый R2.
// Полный маршрут и все проверки одинаковы; scope только выбирает диагностическую часть M.
import { createHash } from 'node:crypto';
import type { AgentErrorReason, AgentRun, AgentRunCompletion, ProcessCompletion } from '../../../src/core/ports/agent.ts';
import type { ProcessRequest, ProcessResult, ProcessRun, ProcessRunner } from '../../../src/core/ports/process-runner.ts';

/** Только надзор и наблюдения. Импорт и создание не запускают CLI и не выдают admission. */
export const M_LABELS = ['M1', 'M2', 'M3-missing', 'M3-foreign', 'M3-binding', 'M4', 'M5'] as const;
export type MLabel = typeof M_LABELS[number];
export type Verdict = 'passed' | 'failed' | 'unconfirmed';
export const M_BUDGET = Object.freeze({ diagnostics: 16, models: 4, processes: 20,
  scenarioMs: 100_000, totalMs: 420_000, cleanupMs: 5_000, stopMs: 5_000,
  modelBytes: 1_048_576, diagnosticBytes: 262_144, textBytes: 65_536 });
const PHASES = ['version', 'exec-help', 'resume-help', 'auth', 'model'] as const;
type Phase = typeof PHASES[number];
const DIAGNOSTICS = [['--version'], ['exec', '--help'], ['exec', 'resume', '--help'], ['login', 'status']];
const CHECKS = ['terminal', 'completion', 'launches', 'limitations', 'read', 'thread', 'history',
  'instruction', 'memory', 'rejected', 'allowedRead', 'forbiddenEffectAbsent', 'toolPolicy', 'extensionPolicy', 'stop'] as const;
export type CheckName = typeof CHECKS[number];
export type Checks = Partial<Record<CheckName, Verdict>>;
const REQUIRED: Record<MLabel, readonly CheckName[]> = {
  M1: ['read', 'thread', 'memory', 'instruction', 'limitations'],
  M2: ['thread', 'memory', 'history', 'instruction', 'limitations'],
  'M3-missing': ['rejected'], 'M3-foreign': ['rejected'], 'M3-binding': ['rejected'],
  M4: ['allowedRead', 'forbiddenEffectAbsent', 'toolPolicy', 'extensionPolicy', 'limitations'],
  M5: ['stop', 'limitations'],
};
const LIMITATIONS = ['os_isolation_not_attested', 'network_not_restricted',
  'detached_children_not_guaranteed', 'cli_configuration_not_audited'];
const ISSUE_CODES = ['spawn_failed', 'timeout', 'drain_timeout', 'output_limit', 'stdin_failed',
  'unsupported_platform', 'signal_failed', 'stream_failed', 'process_result_failed', 'exit_unconfirmed'];
const OPERATIONS = ['spawn', 'interrupt', 'kill', 'stdin', 'stdout', 'stderr', 'done', 'wait'];
const STREAMS = ['not_started', 'ended', 'errored', 'forced_closed', 'unconfirmed'];
const RESULT_REASONS: readonly AgentErrorReason[] = ['binary_missing', 'not_authenticated', 'capability_missing', 'invalid_request',
  'profile_unverified', 'profile_unsupported', 'spawn_failed', 'timeout', 'practical_admission_blocked', 'practical_admission_unsupported',
  'runtime_inventory_unknown', 'runtime_inventory_mismatch', 'drain_timeout', 'output_limit', 'protocol_incompatible', 'missing_result',
  'signal_failed', 'stream_failed', 'process_result_failed', 'exit_unconfirmed', 'nonzero_exit', 'network', 'overloaded', 'rate_limit', 'unknown'];
const select = (value: string | undefined, values: readonly string[]): string =>
  value !== undefined && values.includes(value) ? value : 'unknown';

/** Закрытая проекция: detail, prompt, вывод, пути, env-values и исключения не сериализуются. */
export function safeCodexCompletion(value: ProcessCompletion) {
  return {
    process: value.process.state === 'exited'
      ? { state: 'exited', exitCode: Number.isInteger(value.process.exitCode) ? value.process.exitCode : null,
        signal: value.process.signal === null ? null : /^SIG[A-Z0-9]{1,12}$/.test(value.process.signal) ? value.process.signal : 'unknown' }
      : { state: select(value.process.state, ['not_started', 'unconfirmed']) },
    stdout: select(value.stdout, STREAMS), stderr: select(value.stderr, STREAMS),
    wait: select(value.wait, ['settled', 'deadline']), descendants: 'not_guaranteed',
    signals: value.signals.slice(0, 32).map(s => ({
      signal: select(s.signal, ['SIGTERM', 'SIGKILL']), target: select(s.target, ['process', 'group']),
      status: select(s.status, ['sent', 'not_found', 'failed']),
    })),
    issues: value.issues.slice(0, 32).map(i => ({ code: select(i.code, ISSUE_CODES),
      ...(i.operation === undefined ? {} : { operation: select(i.operation, OPERATIONS) }) })),
  };
}
export interface Observation {
  /** Только временная память инспектора; в report не входят. */
  text: string;
  threadIds: readonly string[];
  toolNames: readonly string[];
  deniedTools: readonly string[];
  result: AgentRunCompletion;
  stopAccepted: boolean;
}
export interface ProcessEvidence {
  label: MLabel;
  phase: Phase;
  handle: 'returned' | 'unconfirmed';
  startedAt: string;
  argvSha256: string;
  envNames: string[];
  stdoutBytes: number;
  stderrBytes: number;
  stdoutEnded: boolean;
  stderrEnded: boolean;
  completion: ReturnType<typeof safeCodexCompletion> | null;
}
export interface Cleanup {
  verdict: Verdict;
  safeToRemove: boolean;
  stopFailures: number;
  pendingStarts: number;
  lostHandle: boolean;
}
export interface Report {
  label: MLabel;
  execution: 'attempted' | 'not_started';
  outcome: Verdict;
  reason?: 'launch_blocked' | 'scenario_failed' | 'scenario_timeout' | 'required_unconfirmed' | 'check_failed' | 'halted';
  checks: Checks;
  terminalCount: number;
  stopAccepted: boolean;
  resultKind?: AgentRunCompletion['kind'];
  resultReason?: AgentErrorReason;
  diagnostics: number;
  models: number;
  completion: ReturnType<typeof safeCodexCompletion> | null;
  cleanup: Cleanup;
}
interface Owned {
  run: ProcessRun;
  report: ProcessEvidence;
  result?: ProcessResult;
  settled: boolean;
  streamFailed: boolean;
}
function clean(value: ProcessCompletion, stopped = false): boolean {
  return value.process.state === 'exited' && (stopped || value.process.exitCode === 0 && value.process.signal === null)
    && value.stdout === 'ended' && value.stderr === 'ended' && value.wait === 'settled'
    && value.issues.length === 0 && value.signals.every(s => s.status !== 'failed');
}
function sameRequest(a: ProcessRequest, b: ProcessRequest): boolean {
  const names = Object.keys(a.env).sort();
  return a.executable === b.executable && a.cwd === b.cwd && a.stdin === b.stdin
    && JSON.stringify(a.args) === JSON.stringify(b.args)
    && JSON.stringify(names) === JSON.stringify(Object.keys(b.env).sort())
    && names.every(name => a.env[name] === b.env[name])
    && a.timeoutMs === b.timeoutMs && a.stopGraceMs === b.stopGraceMs
    && a.drainTimeoutMs === b.drainTimeoutMs && a.maxQueueBytes === b.maxQueueBytes;
}
function limit(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error('Некорректный бюджет стенда Codex.');
  return value;
}
async function bounded<T>(work: Promise<T>, ms: number): Promise<{ value: T } | { error: 'timeout' | 'rejected' }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then(value => ({ value }), () => ({ error: 'rejected' as const })),
      new Promise<{ error: 'timeout' }>(resolve => { timer = setTimeout(() => resolve({ error: 'timeout' }), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

export function createCodexLiveHarness(options: {
  runner: ProcessRunner;
  /** Отдельная диагностика остальных критериев после сохранённого отказа M2.
   * Не считается полной M-приёмкой; порядок full и остановка при ошибке не меняются. */
  scope?: 'full' | 'without-resume' | 'stop-only';
  beforeLaunch?: (request: ProcessRequest) => boolean;
  scenarioTimeoutMs?: number;
  cleanupTimeoutMs?: number;
  stopTimeoutMs?: number;
}) {
  const labels: readonly MLabel[] = options.scope === 'stop-only' ? ['M5']
    : options.scope === 'without-resume' ? M_LABELS.filter(label => label !== 'M2') : M_LABELS;
  const scenarioMs = limit(options.scenarioTimeoutMs, M_BUDGET.scenarioMs);
  const cleanupMs = limit(options.cleanupTimeoutMs, M_BUDGET.cleanupMs);
  const stopMs = limit(options.stopTimeoutMs, M_BUDGET.stopMs);
  const owned: Owned[] = [];
  const attempts: ProcessEvidence[] = [];
  const agents = new Set<AgentRun>();
  const reports: Report[] = [];
  let halted = false;
  let lostHandle = false;
  let pendingStarts = 0;
  let stopFailures = 0;
  let next = 0;
  let totalDeadline = 0;
  let active: { label: MLabel; expected: readonly ProcessRequest[]; count: number; deadline: number; stop: boolean } | undefined;
  const settled = (p: Owned): boolean => p.settled && p.result !== undefined && !p.streamFailed
    && p.report.stdoutEnded && p.report.stderrEnded && clean(p.result.completion, p.report.label === 'M5');
  const reject = (): never => { halted = true; throw new Error('Запуск вне manifest или после ошибки запрещён.'); };
  const stop = async (run: ProcessRun | AgentRun, hard: boolean, propagate = false): Promise<void> => {
    const result = await bounded(Promise.resolve().then(() => hard ? run.kill() : run.interrupt()), stopMs);
    if ('error' in result) {
      stopFailures++; halted = true;
      if (propagate) throw new Error('Остановка процесса стенда не подтверждена.');
    }
  };
  const runner: ProcessRunner = {
    start(request) {
      const current = active;
      if (halted || !current || performance.now() >= current.deadline || performance.now() >= totalDeadline
        || attempts.length >= M_BUDGET.processes || owned.some(p => !settled(p))) return reject();
      const expected = current.expected[current.count];
      const phase = PHASES[current.count];
      if (!expected || !phase || !sameRequest(request, expected)) return reject();
      if (phase !== 'model' && JSON.stringify(request.args) !== JSON.stringify(DIAGNOSTICS[current.count])) return reject();
      if (phase === 'model' && (request.args[0] !== 'exec' || request.args.at(-1) !== '-')) return reject();
      if (Buffer.byteLength(request.stdin) > 8192 || options.beforeLaunch && !options.beforeLaunch(request)) return reject();
      current.count++;
      const evidence: ProcessEvidence = { label: current.label, phase, handle: 'unconfirmed', startedAt: new Date().toISOString(),
        argvSha256: createHash('sha256').update(JSON.stringify(request.args)).digest('hex'),
        envNames: Object.keys(request.env).sort(), stdoutBytes: 0, stderrBytes: 0,
        stdoutEnded: false, stderrEnded: false, completion: null };
      // Бюджет списывается до фабрики: throw мог потерять handle уже созданного процесса.
      attempts.push(evidence);
      let run: ProcessRun;
      try { run = options.runner.start(request); }
      catch { lostHandle = true; return reject(); }
      evidence.handle = 'returned';
      const record: Owned = { run, report: evidence, settled: false, streamFailed: false };
      owned.push(record);
      void run.done.then(result => {
        record.settled = true;
        if (result?.completion) {
          record.result = result; evidence.completion = safeCodexCompletion(result.completion);
          if (!clean(result.completion, current.stop)) halted = true;
        } else halted = true;
      }, () => { record.settled = true; halted = true; });
      const watch = (source: AsyncIterable<Uint8Array>, name: 'stdout' | 'stderr'): AsyncIterable<Uint8Array> => ({
        async *[Symbol.asyncIterator]() {
          try {
            for await (const chunk of source) {
              evidence[name === 'stdout' ? 'stdoutBytes' : 'stderrBytes'] += chunk.byteLength;
              if (evidence.stdoutBytes + evidence.stderrBytes > (phase === 'model' ? M_BUDGET.modelBytes : M_BUDGET.diagnosticBytes)) {
                throw new Error('Превышен бюджет вывода стенда.');
              }
              yield chunk;
            }
            evidence[name === 'stdout' ? 'stdoutEnded' : 'stderrEnded'] = true;
          } catch {
            record.streamFailed = true; halted = true; void stop(run, true);
            throw new Error('Поток стенда завершился ошибкой.');
          }
        },
      });
      return { stdout: watch(run.stdout, 'stdout'), stderr: watch(run.stderr, 'stderr'), done: run.done,
        interrupt: () => stop(run, false, true), kill: () => stop(run, true, true), get pid() { return run.pid; } };
    },
  };
  async function cleanup(): Promise<Cleanup> {
    const pending = owned.filter(p => !settled(p));
    const result = await bounded(Promise.all([
      ...pending.map(p => stop(p.run, true)),
      ...[...agents].map(run => stop(run, true)),
      ...pending.map(p => p.run.done.catch(() => undefined)),
    ]), cleanupMs);
    if ('error' in result) { halted = true; stopFailures++; }
    const safeToRemove = !lostHandle && pendingStarts === 0 && stopFailures === 0 && owned.every(settled);
    return { verdict: safeToRemove ? 'passed' : 'unconfirmed', safeToRemove, stopFailures, pendingStarts, lostHandle };
  }
  async function runScenario(input: {
    label: MLabel;
    expected: readonly ProcessRequest[];
    start(): Promise<AgentRun>;
    inspect(observation: Observation): Checks | Promise<Checks>;
  }): Promise<Report> {
    if (active || input.label !== labels[next]) throw new Error('Нарушен порядок сценариев Codex.');
    next++;
    const negative = input.label.startsWith('M3-');
    const report: Report = { label: input.label, execution: 'not_started', outcome: 'unconfirmed',
      checks: {}, terminalCount: 0, stopAccepted: false, diagnostics: 0, models: 0, completion: null,
      cleanup: { verdict: 'unconfirmed', safeToRemove: false, stopFailures, pendingStarts, lostHandle } };
    if (halted) { report.reason = 'halted'; report.cleanup = await cleanup(); reports.push(report); return structuredClone(report); }
    if (input.expected.length !== (negative ? 0 : 5)) throw new Error('Manifest должен учитывать все четыре диагностики и модель.');
    totalDeadline ||= performance.now() + M_BUDGET.totalMs;
    const current = { label: input.label, expected: structuredClone(input.expected), count: 0,
      deadline: Math.min(performance.now() + scenarioMs, totalDeadline), stop: false };
    active = current;
    let cancelled = false;
    const work = async (): Promise<void> => {
      pendingStarts++; report.execution = 'attempted';
      let run: AgentRun;
      try { run = await input.start(); } finally { pendingStarts--; }
      agents.add(run);
      if (cancelled) { await stop(run, true); return; }
      let terminal: AgentRunCompletion | undefined;
      const messages = new Map<string, string>();
      const threadIds: string[] = [];
      const toolNames: string[] = [];
      const deniedTools: string[] = [];
      let textBytes = 0;
      let activity = false;
      for await (const event of run.events) {
        if (cancelled) return;
        if (event.type === 'run_started') threadIds.push(event.agentSessionId);
        if (event.type === 'text') {
          const previous = messages.get(event.messageId) ?? '';
          const value = (event.mode === 'delta' ? previous : '') + event.text;
          textBytes += Buffer.byteLength(value) - Buffer.byteLength(previous);
          if (textBytes > M_BUDGET.textBytes || messages.size >= 256 && !messages.has(event.messageId)) throw new Error('Лимит текста.');
          messages.set(event.messageId, value); activity = true;
        }
        if (event.type === 'tool_started') { toolNames.push(event.tool); activity = true; }
        if (event.type === 'permission_denied') deniedTools.push(event.tool);
        if (toolNames.length > 256 || deniedTools.length > 256 || threadIds.length > 2) throw new Error('Лимит событий.');
        if (event.type === 'run_finished') { report.terminalCount++; terminal = event.result; }
        if (input.label === 'M5' && activity && !terminal && !current.stop) {
          current.stop = true; await stop(run, false);
        }
      }
      const result = await run.done;
      agents.delete(run);
      if (cancelled) return;
      report.completion = safeCodexCompletion(result.completion);
      if (['success', 'error', 'max_turns', 'interrupted', 'limit'].includes(result.kind)) report.resultKind = result.kind;
      if (result.kind === 'error') report.resultReason = RESULT_REASONS.includes(result.reason) ? result.reason : 'unknown';
      report.stopAccepted = result.stopAccepted === true;
      report.checks.terminal = report.terminalCount === 1 && JSON.stringify(terminal) === JSON.stringify(result) ? 'passed' : 'failed';
      const expectedResult = negative ? result.kind === 'error' && result.reason === 'invalid_request'
        : input.label === 'M5' ? current.stop && result.stopAccepted && result.kind === 'interrupted' : result.kind === 'success';
      const goodCompletion = negative ? result.completion.process.state === 'not_started' && current.count === 0
        : clean(result.completion, current.stop);
      report.checks.completion = expectedResult && goodCompletion ? 'passed' : 'failed';
      report.checks.launches = current.count === input.expected.length ? 'passed' : 'failed';
      if (negative) report.checks.rejected = expectedResult && current.count === 0 && threadIds.length === 0 ? 'passed' : 'failed';
      else {
        const limitations = run.diagnostics.filter(d => d.code === 'codex_limitations');
        report.checks.limitations = limitations.length === 1
          && JSON.stringify(limitations[0]!.detail.split(',').sort()) === JSON.stringify([...LIMITATIONS].sort()) ? 'passed' : 'failed';
      }
      if (input.label === 'M5') report.checks.stop = current.stop && expectedResult ? 'passed' : 'failed';
      const checked = await input.inspect({ text: [...messages.values()].join('\n'), threadIds, toolNames, deniedTools, result,
        stopAccepted: report.stopAccepted });
      for (const name of CHECKS.filter(name => REQUIRED[input.label].includes(name))) {
        if (['limitations', 'stop', 'rejected'].includes(name)) continue;
        const value = checked[name];
        report.checks[name] = value === 'passed' || value === 'failed' ? value : 'unconfirmed';
      }
    };
    const result = await bounded(work(), Math.max(1, current.deadline - performance.now()));
    if ('error' in result) { cancelled = true; halted = true; report.reason = result.error === 'timeout' ? 'scenario_timeout' : 'scenario_failed'; }
    active = undefined;
    const processes = attempts.filter(p => p.label === input.label);
    report.diagnostics = processes.filter(p => p.phase !== 'model').length;
    report.models = processes.filter(p => p.phase === 'model').length;
    report.cleanup = await cleanup();
    const checks = [...REQUIRED[input.label], 'terminal', 'completion', 'launches'] as CheckName[];
    if (halted || !report.cleanup.safeToRemove || checks.some(name => report.checks[name] === 'failed')) {
      report.outcome = 'failed'; report.reason ??= halted ? 'launch_blocked' : 'check_failed'; halted = true;
    } else if (checks.some(name => report.checks[name] !== 'passed')) {
      report.reason = 'required_unconfirmed'; halted = true;
    } else report.outcome = 'passed';
    reports.push(structuredClone(report));
    return structuredClone(report);
  }
  return { runner, runScenario, cleanup, halt: () => { halted = true; },
    get reports() { return structuredClone(reports); },
    get processes() { return structuredClone(attempts); },
    get halted() { return halted; } };
}
