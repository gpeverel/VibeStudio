import type { ChildProcess, ChildProcessWithoutNullStreams } from 'node:child_process';
import { z } from 'zod';
import { INSPECTION_BUDGET } from './settings-inspection.ts';
import type { SettingsInspectionReport } from './settings-inspection.ts';
import type { InspectionArtifacts, InspectionMetadata } from './settings-inspection-worker.ts';

/** Supervisor не разбирает Claude JSONL: только конечный закрытый отчёт транспорта.
 * Он владеет обоими ChildProcess; PID из IPC никогда не является целью сигнала. */
const errnoSchema = z.enum(['EPERM', 'ESRCH', 'EPIPE', 'ENOENT', 'EACCES', 'EIO']);
const signalName = z.enum(['SIGTERM', 'SIGKILL', 'SIGABRT', 'SIGINT', 'SIGSEGV', 'SIGILL', 'SIGBUS', 'SIGQUIT', 'SIGHUP', 'SIGPIPE', 'SIGTRAP', 'SIGALRM', 'other']);
const number = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const processSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('not_started') }), z.object({ state: z.literal('unconfirmed') }),
  z.object({ state: z.literal('exited'), exitCode: z.number().int().min(-2147483648).max(2147483647).nullable(), signal: signalName.nullable() }),
]);
const streamSchema = z.enum(['not_started', 'ended', 'errored', 'forced_closed', 'unconfirmed']);
const signalSchema = z.object({ signal: z.enum(['SIGTERM', 'SIGKILL']), target: z.literal('process'),
  status: z.enum(['sent', 'failed', 'not_found']), errorCode: errnoSchema.optional() });
const issueCode = z.enum(['spawn_failed', 'timeout', 'drain_timeout', 'output_limit', 'stdin_failed', 'unsupported_platform',
  'signal_failed', 'stream_failed', 'process_result_failed', 'exit_unconfirmed']);
const issueSchema = z.object({ code: issueCode,
  operation: z.enum(['spawn', 'interrupt', 'kill', 'stdin', 'stdout', 'stderr', 'done', 'wait']).optional(),
  errorCode: errnoSchema.optional(),
}).transform(value => ({ ...value, detail: `Диагностический транспорт: ${value.code}` }));
const reasonSchema = z.enum(['spawn_failed', 'protocol_unknown', 'request_id_mismatch', 'premature_response', 'request_rejected',
  'pending_request', 'unexpected_event', 'inventory_mismatch', 'output_limit', 'response_deadline', 'work_deadline', 'outer_deadline',
  'stdin_failed', 'stream_failed', 'signal_failed', 'exit_unconfirmed', 'drain_timeout', 'missing_response', 'process_failed', 'process_handle_unavailable']);
const requestSchema = z.enum(['not_sent', 'pending', 'accepted', 'rejected']);
const metadataSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('missing') }), z.object({ state: z.literal('unavailable') }),
  z.object({ state: z.literal('present'), kind: z.enum(['file', 'directory', 'symlink', 'other']), size: number, mtimeMs: z.number().finite() }),
]);
const artifactsSchema = z.object({ cwdBefore: metadataSchema, cwdAfter: metadataSchema, remoteBefore: metadataSchema,
  remoteAfter: metadataSchema, cleanup: z.enum(['removed', 'failed', 'unconfirmed']) });
const reportSchema = z.object({
  cliCompatibility: z.literal('unconfirmed'), outcome: z.enum(['observed', 'rejected', 'failed', 'stopped']), stopAccepted: z.boolean(),
  initialize: requestSchema, getSettings: requestSchema, sessionState: z.enum(['unknown', 'idle', 'running', 'requires_action']),
  inventoryObserved: z.boolean(),
  settings: z.object({ effective: z.literal('object'), sources: z.array(z.enum(['userSettings', 'projectSettings', 'localSettings', 'flagSettings', 'policySettings'])).max(5),
    policySettings: z.enum(['present', 'absent_unknown']), applied: z.enum(['present', 'absent']),
    errors: z.discriminatedUnion('presence', [z.object({ presence: z.literal('absent') }), z.object({ presence: z.literal('present'), count: number })]),
    executableKeysPresent: z.array(z.enum(['hooks', 'mcpServers', 'enabledPlugins', 'extraKnownMarketplaces', 'env', 'apiKeyHelper',
      'awsAuthRefresh', 'awsCredentialExport', 'statusLine', 'permissions', 'policyHelper', 'policyHelpers'])).max(12),
  }).optional(), reasons: z.array(reasonSchema).max(24), stdoutBytes: number, stderrBytes: number, elapsedMs: number,
  stdin: z.enum(['not_started', 'unconfirmed', 'finished', 'errored', 'forced_closed']),
  completion: z.object({ process: processSchema, stdout: streamSchema, stderr: streamSchema, signals: z.array(signalSchema).max(2),
    wait: z.enum(['settled', 'deadline']), issues: z.array(issueSchema).max(32), descendants: z.literal('not_guaranteed') }),
});
export const MAX_INSPECTION_IPC_BYTES = 16_384;
export function projectInspectionReport(value: unknown): SettingsInspectionReport | undefined {
  const result = reportSchema.safeParse(value);
  if (!result.success || Buffer.byteLength(JSON.stringify(result.data)) > MAX_INSPECTION_IPC_BYTES) return;
  return result.data;
}
export type InspectionProcessState = z.infer<typeof processSchema>;
export type InspectionSignal = z.infer<typeof signalSchema>;
export type SupervisorReason = 'cli_spawn_failed' | 'worker_spawn_failed' | 'worker_failed' | 'worker_exited_without_report'
  | 'channel_lost' | 'ipc_invalid' | 'worker_output_limit' | 'response_deadline' | 'work_deadline' | 'outer_deadline'
  | 'signal_failed' | 'cli_exit_unconfirmed' | 'worker_exit_unconfirmed' | 'report_missing' | 'cleanup_failed';
export interface SupervisedSettingsReport {
  readonly cliCompatibility: 'unconfirmed';
  readonly transport?: SettingsInspectionReport;
  readonly artifacts?: InspectionArtifacts;
  readonly supervisor: {
    readonly cli: InspectionProcessState; readonly worker: InspectionProcessState;
    readonly signals: readonly (InspectionSignal & { readonly process: 'cli' | 'worker' })[];
    readonly reasons: readonly SupervisorReason[]; readonly elapsedMs: number; readonly deadline: boolean;
    readonly stopAccepted: boolean; readonly descendants: 'not_guaranteed';
  };
}
export type InspectionSupervisorBudget = Record<'response' | 'work' | 'outer' | 'term' | 'kill' | 'drain', number>;
export interface InspectionSupervisorOptions {
  /** Фабрики обязаны вернуть собственный handle; throw без handle оставляет unconfirmed. */
  spawnCli(): ChildProcessWithoutNullStreams;
  spawnWorker(cli: ChildProcessWithoutNullStreams): ChildProcess;
  /** Только для synthetic-проверок: можно уменьшать, нельзя расширять live-пределы. */
  budget?: InspectionSupervisorBudget;
  artifactsBefore?: { cwd: InspectionMetadata; remote: InspectionMetadata };
}
export type SupervisorToWorker =
  | { type: 'start'; startedNs: string; budget: InspectionSupervisorBudget; cliPid: number; artifactsBefore?: { cwd: InspectionMetadata; remote: InspectionMetadata } }
  | { type: 'cli_exit'; exitCode: number | null; signal: string | null }
  | { type: 'cli_error'; notStarted: boolean }
  | { type: 'signal_result'; id: number; result: InspectionSignal };
const workerMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }).strict(),
  z.object({ type: z.literal('settings_accepted') }).strict(),
  z.object({ type: z.literal('signal_request'), id: z.number().int().min(1).max(2), signal: z.enum(['SIGTERM', 'SIGKILL']) }).strict(),
  z.object({ type: z.literal('report'), report: z.unknown(), artifacts: artifactsSchema.optional() }).strict(),
  z.object({ type: z.literal('failed') }).strict(),
]);
const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
};
const safeSignal = (value: unknown): z.infer<typeof signalName> | null => value === null ? null : signalName.safeParse(value).data ?? 'other';
const safeExit = (value: unknown): number | null => typeof value === 'number' && Number.isInteger(value) && value >= -2147483648 && value <= 2147483647 ? value : null;

export function superviseSettingsInspection(options: InspectionSupervisorOptions): { done: Promise<SupervisedSettingsReport>; stop(): void } {
  const budget = { response: INSPECTION_BUDGET.response, work: INSPECTION_BUDGET.work, outer: INSPECTION_BUDGET.outer,
    term: INSPECTION_BUDGET.term, kill: INSPECTION_BUDGET.kill, drain: INSPECTION_BUDGET.drain, ...options.budget };
  const artifactsBefore = options.artifactsBefore === undefined ? undefined
    : z.object({ cwd: metadataSchema, remote: metadataSchema }).parse(options.artifactsBefore);
  for (const name of Object.keys(budget) as (keyof InspectionSupervisorBudget)[]) {
    if (!Number.isInteger(budget[name]) || budget[name] <= 0 || budget[name] > INSPECTION_BUDGET[name]) throw new Error('Некорректный бюджет супервизора');
  }
  if (budget.response > budget.work || budget.work + budget.term + budget.kill + budget.drain > budget.outer) throw new Error('Бюджеты остановки не помещаются во внешний предел');
  const started = process.hrtime.bigint();
  const elapsed = () => Number(process.hrtime.bigint() - started) / 1_000_000;
  let resolve!: (result: SupervisedSettingsReport) => void;
  const done = new Promise<SupervisedSettingsReport>(yes => { resolve = yes; });
  let cli: ChildProcessWithoutNullStreams | undefined, worker: ChildProcess | undefined;
  let cliState: InspectionProcessState = { state: 'not_started' }, workerState: InspectionProcessState = { state: 'not_started' };
  let transport: SettingsInspectionReport | undefined;
  let artifacts: InspectionArtifacts | undefined;
  let finished = false, stopping = false, ready = false, settingsAccepted = false, deadline = false, stopAccepted = false;
  let workerOutput = 0, messages = 0;
  const reasons: SupervisorReason[] = [];
  const signals: (InspectionSignal & { process: 'cli' | 'worker' })[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const ids = new Set<number>();
  const reason = (code: SupervisorReason) => { if (!reasons.includes(code)) reasons.push(code); };
  const at = (offset: number, fn: () => void) => {
    const timer = setTimeout(() => { timers.delete(timer); if (!finished) fn(); }, Math.max(0, Math.min(offset, budget.outer) - elapsed()));
    timers.add(timer);
  };
  const cleanup = () => {
    for (const child of [cli, worker]) if (child) {
      for (const stream of [child.stdin, child.stdout, child.stderr]) try { stream?.destroy(); } catch { reason('cleanup_failed'); }
      try { if (child.connected) child.disconnect(); } catch { reason('cleanup_failed'); }
      try { child.unref(); } catch { reason('cleanup_failed'); }
    }
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    for (const timer of timers) clearTimeout(timer);
    if (cliState.state === 'unconfirmed') reason('cli_exit_unconfirmed');
    if (workerState.state === 'unconfirmed') reason('worker_exit_unconfirmed');
    if (!transport) reason('report_missing');
    cleanup();
    resolve(freeze({ cliCompatibility: 'unconfirmed', ...(transport ? { transport } : {}), ...(artifacts ? { artifacts } : {}), supervisor: {
      cli: cliState, worker: workerState, signals: [...signals], reasons: [...reasons],
      elapsedMs: Math.round(elapsed()), deadline, stopAccepted, descendants: 'not_guaranteed',
    } }));
  };
  const settle = () => {
    if (cliState.state !== 'unconfirmed' && workerState.state !== 'unconfirmed') finish();
  };
  const signal = (target: 'cli' | 'worker', name: 'SIGTERM' | 'SIGKILL'): InspectionSignal => {
    const previous = signals.find(item => item.process === target && item.signal === name);
    if (previous) { const { signal, target: kind, status, errorCode } = previous; return { signal, target: kind, status, ...(errorCode ? { errorCode } : {}) }; }
    const child = target === 'cli' ? cli : worker;
    const state = target === 'cli' ? cliState : workerState;
    let result: InspectionSignal = { signal: name, target: 'process', status: 'failed' };
    if (child && state.state === 'unconfirmed') {
      try { result = { ...result, status: child.kill(name) ? 'sent' : 'failed' }; }
      catch (error) {
        const parsed = errnoSchema.safeParse((error as { code?: unknown } | null)?.code);
        result = { ...result, status: parsed.data === 'ESRCH' ? 'not_found' : 'failed', ...(parsed.success ? { errorCode: parsed.data } : {}) };
      }
      signals.push({ ...result, process: target });
      if (result.status !== 'sent') reason('signal_failed');
    }
    return result;
  };
  const stop = () => {
    if (finished || stopping) return;
    stopping = true;
    const stopAt = elapsed();
    signal('cli', 'SIGTERM'); signal('worker', 'SIGTERM');
    at(stopAt + budget.term, () => { signal('cli', 'SIGKILL'); signal('worker', 'SIGKILL'); });
    at(stopAt + budget.term + budget.kill + budget.drain, () => { deadline = true; finish(); });
    settle();
  };
  const fail = (code: SupervisorReason) => { if (!finished) { reason(code); stop(); } };
  const send = (message: SupervisorToWorker) => {
    if (!worker || finished) return;
    try {
      if (!worker.connected) { fail('channel_lost'); return; }
      worker.send(message, error => { if (error) fail('channel_lost'); });
    } catch { fail('channel_lost'); }
  };
  at(budget.response, () => { if (!settingsAccepted) { deadline = true; fail('response_deadline'); } });
  at(budget.work, () => { deadline = true; fail('work_deadline'); });
  at(budget.outer, () => { deadline = true; reason('outer_deadline'); finish(); });
  cliState = { state: 'unconfirmed' };
  try {
    cli = options.spawnCli();
    cli.on('error', () => {
      if (finished) return;
      if (cli?.pid === undefined) cliState = { state: 'not_started' };
      send({ type: 'cli_error', notStarted: cliState.state === 'not_started' }); fail('cli_spawn_failed');
    });
    cli.on('exit', (code, name) => {
      if (finished) return;
      cliState = { state: 'exited', exitCode: safeExit(code), signal: safeSignal(name) };
      if (ready) send({ type: 'cli_exit', exitCode: cliState.exitCode, signal: cliState.signal });
      settle();
    });
    // Родитель не читает и не журналирует raw CLI streams. Ошибки всё равно обработаны.
    for (const stream of [cli.stdin, cli.stdout, cli.stderr]) stream.on('error', () => fail('cli_spawn_failed'));
    if (cli.pid === undefined) { fail('cli_spawn_failed'); }
    else if (elapsed() >= budget.response) { deadline = true; fail('response_deadline'); }
    else {
      workerState = { state: 'unconfirmed' };
      try {
        worker = options.spawnWorker(cli);
        worker.on('error', () => {
          if (finished) return;
          if (worker?.pid === undefined) workerState = { state: 'not_started' };
          fail('worker_spawn_failed');
        });
        worker.on('exit', (code, name) => {
          if (finished) return;
          workerState = { state: 'exited', exitCode: safeExit(code), signal: safeSignal(name) };
          if (!transport) fail('worker_exited_without_report');
          else if (code !== 0 || name !== null) fail('worker_failed');
          settle();
        });
        worker.on('disconnect', () => { if (!transport) fail('channel_lost'); });
        for (const stream of [worker.stdout, worker.stderr]) {
          stream?.on('data', (chunk: Buffer) => { workerOutput += chunk.byteLength; if (workerOutput > MAX_INSPECTION_IPC_BYTES) fail('worker_output_limit'); });
          stream?.on('error', () => fail('worker_failed'));
        }
        worker.on('message', (raw: unknown) => {
          if (finished) return;
          if (++messages > 8) { fail('ipc_invalid'); return; }
          let bytes: number;
          try { bytes = Buffer.byteLength(JSON.stringify(raw)); } catch { fail('ipc_invalid'); return; }
          const parsed = bytes <= MAX_INSPECTION_IPC_BYTES ? workerMessage.safeParse(raw) : undefined;
          if (!parsed?.success) { fail('ipc_invalid'); return; }
          const message = parsed.data;
          if (message.type === 'ready') {
            if (ready || stopping) { fail('ipc_invalid'); return; }
            if (elapsed() >= budget.response) { deadline = true; fail('response_deadline'); return; }
            ready = true;
            send({ type: 'start', startedNs: started.toString(), budget, cliPid: cli!.pid!,
              ...(artifactsBefore ? { artifactsBefore } : {}) });
            if (cliState.state === 'exited') send({ type: 'cli_exit', exitCode: cliState.exitCode, signal: cliState.signal });
          } else if (!ready) fail('ipc_invalid');
          else if (message.type === 'settings_accepted') {
            if (settingsAccepted || stopping) { fail('ipc_invalid'); return; }
            if (elapsed() >= budget.response) { deadline = true; fail('response_deadline'); return; }
            settingsAccepted = true;
          } else if (message.type === 'signal_request') {
            if (ids.has(message.id)) { fail('ipc_invalid'); return; }
            ids.add(message.id);
            send({ type: 'signal_result', id: message.id, result: signal('cli', message.signal) });
          } else if (message.type === 'report') {
            const value = projectInspectionReport(message.report);
            if (transport || !value) { fail('ipc_invalid'); return; }
            transport = value;
            artifacts = message.artifacts;
            if (cliState.state === 'unconfirmed') stop();
            settle();
          } else fail('worker_failed');
        });
      } catch { fail('worker_spawn_failed'); }
    }
  } catch { fail('cli_spawn_failed'); }
  return { done, stop: () => { if (!finished) { stopAccepted = true; stop(); } } };
}
