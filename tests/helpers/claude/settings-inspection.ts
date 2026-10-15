import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { ClaudeStreamParser } from '../../../src/adapters/claude/parser.ts';
import { inventoryId } from '../../../src/adapters/claude/profile.ts';
import type { ProcessCompletion, ProcessCompletionIssue, ProcessSignalResult, ProcessStreamState } from '../../../src/shared/agent.ts';

/** Диагностический транспорт, НЕ готовый CLI-стенд. Нет default spawn, argv или live entrypoint.
 * Оболочка Nkr/pW/_W, initialize IF и settings PY прочитаны в бинарнике с SHA-256
 * 0116ee2e0a513900b633d9951367f18747686478e2b462805b8c31609f047f70.
 * Guards Df/uMt, совместимость флагов и ранние эффекты неизвестны. Проверяется на doubles.
 * Фабрика обязана вернуть один новый собственный handle; его PID не используется для kill.
 * outer — общий таймер этого JS-процесса. Независимого внешнего supervisor здесь нет.
 */
export type InspectionChild = Pick<ChildProcessWithoutNullStreams,
  'stdin' | 'stdout' | 'stderr' | 'on' | 'kill' | 'pid' | 'unref'>;
export const INSPECTION_BUDGET = Object.freeze({ response: 10_000, work: 15_000, outer: 18_000,
  term: 1_000, kill: 1_000, drain: 1_000, line: 1_048_576, output: 2_097_152 });
export type InspectionReason = 'spawn_failed' | 'protocol_unknown' | 'request_id_mismatch' | 'premature_response'
  | 'request_rejected' | 'pending_request' | 'unexpected_event' | 'inventory_mismatch' | 'output_limit'
  | 'response_deadline' | 'work_deadline' | 'outer_deadline' | 'stdin_failed' | 'stream_failed'
  | 'signal_failed' | 'exit_unconfirmed' | 'drain_timeout' | 'missing_response' | 'process_failed' | 'process_handle_unavailable';
type RequestState = 'not_sent' | 'pending' | 'accepted' | 'rejected';
const SOURCES = ['userSettings', 'projectSettings', 'localSettings', 'flagSettings', 'policySettings'] as const;
const EXECUTABLE_KEYS = ['hooks', 'mcpServers', 'enabledPlugins', 'extraKnownMarketplaces', 'env', 'apiKeyHelper',
  'awsAuthRefresh', 'awsCredentialExport', 'statusLine', 'permissions', 'policyHelper', 'policyHelpers'] as const;
export interface SettingsProjection {
  readonly effective: 'object';
  readonly sources: readonly typeof SOURCES[number][];
  readonly policySettings: 'present' | 'absent_unknown';
  readonly applied: 'present' | 'absent';
  readonly errors: { readonly presence: 'absent' } | { readonly presence: 'present'; readonly count: number };
  /** Наличие ключа, не исполнение и не полный список исполняемой конфигурации. */
  readonly executableKeysPresent: readonly typeof EXECUTABLE_KEYS[number][];
}
export interface SettingsInspectionReport {
  readonly cliCompatibility: 'unconfirmed';
  readonly outcome: 'observed' | 'rejected' | 'failed' | 'stopped';
  readonly stopAccepted: boolean;
  readonly initialize: RequestState;
  readonly getSettings: RequestState;
  readonly sessionState: 'unknown' | 'idle' | 'running' | 'requires_action';
  readonly inventoryObserved: boolean;
  readonly settings?: SettingsProjection;
  readonly reasons: readonly InspectionReason[];
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly elapsedMs: number;
  /** finished требует события finish, одного вызова end недостаточно. */
  readonly stdin: 'not_started' | 'unconfirmed' | 'finished' | 'errored' | 'forced_closed';
  readonly completion: ProcessCompletion;
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const has = (value: object, key: string): boolean => Object.hasOwn(value, key);
const codes = new Set(['EPERM', 'ESRCH', 'EPIPE', 'ENOENT', 'EACCES', 'EIO']);
const errno = (value: unknown): string | undefined => record(value) && typeof value.code === 'string' && codes.has(value.code) ? value.code : undefined;
const signals = new Set(['SIGTERM', 'SIGKILL', 'SIGABRT', 'SIGINT', 'SIGSEGV', 'SIGILL', 'SIGBUS', 'SIGQUIT', 'SIGHUP', 'SIGPIPE', 'SIGTRAP', 'SIGALRM']);
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function projectSettings(value: unknown): SettingsProjection | undefined {
  if (!record(value) || !record(value.effective) || !Array.isArray(value.sources)) return;
  const sources: typeof SOURCES[number][] = [];
  const objects = [value.effective];
  for (const entry of value.sources) {
    if (!record(entry) || !SOURCES.some(source => source === entry.source) || !record(entry.settings)) return;
    const source = entry.source as typeof SOURCES[number];
    if (sources.includes(source)) return;
    sources.push(source); objects.push(entry.settings);
  }
  if (has(value, 'applied')) {
    const applied = value.applied;
    if (!record(applied) || typeof applied.model !== 'string'
      || !(applied.effort === null || (typeof applied.effort === 'string' && ['low', 'medium', 'high', 'xhigh', 'max'].includes(applied.effort)))) return;
  }
  if (has(value, 'errors') && !Array.isArray(value.errors)) return;
  return {
    effective: 'object', sources, policySettings: sources.includes('policySettings') ? 'present' : 'absent_unknown',
    applied: has(value, 'applied') ? 'present' : 'absent',
    errors: Array.isArray(value.errors) ? { presence: 'present', count: value.errors.length } : { presence: 'absent' },
    executableKeysPresent: EXECUTABLE_KEYS.filter(key => objects.some(object => has(object, key))),
  };
}

/** Только узкий transport API; возвращает конечный снимок, не verdict production admission. */
export function inspectSettings(spawnOwnProcess: () => InspectionChild): {
  readonly done: Promise<SettingsInspectionReport>; stop(): void;
} {
  const started = performance.now();
  let resolve!: (report: SettingsInspectionReport) => void;
  const done = new Promise<SettingsInspectionReport>(yes => { resolve = yes; });
  let child: InspectionChild | undefined;
  let finished = false, stopping = false, stopAccepted = false, deadline = false, writing = false, queued = false;
  let stdinEnded = false, inventoryObserved = false;
  let stdin: SettingsInspectionReport['stdin'] = 'not_started';
  let initialize: RequestState = 'not_sent', getSettings: RequestState = 'not_sent';
  let sessionState: SettingsInspectionReport['sessionState'] = 'unknown';
  let settings: SettingsProjection | undefined;
  let processState: ProcessCompletion['process'] = { state: 'not_started' };
  let stdout: ProcessStreamState = 'not_started', stderr: ProcessStreamState = 'not_started';
  let stdoutBytes = 0, stderrBytes = 0, lineBytes = 0;
  let parts: Uint8Array[] = [];
  const reasons: InspectionReason[] = [], issues: ProcessCompletionIssue[] = [], sent: ProcessSignalResult[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  const later = (ms: number, action: () => void) => {
    const timer = setTimeout(() => { timers.delete(timer); if (!finished) action(); }, ms);
    timers.add(timer); return timer;
  };
  const reason = (code: InspectionReason) => { if (!reasons.includes(code)) reasons.push(code); };
  const issue = (code: ProcessCompletionIssue['code'], operation: ProcessCompletionIssue['operation']) => {
    if (!issues.some(item => item.code === code && item.operation === operation))
      issues.push({ code, operation, detail: `Диагностический транспорт: ${code}` });
  };
  const failed = () => finished || stopping || reasons.length > 0 || stopAccepted;
  const endInput = () => {
    if (!child || stdinEnded) return;
    stdinEnded = true;
    try { child.stdin.end(); } catch { stdin = 'errored'; reason('stdin_failed'); issue('stdin_failed', 'stdin'); }
  };
  const finish = () => {
    if (finished) return;
    const inputPending = stdin === 'unconfirmed' || writing && stdin !== 'errored';
    if (processState.state === 'unconfirmed') { reason('exit_unconfirmed'); issue('exit_unconfirmed', 'wait'); }
    if (child && inputPending) {
      reason('stdin_failed'); issue('stdin_failed', 'stdin');
    }
    if (child && (stdout === 'unconfirmed' || stderr === 'unconfirmed' || inputPending)) {
      reason('drain_timeout'); issue('drain_timeout', 'wait'); deadline = true;
    }
    if (processState.state === 'exited' && (processState.exitCode !== 0 || processState.signal !== null)) reason('process_failed');
    if (getSettings !== 'accepted' && !reasons.length && !stopAccepted) reason('missing_response');
    finished = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear(); parts = []; lineBytes = 0;
    if (child && stdout === 'unconfirmed') stdout = 'forced_closed';
    if (child && stderr === 'unconfirmed') stderr = 'forced_closed';
    if (child && inputPending) stdin = 'forced_closed';
    child?.stdout.destroy(); child?.stderr.destroy(); child?.stdin.destroy(); child?.unref();
    resolve(freeze({ cliCompatibility: 'unconfirmed',
      outcome: stopAccepted ? 'stopped' : reasons.length ? (reasons.length === 1 && reasons[0] === 'request_rejected' ? 'rejected' : 'failed') : 'observed',
      stopAccepted, initialize, getSettings, sessionState, inventoryObserved, ...(settings ? { settings } : {}),
      reasons: [...reasons], stdoutBytes, stderrBytes, stdin, elapsedMs: Math.max(0, Math.round(performance.now() - started)),
      completion: { process: processState, stdout, stderr, signals: [...sent], wait: deadline ? 'deadline' : 'settled',
        issues: [...issues], descendants: 'not_guaranteed' } }));
  };
  const settle = () => {
    if (processState.state !== 'unconfirmed' && stdout !== 'unconfirmed' && stderr !== 'unconfirmed'
      && stdin !== 'unconfirmed' && (!writing || stdin === 'errored')) finish();
  };
  const drain = () => { if (!drainTimer) drainTimer = later(INSPECTION_BUDGET.drain, finish); settle(); };
  const signal = (name: 'SIGTERM' | 'SIGKILL') => {
    if (!child || finished || processState.state !== 'unconfirmed') return;
    try {
      const sentOk = child.kill(name);
      sent.push({ signal: name, target: 'process', status: sentOk ? 'sent' : 'failed' });
      if (!sentOk) { reason('signal_failed'); issue('signal_failed', name === 'SIGTERM' ? 'interrupt' : 'kill'); }
    } catch (error) {
      const errorCode = errno(error);
      sent.push({ signal: name, target: 'process', status: errorCode === 'ESRCH' ? 'not_found' : 'failed', ...(errorCode ? { errorCode } : {}) });
      reason('signal_failed'); issue('signal_failed', name === 'SIGTERM' ? 'interrupt' : 'kill');
    }
  };
  const stop = () => {
    if (finished || stopping) return;
    stopping = true; endInput();
    if (processState.state !== 'unconfirmed') { drain(); return; }
    signal('SIGTERM');
    later(INSPECTION_BUDGET.term, () => {
      signal('SIGKILL');
      later(INSPECTION_BUDGET.kill, () => {
        if (processState.state === 'unconfirmed') { deadline = true; reason('exit_unconfirmed'); issue('exit_unconfirmed', 'wait'); }
        drain();
      });
    });
  };
  const fail = (code: InspectionReason) => { if (!finished) { reason(code); stop(); } };
  const send = (kind: 'initialize' | 'get_settings') => {
    if (failed() || writing || !child || stdinEnded || stdout !== 'unconfirmed' || processState.state !== 'unconfirmed') return;
    const id = kind === 'initialize' ? 'p2b-policy-init' : 'p2b-policy-read';
    if (kind === 'initialize') initialize = 'pending'; else getSettings = 'pending';
    writing = true;
    try {
      child.stdin.write(JSON.stringify({ type: 'control_request', request_id: id, request: { subtype: kind } }) + '\n', error => {
        writing = false;
        if (finished) return;
        if (error) { stdin = 'errored'; issue('stdin_failed', 'stdin'); fail('stdin_failed'); }
        else scheduleNext();
        settle();
      });
    } catch { writing = false; stdin = 'errored'; issue('stdin_failed', 'stdin'); fail('stdin_failed'); }
  };
  const scheduleNext = () => {
    if (queued || failed()) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      // Причинность: сначала разбирается весь полученный chunk; неполная строка откладывает отправку.
      if (failed() || writing || lineBytes !== 0) return;
      if (initialize === 'accepted' && getSettings === 'not_sent') send('get_settings');
      else if (getSettings === 'accepted') endInput();
    });
  };
  const inventory = new ClaudeStreamParser({ expectedInventory: {
    tools: ['Read', 'Glob', 'Grep'], plugins: ['cc-plugin-agents-md', 'cc-plugin-plugin-authoring'].map(name => ({ id: inventoryId(name), origin: 'builtin' })),
    mcpServers: [], skills: [], slashCommands: [], agents: ['claude', 'Explore', 'general-purpose', 'Plan'].map(inventoryId),
    cliVersion: '2.1.295', permissionMode: 'dontAsk',
  } });
  const consume = () => {
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))); }
    catch { parts = []; lineBytes = 0; fail('protocol_unknown'); return; }
    parts = []; lineBytes = 0;
    if (!record(value)) { fail('protocol_unknown'); return; }
    if (value.type === 'system' && value.subtype === 'init') {
      if (inventoryObserved) { fail('inventory_mismatch'); return; }
      inventory.feed(Buffer.from(JSON.stringify(value) + '\n'));
      if (inventory.error || !inventory.runtimeInventory) fail('inventory_mismatch');
      else inventoryObserved = true;
      return;
    }
    if (typeof value.type === 'string' && ['assistant', 'user', 'result', 'stream_event', 'tool_use', 'tool_result'].includes(value.type)) { fail('unexpected_event'); return; }
    if (value.type !== 'control_response' || !record(value.response)) { fail('protocol_unknown'); return; }
    const response = value.response;
    const which = response.request_id === 'p2b-policy-init' ? 'init' : response.request_id === 'p2b-policy-read' ? 'settings' : undefined;
    if (!which) { fail('request_id_mismatch'); return; }
    const state = which === 'init' ? initialize : getSettings;
    if (state !== 'pending') { fail(state === 'not_sent' ? 'premature_response' : 'request_id_mismatch'); return; }
    if (response.subtype === 'error') {
      if (typeof response.error !== 'string') { fail('protocol_unknown'); return; }
      if (which === 'init') initialize = 'rejected'; else getSettings = 'rejected';
      fail('request_rejected'); return;
    }
    if (response.subtype !== 'success' || !record(response.response)) { fail('protocol_unknown'); return; }
    for (const key of ['pending_permission_requests', 'pending_user_dialog_requests']) {
      if (!has(response, key) && which !== 'init') continue;
      if (!Array.isArray(response[key])) { fail('protocol_unknown'); return; }
      if (response[key].length) { fail('pending_request'); return; }
    }
    const payload = response.response;
    if (which === 'init') {
      if (!['commands', 'agents', 'models'].every(key => Array.isArray(payload[key]) && payload[key].every(record))
        || typeof payload.output_style !== 'string' || !Array.isArray(payload.available_output_styles)
        || !payload.available_output_styles.every(item => typeof item === 'string') || !record(payload.account)) { fail('protocol_unknown'); return; }
      if (has(payload, 'session_state')) {
        if (payload.session_state !== 'idle' && payload.session_state !== 'running' && payload.session_state !== 'requires_action') { fail('protocol_unknown'); return; }
        sessionState = payload.session_state;
        if (sessionState !== 'idle') { fail('pending_request'); return; }
      }
      initialize = 'accepted';
    } else {
      settings = projectSettings(payload);
      if (!settings) { fail('protocol_unknown'); return; }
      getSettings = 'accepted'; clearTimeout(responseTimer); timers.delete(responseTimer);
    }
  };
  const data = (chunk: unknown, source: 'stdout' | 'stderr') => {
    if (finished) return;
    if (!(chunk instanceof Uint8Array)) { issue('stream_failed', source); fail('stream_failed'); return; }
    if (source === 'stdout') stdoutBytes += chunk.byteLength; else stderrBytes += chunk.byteLength;
    if (stdoutBytes + stderrBytes > INSPECTION_BUDGET.output) { issue('output_limit', source); fail('output_limit'); return; }
    if (source === 'stderr' || failed()) return;
    let offset = 0;
    while (offset < chunk.byteLength && !failed()) {
      const newline = chunk.indexOf(10, offset), end = newline === -1 ? chunk.byteLength : newline;
      const part = chunk.subarray(offset, end); lineBytes += part.byteLength;
      if (lineBytes > INSPECTION_BUDGET.line) { issue('output_limit', source); fail('output_limit'); break; }
      parts.push(Buffer.from(part));
      if (newline !== -1) consume();
      offset = end + 1;
    }
    scheduleNext();
  };
  const responseTimer = later(INSPECTION_BUDGET.response, () => { deadline = true; issue('timeout', 'wait'); fail('response_deadline'); });
  later(INSPECTION_BUDGET.work, () => { deadline = true; issue('timeout', 'wait'); fail('work_deadline'); });
  later(INSPECTION_BUDGET.outer, () => { deadline = true; reason('outer_deadline'); issue('timeout', 'wait'); finish(); });
  // Вызов фабрики уже мог создать процесс, даже если handle не вернулся.
  processState = { state: 'unconfirmed' }; stdout = stderr = stdin = 'unconfirmed';
  try {
    child = spawnOwnProcess();
    child.on('error', () => {
      if (finished) return;
      if (child?.pid === undefined) processState = { state: 'not_started' };
      issue('spawn_failed', 'spawn'); fail('spawn_failed');
    });
    child.on('exit', (code: number | null, name: string | null) => {
      if (finished) return;
      processState = { state: 'exited', exitCode: Number.isInteger(code) ? code : null,
        signal: name === null ? null : signals.has(name) ? name : 'other' };
      endInput(); drain();
    });
    child.stdin.on('finish', () => { if (!finished) { if (stdin !== 'errored') stdin = 'finished'; settle(); } });
    child.stdin.on('error', () => {
      if (!finished) { stdin = 'errored'; issue('stdin_failed', 'stdin'); fail('stdin_failed'); settle(); }
    });
    child.stdin.on('close', () => {
      if (!finished && stdin === 'unconfirmed') {
        stdin = 'errored'; issue('stdin_failed', 'stdin'); fail('stdin_failed'); settle();
      }
    });
    for (const source of ['stdout', 'stderr'] as const) {
      const stream = child[source];
      stream.on('data', (chunk: unknown) => data(chunk, source));
      stream.on('error', () => {
        if (finished) return;
        if (source === 'stdout') stdout = 'errored'; else stderr = 'errored';
        issue('stream_failed', source); fail('stream_failed');
      });
      stream.on('end', () => {
        if (finished) return;
        if (source === 'stdout') { if (lineBytes && !failed()) consume(); if (stdout !== 'errored') stdout = 'ended'; }
        else if (stderr !== 'errored') stderr = 'ended';
        scheduleNext(); settle();
      });
      stream.on('close', () => {
        if (finished || (source === 'stdout' ? stdout : stderr) !== 'unconfirmed') return;
        if (source === 'stdout') stdout = 'forced_closed'; else stderr = 'forced_closed';
        issue('stream_failed', source); fail('stream_failed'); settle();
      });
    }
    send('initialize');
  } catch {
    if (child) { issue('process_result_failed', 'spawn'); fail('process_failed'); }
    else { reason('spawn_failed'); reason('process_handle_unavailable'); issue('spawn_failed', 'spawn'); finish(); }
  }
  return { done, stop: () => { if (!finished) { stopAccepted = true; stop(); } } };
}
