import { createHash } from 'node:crypto';
import { ClaudeStreamParser } from '../../../src/adapters/claude/parser.ts';
import type { AgentRun, AgentRunCompletion, RuntimeInventory } from '../../../src/core/ports/agent.ts';
import type { ProcessCompletion, ProcessRequest, ProcessResult, ProcessRun, ProcessRunner } from '../../../src/core/ports/process-runner.ts';

/** Обвязка наблюдений, не источник practical admission. Импорт не запускает CLI. */
export type LiveVerdict = 'passed' | 'failed' | 'unconfirmed';
export type LiveLabel = 'p-read' | 'p-persist' | 'p-resume' | 'p-extensions' | 'p-stop';
export const LIVE_CHECK_NAMES = [
  'availableTools', 'toolScope', 'read', 'glob', 'grep', 'readMarker', 'controlUnchanged',
  'transcriptAbsentBefore', 'transcriptAbsentAfter', 'transcriptPresent', 'memoryRecovered',
  'instructionsChanged', 'modeWord', 'explicitWriteDenial', 'hookEffectAbsent', 'mcpEffectAbsent',
  'pluginRecognition', 'instructionApplication', 'providerRefresh', 'earlyEffectsAbsent', 'detachedChildrenStopped',
  'extensionInventory', 'lifecycle', 'limitations', 'stop',
] as const;
export type LiveCheckName = typeof LIVE_CHECK_NAMES[number];
export interface LiveCheck { verdict: LiveVerdict; required: boolean }
export type LiveChecks = Partial<Record<LiveCheckName, LiveCheck>>;
const READ_TOOLS = ['Read', 'Glob', 'Grep'] as const;
type ReadTool = typeof READ_TOOLS[number];
const DENIAL_TOOLS = ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', 'other'] as const;
export type LiveDeniedTool = typeof DENIAL_TOOLS[number];
export const LIVE_UNCONFIRMED_PROPERTIES = [
  'providerRefresh', 'pluginRecognition', 'instructionApplication', 'earlyEffectsAbsent', 'detachedChildrenStopped',
] as const;
// Независимое ожидание стенда; не копирует verdict production-оценщика.
export const LIVE_LIMITATIONS = [
  'no_os_sandbox', 'no_provider_only_network', 'detached_children_not_guaranteed', 'cli_configuration_not_audited',
] as const;
type Limitation = typeof LIVE_LIMITATIONS[number];
export interface LiveObservation {
  text: string;
  tools: Record<ReadTool, LiveVerdict>;
  deniedTools: LiveDeniedTool[];
  runtimeInventory?: RuntimeInventory;
  result?: AgentRunCompletion;
  terminalCount: number;
  terminalMatches: boolean;
  limitations: Limitation[];
}

function clean(completion: ProcessCompletion, stopped = false): boolean {
  return completion.process.state === 'exited'
    && (stopped || (completion.process.exitCode === 0 && completion.process.signal === null))
    && completion.stdout === 'ended' && completion.stderr === 'ended' && completion.wait === 'settled'
    && completion.issues.length === 0 && completion.signals.every(s => s.status !== 'failed');
}

/** Проекция намеренно не содержит detail/errorCode, вывода, env, prompt или произвольной ошибки. */
export function safeLiveCompletion(completion: ProcessCompletion) {
  return {
    process: completion.process.state === 'exited'
      ? { state: 'exited' as const, exitCode: completion.process.exitCode,
        signal: completion.process.signal === null ? null : /^SIG[A-Z0-9]{1,12}$/.test(completion.process.signal) ? completion.process.signal : 'unknown' }
      : { state: completion.process.state },
    stdout: completion.stdout, stderr: completion.stderr, wait: completion.wait,
    descendants: completion.descendants,
    signals: completion.signals.map(s => ({ signal: s.signal, target: s.target, status: s.status })),
    issues: completion.issues.map(i => ({ code: i.code, operation: i.operation })),
  };
}
type Phase = 'version' | 'help' | 'auth' | 'model';
interface OwnedProcess {
  handle: ProcessRun;
  phase: Phase;
  label: LiveLabel;
  settled: boolean;
  result?: ProcessResult;
}
export interface LiveProcessReport {
  label: LiveLabel;
  phase: Phase;
  completion: ReturnType<typeof safeLiveCompletion> | null;
}
export interface LiveCleanupReport {
  verdict: LiveVerdict;
  safeToRemove: boolean;
  stopFailures: number;
  processes: LiveProcessReport[];
}
export interface LiveReport {
  label: LiveLabel;
  /** Попытка start адаптера; не утверждение фактического CLI spawn. */
  execution: 'not_started' | 'attempted';
  outcome: LiveVerdict;
  reason?: 'scenario_failed' | 'scenario_timeout' | 'cleanup_failed' | 'launch_blocked' | 'check_failed' | 'required_unconfirmed' | 'prerequisite_missing';
  checks: LiveChecks;
  version: string | 'unknown';
  limitations: Limitation[];
  deniedTools: LiveDeniedTool[];
  runtimeInventory?: RuntimeInventory;
  resultKind?: AgentRunCompletion['kind'];
  resultReason?: Extract<AgentRunCompletion, { kind: 'error' }>['reason'];
  stopAccepted: boolean;
  completion: ReturnType<typeof safeLiveCompletion> | null;
  cleanup: LiveCleanupReport;
  modelLaunches: number;
  diagnosticLaunches: number;
}
export interface LiveScenario {
  label: LiveLabel;
  start(): Promise<AgentRun>;
  stopOnStarted?: boolean;
  prerequisite?(): boolean;
  inspect?(observation: LiveObservation): LiveChecks;
}

/** Независимая проверка именно регистрации, не исполнения/отсутствия ранних эффектов. */
export function extensionInventoryVerdict(inventory?: RuntimeInventory): LiveVerdict {
  if (!inventory) return 'unconfirmed';
  const { plugins, mcpServers } = inventory;
  if (plugins.state === 'conflict' || mcpServers.state === 'conflict') return 'failed';
  const expected = ['cc-plugin-agents-md', 'cc-plugin-plugin-authoring']
    .map(name => 'sha256:' + createHash('sha256').update(name).digest('hex')).sort();
  if (plugins.state === 'known' && (plugins.value.some(p => p.origin !== 'builtin')
    || JSON.stringify(plugins.value.map(p => p.id).sort()) !== JSON.stringify(expected))) return 'failed';
  if (mcpServers.state === 'known' && mcpServers.value.length !== 0) return 'failed';
  return plugins.state === 'known' && mcpServers.state === 'known' ? 'passed' : 'unconfirmed';
}

/** Сводка наблюдений не переписывает прежние reports и не объявляет P2b/0C закрытыми. */
export function summarizePracticalLive(reports: readonly LiveReport[]) {
  const common: LiveCheckName[] = ['toolScope', 'controlUnchanged', 'lifecycle', 'limitations'];
  const required: Record<LiveLabel, LiveCheckName[]> = {
    'p-read': [...common, 'availableTools', 'read', 'glob', 'grep', 'readMarker', 'transcriptAbsentBefore', 'transcriptAbsentAfter'],
    'p-persist': [...common, 'availableTools', 'transcriptAbsentBefore', 'transcriptPresent'],
    'p-resume': [...common, 'availableTools', 'transcriptPresent', 'memoryRecovered', 'instructionsChanged'],
    'p-extensions': [...common, 'availableTools', 'read', 'extensionInventory', 'hookEffectAbsent', 'mcpEffectAbsent', 'transcriptAbsentBefore', 'transcriptAbsentAfter'],
    'p-stop': [...common, 'stop', 'transcriptAbsentBefore', 'transcriptAbsentAfter'],
  };
  const latest = new Map(reports.map(report => [report.label, report]));
  const persist = latest.get('p-persist');
  const layoutConfirmed = persist?.checks.transcriptPresent?.verdict === 'passed' && persist.checks.lifecycle?.verdict === 'passed';
  const requiredFailed: string[] = [];
  const requiredUnconfirmed: string[] = [];
  const notRun: LiveLabel[] = [];
  for (const label of Object.keys(required) as LiveLabel[]) {
    const report = latest.get(label);
    if (!report) { notRun.push(label); continue; }
    if (report.execution === 'not_started') notRun.push(label);
    const names = new Set([...required[label], ...LIVE_CHECK_NAMES.filter(name => report.checks[name]?.required)]);
    for (const name of names) {
      let verdict = report.checks[name]?.verdict ?? 'unconfirmed';
      if (name === 'transcriptAbsentAfter' && verdict === 'passed' && !layoutConfirmed) verdict = 'unconfirmed';
      if (verdict === 'failed') requiredFailed.push(label + '.' + name);
      if (verdict === 'unconfirmed') requiredUnconfirmed.push(label + '.' + name);
    }
  }
  const outcome: LiveVerdict = requiredFailed.length || reports.some(r => r.outcome === 'failed') ? 'failed'
    : notRun.length || requiredUnconfirmed.length || reports.some(r => r.outcome === 'unconfirmed') ? 'unconfirmed' : 'passed';
  return { scope: 'bounded_observations' as const, outcome, requiredFailed, requiredUnconfirmed, notRun,
    transcriptLayout: layoutConfirmed ? 'confirmed' as const : 'unconfirmed' as const,
    unconfirmedProperties: [...LIVE_UNCONFIRMED_PROPERTIES], p2b: 'unconfirmed' as const, stage0c: 'unconfirmed' as const };
}

type WaitResult<T> = { state: 'fulfilled'; value: T } | { state: 'rejected' | 'timeout' };
async function bounded<T>(work: Promise<T>, ms: number): Promise<WaitResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then(value => ({ state: 'fulfilled' as const, value }), () => ({ state: 'rejected' as const })),
      new Promise<WaitResult<T>>(resolve => { timer = setTimeout(() => resolve({ state: 'timeout' }), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}
function budget(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > fallback) throw new Error('Некорректный бюджет practical live.');
  return value;
}

export function createPracticalLiveHarness(options: {
  runner: ProcessRunner;
  scenarioTimeoutMs?: number;
  cleanupTimeoutMs?: number;
  stopTimeoutMs?: number;
  validateRequest?: (request: ProcessRequest) => boolean;
}) {
  const scenarioMs = budget(options.scenarioTimeoutMs, 100_000);
  const cleanupMs = budget(options.cleanupTimeoutMs, 5_000);
  const stopMs = budget(options.stopTimeoutMs, 5_000);
  const owned: OwnedProcess[] = [];
  const agents = new Set<AgentRun>();
  const agentResults = new Map<AgentRun, AgentRunCompletion>();
  const reports: LiveReport[] = [];
  const seen = new Set<LiveLabel>();
  let halted = false;
  let ownershipLost = false;
  let startPending = false;
  let modelCount = 0;
  let diagnosticCount = 0;
  let active: { label: LiveLabel; phases: number; deadline: number; stopRequested: boolean; inventory?: RuntimeInventory; version?: string } | undefined;
  const processes = (): LiveProcessReport[] => owned.map(p => ({ label: p.label, phase: p.phase,
    completion: p.result ? safeLiveCompletion(p.result.completion) : null }));
  const runner: ProcessRunner = {
    start(request) {
      const current = active;
      const reject = (): never => { halted = true; throw new Error('Запуск practical live запрещён состоянием стенда.'); };
      if (halted || !current || performance.now() >= current.deadline || owned.some(p => !p.settled)) return reject();
      const phase: Phase | undefined = [
        ['version', ['--version']], ['help', ['--help']], ['auth', ['--safe-mode', '--restricted', 'auth', 'status']],
      ].find(([, args]) => JSON.stringify(args) === JSON.stringify(request.args))?.[0] as Phase | undefined;
      const kind = phase ?? (request.args.includes('--print') ? 'model' : undefined);
      if (!kind || kind !== (['version', 'help', 'auth', 'model'] as const)[current.phases]) return reject();
      try { if (options.validateRequest && !options.validateRequest(request)) return reject(); } catch { return reject(); }
      if (kind === 'model' ? modelCount >= 5 : diagnosticCount >= 15) return reject();
      current.phases++;
      if (kind === 'model') modelCount++; else diagnosticCount++;
      let handle: ProcessRun;
      try { handle = options.runner.start(request); }
      catch { ownershipLost = true; return reject(); }
      const record: OwnedProcess = { handle, phase: kind, label: current.label, settled: false };
      owned.push(record);
      const done = handle.done.then(result => {
        record.result = result; record.settled = true;
        if (!clean(result.completion, kind === 'model' && current.stopRequested)) halted = true;
        return result;
      }, () => { record.settled = true; halted = true; throw new Error('Не получен результат собственного процесса.'); });
      // Не допускаем unhandled rejection, даже если потребитель перестал читать после deadline.
      void done.catch(() => undefined);
      const stdout = (async function* () {
        const observer = kind === 'model' ? new ClaudeStreamParser() : undefined;
        let version = '';
        for await (const chunk of handle.stdout) {
          observer?.feed(chunk);
          if (observer) current.inventory = observer.runtimeInventory;
          if (kind === 'version' && version.length < 4096) version += Buffer.from(chunk).toString('utf8').slice(0, 4096 - version.length);
          yield chunk;
        }
        observer?.end();
        if (observer) current.inventory = observer.runtimeInventory;
        if (kind === 'version') current.version = version.match(/^\s*(\d+\.\d+\.\d+)(?: \(Claude Code\))?\s*$/)?.[1];
      })();
      return { ...handle, stdout, done };
    },
  };

  async function cleanup(): Promise<LiveCleanupReport> {
    // Все операции начинаются вместе, у всей группы один конечный бюджет.
    let stopFailures = 0;
    const stopping = [...agents, ...owned.map(p => p.handle)].map(handle =>
      Promise.resolve().then(() => handle.kill()).catch(() => { stopFailures++; }));
    const waiting = bounded(Promise.all([...stopping, ...owned.map(p => p.handle.done.catch(() => undefined)),
      ...[...agents].map(run => run.done.catch(() => undefined))]), cleanupMs);
    const result = await waiting;
    const safeToRemove = result.state === 'fulfilled' && !startPending && !ownershipLost
      && owned.every(p => p.result && p.result.completion.process.state !== 'unconfirmed'
        && p.result.completion.wait === 'settled')
      && [...agents].every(run => {
        const result = agentResults.get(run);
        return result && result.completion.process.state !== 'unconfirmed' && result.completion.wait === 'settled';
      });
    const verdict: LiveVerdict = stopFailures ? 'failed' : !safeToRemove ? 'unconfirmed' : 'passed';
    if (verdict !== 'passed') halted = true;
    return { verdict, safeToRemove, stopFailures, processes: processes() };
  }

  async function runScenario(scenario: LiveScenario): Promise<LiveReport> {
    const current = { label: scenario.label, phases: 0, deadline: performance.now() + scenarioMs, stopRequested: false } as NonNullable<typeof active>;
    const checks: LiveChecks = {};
    let reason: LiveReport['reason'];
    let execution: LiveReport['execution'] = 'not_started';
    let result: AgentRunCompletion | undefined;
    let limitations: Limitation[] = [];
    const deniedTools = new Set<LiveDeniedTool>();
    let cancelled = false;
    if (halted || active || seen.has(scenario.label)) reason = 'launch_blocked';
    if (!reason && scenario.prerequisite) {
      try { if (!scenario.prerequisite()) reason = 'prerequisite_missing'; }
      catch { reason = 'prerequisite_missing'; }
    }
    if (!reason) {
      active = current; seen.add(scenario.label);
      const work = async (): Promise<void> => {
        execution = 'attempted';
        startPending = true;
        let run: AgentRun;
        try { run = await scenario.start(); } finally { startPending = false; }
        agents.add(run);
        void run.done.then(value => { agentResults.set(run, value); }, () => { halted = true; });
        if (cancelled) { void bounded(Promise.resolve().then(() => run.kill()), cleanupMs); return; }
        const texts = new Map<string, string>();
        const calls = new Map<string, { tool: ReadTool; finished: boolean; error: boolean }>();
        let textBytes = 0;
        let toolScope = true;
        let terminal: AgentRunCompletion | undefined;
        let terminalCount = 0;
        let stopResult: Promise<WaitResult<void>> | undefined;
        for await (const event of run.events) {
          if (cancelled) return;
          if (event.type === 'run_started' && scenario.stopOnStarted && !current.stopRequested) {
            current.stopRequested = true;
            stopResult = bounded(Promise.resolve().then(() => run.interrupt()), stopMs);
          }
          if (event.type === 'text') {
            const previous = texts.get(event.messageId) ?? '';
            const next = (event.mode === 'delta' ? previous : '') + event.text;
            textBytes += Buffer.byteLength(next) - Buffer.byteLength(previous);
            if (textBytes > 2_097_152 || texts.size >= 1024 && !texts.has(event.messageId)) throw new Error('Превышен бюджет наблюдения.');
            texts.set(event.messageId, next);
          }
          if (event.type === 'tool_started') {
            if (!READ_TOOLS.includes(event.tool as ReadTool)) toolScope = false;
            else calls.set(event.toolCallId, { tool: event.tool as ReadTool, finished: false, error: false });
            if (calls.size > 1024) throw new Error('Превышен бюджет наблюдения.');
          }
          if (event.type === 'tool_finished') {
            const call = calls.get(event.toolCallId);
            if (call) { call.finished = true; call.error ||= event.isError; }
          }
          if (event.type === 'permission_denied') deniedTools.add(DENIAL_TOOLS.includes(event.tool as LiveDeniedTool) ? event.tool as LiveDeniedTool : 'other');
          if (event.type === 'run_finished') { terminalCount++; terminal = event.result; }
        }
        result = await run.done;
        if (cancelled) return;
        const reportedLimitations = run.diagnostics.filter(d => d.code === 'practical_limitations').flatMap(d => d.detail.split(','));
        limitations = LIVE_LIMITATIONS.filter(item => reportedLimitations.includes(item));
        const tools = Object.fromEntries(READ_TOOLS.map(tool => {
          const matching = [...calls.values()].filter(call => call.tool === tool);
          return [tool, deniedTools.has(tool) || matching.some(c => c.error) ? 'failed' : matching.some(c => c.finished) ? 'passed' : 'unconfirmed'];
        })) as LiveObservation['tools'];
        const observed: LiveObservation = { text: [...texts.values()].join('\n'), tools, deniedTools: [...deniedTools],
          runtimeInventory: current.inventory, result, terminalCount, terminalMatches: terminal === result, limitations };
        const supplied = scenario.inspect?.(observed) ?? {};
        for (const name of LIVE_CHECK_NAMES) {
          const check = supplied[name];
          if (!check) continue;
          if (!['passed', 'failed', 'unconfirmed'].includes(check.verdict) || typeof check.required !== 'boolean') throw new Error('Некорректный результат проверки.');
          checks[name] = { verdict: check.verdict, required: check.required };
        }
        // Обязательные факты нельзя перекрыть callback наблюдения.
        checks.toolScope = { verdict: toolScope ? 'passed' : 'failed', required: true };
        checks.limitations = { verdict: limitations.length === LIVE_LIMITATIONS.length ? 'passed' : 'failed', required: true };
        checks.lifecycle = { verdict: terminalCount === 1 && terminal === result && clean(result.completion, scenario.stopOnStarted)
          && (scenario.stopOnStarted ? result.kind === 'interrupted' && result.stopAccepted : result.kind === 'success' && !result.stopAccepted)
          ? 'passed' : 'failed', required: true };
        if (scenario.stopOnStarted) {
          const stopped = await stopResult;
          if (cancelled) return;
          checks.stop = { verdict: current.stopRequested && result.stopAccepted && stopped?.state === 'fulfilled'
            ? 'passed' : 'failed', required: true };
        }
      };
      const outcome = await bounded(work(), scenarioMs);
      cancelled = true;
      if (outcome.state !== 'fulfilled' || performance.now() >= current.deadline)
        reason = outcome.state === 'timeout' || performance.now() >= current.deadline ? 'scenario_timeout' : 'scenario_failed';
    }
    // Эти свойства не доказываются данным набором даже при совпавшем слове/пустом marker.
    for (const name of LIVE_UNCONFIRMED_PROPERTIES) checks[name] = { verdict: 'unconfirmed', required: false };
    for (const tool of READ_TOOLS) if (deniedTools.has(tool)) checks[tool.toLowerCase() as 'read' | 'glob' | 'grep'] = { verdict: 'failed', required: true };
    if (scenario.label === 'p-extensions') checks.extensionInventory = { verdict: extensionInventoryVerdict(current.inventory), required: true };
    checks.explicitWriteDenial = { verdict: deniedTools.has('Write') || deniedTools.has('Edit') ? 'passed' : 'unconfirmed', required: false };
    if (reason || Object.values(checks).some(c => c.verdict === 'failed' || c.required && c.verdict !== 'passed')) halted = true;
    const cleaned = await cleanup();
    active = undefined;
    reason ??= cleaned.verdict !== 'passed' ? 'cleanup_failed'
      : Object.values(checks).some(c => c.verdict === 'failed') ? 'check_failed'
      : Object.values(checks).some(c => c.required && c.verdict !== 'passed') ? 'required_unconfirmed'
      : halted ? 'launch_blocked' : undefined;
    const outcome: LiveVerdict = reason === 'required_unconfirmed' || reason === 'scenario_timeout' || reason === 'prerequisite_missing' ? 'unconfirmed' : reason ? 'failed' : 'passed';
    if (outcome !== 'passed') halted = true;
    const report: LiveReport = { label: scenario.label, execution, outcome, ...(reason ? { reason } : {}),
      checks: Object.fromEntries(Object.entries(checks).map(([name, check]) => [name, { ...check }])),
      version: current.version ?? 'unknown', limitations, deniedTools: [...deniedTools],
      ...(current.inventory ? { runtimeInventory: current.inventory } : {}),
      ...(result ? { resultKind: result.kind } : {}), stopAccepted: result?.stopAccepted ?? false,
      ...(result?.kind === 'error' ? { resultReason: result.reason } : {}),
      completion: result ? safeLiveCompletion(result.completion) : null, cleanup: cleaned,
      modelLaunches: modelCount, diagnosticLaunches: diagnosticCount };
    reports.push(report);
    return report;
  }
  return { runner, runScenario, cleanup, halt() { halted = true; }, get reports() { return [...reports]; }, get processes() { return processes(); },
    get halted() { return halted; }, get counts() { return { model: modelCount, diagnostic: diagnosticCount }; } };
}
