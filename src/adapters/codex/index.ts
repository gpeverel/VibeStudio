import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type { AgentAdapter, AgentDetectOptions, AgentDiagnostic, AgentEnvironment, AgentErrorReason, AgentEvent, AgentRun, AgentRunCompletion, AgentRunResult, NormalizedPayload, ProcessCompletion, ProcessCompletionIssue } from '../../core/ports/agent.ts';
import type { ProcessResult, ProcessRun, ProcessRunner } from '../../core/ports/process-runner.ts';
import { createProcessRunner } from '../process-runner/index.ts';
import { BoundedQueue } from '../process-runner/queue.ts';
import { buildCodexArgs, buildCodexEnv, forbiddenEnvNames } from './args.ts';
import { CODEX_LIMITATIONS } from './contracts.ts';
import type { CodexAdmissionContext, CodexAdmissionEvaluator, CodexCapabilities, CodexDetection, CodexRunRequest, CodexThreadBinding } from './contracts.ts';
import { detectCodex } from './detect.ts';
import { CodexStreamParser } from './parser.ts';
import type { CodexParserOptions } from './parser.ts';
import { checkCodexAdmission, createCodexProductionAdmission, validateCodexProfile } from './profile.ts';

export interface CodexAdapterOptions {
  runner?: ProcessRunner;
  binaryPath?: string;
  env?: AgentEnvironment;
  /** Только доверенная композиция/тестовый стенд. Никогда не принимать через IPC. */
  detect?: (options: AgentDetectOptions) => Promise<CodexDetection>;
  /** Только доверенная композиция/тестовый стенд, никогда не IPC и не config. Без неё работает
   * production-оценщик, который отказывает: продуктовый read-only Codex не подтверждён (profile.ts).
   * Реальная продуктовая приёмка M не использует подстановку допуска. */
  assessAdmission?: CodexAdmissionEvaluator;
  /** Доверенное хранилище композиции: подтверждает привязку сохранённого thread_id к session/participant/workspace/cwd
   * после перезапуска. Без него resume принимает только ID, полученные этим экземпляром адаптера. Никогда не IPC. */
  verifyThread?: (binding: CodexThreadBinding) => Promise<boolean> | boolean;
  parserLimits?: CodexParserOptions;
  maxQueue?: number;
  maxQueueBytes?: number;
  maxDiagBytes?: number;
  timeoutMs?: number;
  stopGraceMs?: number;
  drainTimeoutMs?: number;
}
export const DEFAULT_CODEX_LIMITS = {
  maxQueue: 256,
  maxQueueBytes: 1_048_576,
  maxDiagBytes: 16_384,
  timeoutMs: 120_000,
  stopGraceMs: 500,
  drainTimeoutMs: 1_000,
};
/** Обнаружение нарушения по событию уже начатого инструмента, не предотвращение его эффектов.
 * Закрытый рабочий набор чтения пока не установлен; этот список не заменяет production-допуск. */
const FORBIDDEN_ITEMS = ['command_execution', 'file_change', 'mcp_tool_call', 'collab_tool_call', 'web_search'] as const;
/** Событие shell разрешено только после допуска нового профиля. Это наблюдение, не sandbox.
 * Остальные запреты остаются; для нового профиля неизвестные item также завершаются отказом. */
const SANDBOX_FORBIDDEN_ITEMS = ['file_change', 'mcp_tool_call', 'collab_tool_call', 'web_search'] as const;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
/** Неизменяемый снимок: оценённое и запущенное не могут разойтись из-за мутации во время await. */
function snapshot<T>(value: T): T | undefined {
  try { return deepFreeze(structuredClone(value)); } catch { return undefined; }
}

/** Снимок метаданных файла, который будет запущен (dev, inode, размер, mtime/ctime), без чтения содержимого.
 * Для npm-установки это node-shim; нативный потомок shim и содержимое файла не покрываются. */
async function executableIdentity(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path);
    return info.isFile() ? [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':') : undefined;
  } catch { return undefined; }
}

/** Только безопасный errno-код: текст исходной ошибки в completion не попадает. */
function errnoCode(cause: unknown): string | undefined {
  const code = (cause as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' ? code.slice(0, 32) : undefined;
}
/** Причина процесса → причина исхода; сопоставление stdin/платформы как у общего контракта. */
function reasonOf(code: ProcessCompletionIssue['code']): AgentErrorReason {
  return code === 'stdin_failed' || code === 'unsupported_platform' ? 'spawn_failed' : code;
}
/** Чистое завершение: подтверждённый exit(0), штатный EOF обоих потоков, без ошибок и deadline. */
function isCleanCompletion(completion: ProcessCompletion): boolean {
  return completion.process.state === 'exited' && completion.process.exitCode === 0 && completion.process.signal === null
    && completion.stdout === 'ended' && completion.stderr === 'ended' && completion.wait === 'settled' && completion.issues.length === 0;
}

/** Жизненный цикл повторяет контракт P2a адаптера Claude (один terminal, согласованный done, подтверждённое
 * завершение, сохранение ошибок остановки). Копия, а не общий модуль: Claude-адаптер в P3 не меняется.
 * Отличия Codex: CLI-ID приходит из thread.started (run_started выдаёт parser), допуск — CodexAdmissionEvaluator.
 * Диагностики detect — управляемые процессы запуска: Stop/deadline касаются и их. Если prompt не запускался,
 * completion описывает последний процесс диагностики (exited/signals/потоки либо unconfirmed), ошибки предыдущих
 * probes сохраняются в issues; not_started означает, что ни один процесс этого запуска не создавался.
 * Resume принимает только thread_id, наблюдённый этим экземпляром для той же привязки, либо подтверждённый verifyThread. */
export function createCodexAdapter(options: CodexAdapterOptions = {}): AgentAdapter<CodexRunRequest, CodexCapabilities> {
  const runner = options.runner ?? createProcessRunner();
  const baseEnv = buildCodexEnv(options.env ?? process.env);
  const limits = { ...DEFAULT_CODEX_LIMITS, ...options };
  for (const name of Object.keys(DEFAULT_CODEX_LIMITS) as (keyof typeof DEFAULT_CODEX_LIMITS)[]) {
    if (!Number.isSafeInteger(limits[name]) || limits[name] < 1 || limits[name] > 2_147_483_647) throw new Error('Лимиты адаптера должны быть конечными положительными целыми');
  }
  const sequences = new Map<string, number>();
  /** ID диалогов, наблюдённые этим экземпляром (run_started), по привязке; конечный размер. */
  const knownThreads = new Set<string>();
  const bindingKey = (b: CodexThreadBinding): string => JSON.stringify([b.sessionId, b.participantId, b.workspaceId, b.cwd, b.threadId.toLowerCase()]);
  const assess = options.assessAdmission ?? createCodexProductionAdmission();
  /** Диагностики идут через runner запуска, если он передан: тогда ими владеет Stop этого запуска. */
  const detectVia = (via: ProcessRunner, request: AgentDetectOptions = {}): Promise<CodexDetection> => {
    const params = { binaryPath: request.binaryPath ?? options.binaryPath, env: request.env ?? baseEnv };
    return options.detect ? options.detect(params) : detectCodex(via, params);
  };
  const detect = (request: AgentDetectOptions = {}): Promise<CodexDetection> => detectVia(runner, request);
  const text = (value: unknown): string => (typeof value === 'string' ? value : '');
  return {
    detect,
    start: async (input: CodexRunRequest): Promise<AgentRun> => {
      const frozenRequest = snapshot(input);
      const request = frozenRequest ?? input;
      // null/неверный запрос не должен ломать сборку terminal: идентификаторы конверта берутся безопасно.
      const meta = (typeof request === 'object' && request !== null ? request : {}) as Partial<CodexRunRequest>;
      const queue = new BoundedQueue<AgentEvent>(limits.maxQueueBytes, event => Buffer.byteLength(JSON.stringify(event)), limits.maxQueue);
      const diagnostics: AgentDiagnostic[] = [];
      let diagnosticBytes = 0;
      let processRun: ProcessRun | undefined;
      /** Процессы detect (version/help/login status) принадлежат этому запуску: Stop и deadline касаются и их. */
      const diagRuns = new Set<ProcessRun>();
      const diagIssues: ProcessCompletionIssue[] = [];
      const diagResults = new Map<ProcessRun, ProcessResult>();
      /** Последний процесс диагностики. Пока prompt не запускался, completion описывает именно его (с ошибками
       * предыдущих probes): not_started допустим только если ни одного процесса не запускали. */
      let lastDiag: ProcessRun | undefined;
      let finished = false;
      /** Только принятый пользовательский Stop; внутренняя очистка при ошибке им не является. */
      let stopped = false;
      let failure: AgentRunResult | undefined;
      // Факты завершения. Отсутствие наблюдения остаётся unconfirmed, а не подтверждением.
      let launchAttempted = false;
      let processResult: ProcessResult | undefined;
      let deadlineFired = false;
      let drainForced = false;
      const readFailed = { stdout: false, stderr: false };
      /** Ошибки чтения потоков диагностики; пока prompt не запускался, они описывают completion. */
      const diagReadFailed = { stdout: false, stderr: false };
      const failedStream = (name: 'stdout' | 'stderr'): boolean => (launchAttempted ? readFailed[name] : diagReadFailed[name]);
      const completionIssues: ProcessCompletionIssue[] = [];
      const pendingStops = new Map<Promise<void>, 'interrupt' | 'kill'>();
      let resolveDone!: (result: AgentRunCompletion) => void;
      const done = new Promise<AgentRunCompletion>(resolve => { resolveDone = resolve; });
      const sameIssue = (a: ProcessCompletionIssue, b: ProcessCompletionIssue): boolean => a.code === b.code && a.operation === b.operation && a.errorCode === b.errorCode;
      const addIssue = (item: ProcessCompletionIssue): void => {
        if (!finished && !completionIssues.some(known => sameIssue(known, item))) completionIssues.push(item);
      };
      /** Throw и rejection interrupt()/kill() сохраняются; успешная отправка здесь не выдумывается.
       * Тем же путём идут остановки, которые запрашивает сама диагностика (например, после ошибки потока). */
      const stopOne = (target: ProcessRun, hard: boolean): void => {
        const operation = hard ? 'kill' : 'interrupt';
        const lost = (cause: unknown): void => {
          const errorCode = errnoCode(cause);
          addIssue({ code: 'signal_failed', operation, ...(errorCode ? { errorCode } : {}), detail: 'Остановка процесса завершилась ошибкой' });
        };
        try {
          const stopping = hard ? target.kill() : target.interrupt();
          if (stopping) {
            const tracked: Promise<void> = Promise.resolve(stopping).then(() => undefined, lost).finally(() => { pendingStops.delete(tracked); });
            pendingStops.set(tracked, operation);
          }
        } catch (cause) { lost(cause); }
      };
      const stopProcess = (hard = true): void => {
        for (const target of [processRun, ...diagRuns]) if (target) stopOne(target, hard);
      };
      /** Отказ stop-метода может прийти после done: ждём его, но не дольше drain-лимита. */
      const settleStops = async (): Promise<void> => {
        if (!pendingStops.size) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([Promise.allSettled([...pendingStops.keys()]), new Promise(resolve => { timer = setTimeout(resolve, limits.drainTimeoutMs); })]);
        clearTimeout(timer);
      };
      /** Ранние terminal после диагностики ждут результаты Stop управляемых процессов (не дольше drain-лимита). */
      const end = async (result: AgentRunResult): Promise<void> => { await settleStops(); finish(result); };
      const assembleCompletion = (): ProcessCompletion => {
        const base = processResult?.completion ?? (!launchAttempted && lastDiag ? diagResults.get(lastDiag)?.completion : undefined);
        const issues = (base?.issues ?? []).map(item => ({ ...item }));
        for (const item of completionIssues) if (!issues.some(known => sameIssue(known, item))) issues.push({ ...item });
        // Stop-метод, не давший результата к снимку, не считается успешной отправкой: ожидание исчерпано.
        for (const operation of new Set(pendingStops.values())) {
          issues.push({ code: 'timeout', operation, detail: 'Результат остановки не получен к завершению; отправка сигнала не подтверждена' });
        }
        // Ошибки диагностики сохраняются, если prompt не запускался; неостановленная диагностика не считается завершённой.
        if (!launchAttempted) {
          for (const item of diagIssues) if (!issues.some(known => sameIssue(known, item))) issues.push({ ...item });
        }
        const wait = deadlineFired || drainForced || pendingStops.size > 0 || diagRuns.size > 0 || base?.wait === 'deadline' ? 'deadline' as const : 'settled' as const;
        const frozen = (): readonly ProcessCompletionIssue[] => Object.freeze(issues.map(item => Object.freeze({ ...item })));
        if (base) {
          // Копия, а не ссылки runner: поздняя мутация его объектов не меняет выданный terminal.
          const baseProcess = base.process.state === 'exited'
            ? Object.freeze({ state: 'exited' as const, exitCode: base.process.exitCode, signal: base.process.signal })
            : Object.freeze({ state: base.process.state });
          const stream = (name: 'stdout' | 'stderr'): ProcessCompletion['stdout'] => (failedStream(name) ? 'errored' : base[name]);
          return Object.freeze({ process: baseProcess, stdout: stream('stdout'), stderr: stream('stderr'),
            signals: Object.freeze(base.signals.map(item => Object.freeze({ ...item }))), wait, issues: frozen(), descendants: 'not_guaranteed' as const });
        }
        if (!launchAttempted && !lastDiag) {
          return Object.freeze({ process: Object.freeze({ state: 'not_started' as const }), stdout: 'not_started' as const, stderr: 'not_started' as const,
            signals: Object.freeze([]), wait, issues: frozen(), descendants: 'not_guaranteed' as const });
        }
        // Запуск начат, но достоверного результата runner нет: exit и потоки не подтверждены.
        if (!issues.some(item => item.code === 'process_result_failed' || item.code === 'spawn_failed')) {
          issues.push({ code: 'exit_unconfirmed', operation: 'wait',
            detail: launchAttempted ? 'Результат завершения процесса не получен' : 'Процесс диагностики CLI не подтвердил завершение' });
        }
        const stream = (name: 'stdout' | 'stderr'): ProcessCompletion['stdout'] => (failedStream(name) ? 'errored' : 'unconfirmed');
        return Object.freeze({ process: Object.freeze({ state: 'unconfirmed' as const }), stdout: stream('stdout'), stderr: stream('stderr'),
          signals: Object.freeze([]), wait, issues: frozen(), descendants: 'not_guaranteed' as const });
      };
      const envelope = (payload: NormalizedPayload): AgentEvent => {
        const sessionId = text(meta.sessionId);
        const seq = (sequences.get(sessionId) ?? 0) + 1;
        sequences.set(sessionId, seq);
        return { ...payload, schemaVersion: 1, eventId: randomUUID(), sessionId,
          turnId: text(meta.turnId), participantId: text(meta.participantId), seq, timestamp: new Date().toISOString() };
      };
      const diagnostic = (item: AgentDiagnostic): boolean => {
        const bytes = Buffer.byteLength(item.code + item.detail);
        if (diagnosticBytes + bytes > limits.maxDiagBytes) return false;
        diagnostics.push(item); diagnosticBytes += bytes;
        return true;
      };
      const finish = (result: AgentRunResult): void => {
        if (finished) return;
        // Снимок собирается до finished=true: addIssue после него уже игнорируется.
        const completion = assembleCompletion();
        finished = true;
        clearTimeout(deadline);
        let outcome: AgentRunResult = stopped ? { kind: 'interrupted' } : failure ?? result;
        // Success без подтверждённого exit/EOF и без ошибок — не success. Принятый Stop исключил его выше.
        if (outcome.kind === 'success' && !isCleanCompletion(completion)) {
          const first = completion.issues[0];
          outcome = { kind: 'error', reason: first ? reasonOf(first.code) : completion.process.state !== 'exited' ? 'exit_unconfirmed' : 'drain_timeout',
            detail: 'Завершение процесса не подтверждает успешный result' };
        }
        // Один неизменяемый снимок: done и единственный run_finished получают тот же объект.
        // Исход копируется глубоко: общий с событием usage не должен меняться после выдачи.
        const final: AgentRunCompletion = Object.freeze({ ...deepFreeze(structuredClone(outcome)), stopAccepted: stopped, completion });
        let terminal: AgentEvent | undefined;
        try { terminal = envelope({ type: 'run_finished', result: final }); } catch { /* done всё равно разрешается */ }
        queue.finish(terminal);
        resolveDone(final);
      };
      const emit = (payload: NormalizedPayload): void => {
        if (finished || failure) return;
        const event = deepFreeze(envelope(payload));
        if (payload.type === 'run_started') {
          knownThreads.add(bindingKey({ threadId: payload.agentSessionId, sessionId: text(meta.sessionId),
            participantId: text(meta.participantId), workspaceId: text(meta.workspaceId), cwd: text(meta.cwd) }));
          if (knownThreads.size > 4096) knownThreads.delete(knownThreads.values().next().value as string);
        }
        if (!queue.push(event)) {
          failure = { kind: 'error', reason: 'output_limit', detail: 'Потребитель не успевает читать ограниченную очередь событий' };
          addIssue({ code: 'output_limit', detail: failure.detail });
          stopProcess();
        }
      };
      const run: AgentRun = {
        events: queue, done, diagnostics,
        interrupt: async () => { if (!finished && !stopped) { stopped = true; stopProcess(false); } await done; },
        kill: async () => { if (!finished) { stopped = true; stopProcess(); } await done; },
      };

      // deadline/ошибка ставят failure раньше finish: поздний результат допуска не должен запускать prompt.
      const aborted = (): boolean => finished || stopped || failure !== undefined;
      const execute = async (): Promise<void> => {
        try {
          if (!frozenRequest) { finish({ kind: 'error', reason: 'invalid_request', detail: 'Некорректный запрос запуска' }); return; }
          const profileIssues = validateCodexProfile(request.profile, request.cwd);
          if (profileIssues.length) { finish({ kind: 'error', ...profileIssues[0]! }); return; }
          if (request.maxTurns !== undefined) {
            finish({ kind: 'error', reason: 'capability_missing', detail: 'Codex exec не имеет подтверждённого ограничения числа ходов' }); return;
          }
          const forbidden = forbiddenEnvNames(request.env ?? {});
          if (forbidden.length) { finish({ kind: 'error', reason: 'invalid_request', detail: `Запрещённые переменные окружения: ${forbidden.join(', ').slice(0, 512)}` }); return; }
          let built: ReturnType<typeof buildCodexArgs>;
          try { built = buildCodexArgs({ ...request, env: { ...baseEnv, ...request.env } }); }
          catch { finish({ kind: 'error', reason: 'invalid_request', detail: 'Некорректный запрос запуска' }); return; }
          // Тег adapter:'codex' и форма UUID не доказывают принадлежность истории: нужна привязка к этому контексту.
          if (request.resume) {
            const binding: CodexThreadBinding = deepFreeze({ threadId: request.thread.threadId, sessionId: request.sessionId,
              participantId: request.participantId, workspaceId: request.workspaceId, cwd: request.cwd });
            let trusted = knownThreads.has(bindingKey(binding));
            if (!trusted && options.verifyThread) {
              try { trusted = (await options.verifyThread(binding)) === true; } catch { trusted = false; }
              if (aborted()) { finish({ kind: 'interrupted' }); return; }
            }
            if (!trusted) { finish({ kind: 'error', reason: 'invalid_request', detail: 'Ссылка на диалог Codex не подтверждена для этого запуска: resume отклонён до prompt' }); return; }
          }
          // Процессы диагностики принадлежат запуску: после Stop/deadline новые probes не стартуют, активные останавливаются.
          const owned: ProcessRunner = { start: processRequest => {
            if (aborted()) throw new Error('Запуск отменён до диагностики');
            const child = runner.start(processRequest);
            diagRuns.add(child);
            lastDiag = child;
            child.done.then(settled => {
              diagRuns.delete(child);
              if (settled?.completion) diagResults.set(child, settled);
              for (const item of settled?.completion?.issues ?? []) if (!diagIssues.some(known => sameIssue(known, item))) diagIssues.push({ ...item });
            }, cause => {
              diagRuns.delete(child);
              const errorCode = errnoCode(cause);
              diagIssues.push({ code: 'process_result_failed', operation: 'done', ...(errorCode ? { errorCode } : {}), detail: 'Ожидание завершения процесса диагностики завершилось ошибкой' });
            });
            // Ошибка чтения потока фиксируется отдельно и пробрасывается detect; активная диагностика остаётся под Stop.
            const watch = (source: AsyncIterable<Uint8Array>, name: 'stdout' | 'stderr'): AsyncIterable<Uint8Array> => ({
              async *[Symbol.asyncIterator]() {
                try { yield* source; } catch (cause) {
                  diagReadFailed[name] = true;
                  const errorCode = errnoCode(cause);
                  diagIssues.push({ code: 'stream_failed', operation: name, ...(errorCode ? { errorCode } : {}), detail: 'Ошибка чтения потока процесса диагностики' });
                  throw cause;
                }
              },
            });
            return { stdout: watch(child.stdout, 'stdout'), stderr: watch(child.stderr, 'stderr'), done: child.done,
              interrupt: () => { stopOne(child, false); return Promise.resolve(); }, kill: () => { stopOne(child, true); return Promise.resolve(); },
              get pid() { return child.pid; } };
          } };
          const detection = await detectVia(owned, { env: built.env });
          if (aborted()) { await end({ kind: 'interrupted' }); return; }
          const unavailable = detection.unavailable[0];
          if (unavailable || !detection.binaryPath || detection.auth !== 'authenticated') {
            await end({ kind: 'error', reason: unavailable?.reason ?? 'capability_missing', detail: unavailable?.detail ?? 'CLI не готов к запуску' }); return;
          }
          const capabilities = detection.capabilities;
          if ((request.resume && !capabilities.resume) || (request.persistSession === false && !capabilities.ephemeral) || (request.model !== undefined && !capabilities.model)) {
            await end({ kind: 'error', reason: 'capability_missing', detail: 'CLI не подтвердил запрошенную возможность запуска' }); return;
          }
          // Допуск конкретного запуска отделён от detect: он не следует из объявленных флагов и sandbox.
          const identity = await executableIdentity(detection.binaryPath);
          if (aborted()) { await end({ kind: 'interrupted' }); return; }
          if (!identity) { await end({ kind: 'error', reason: 'practical_admission_blocked', detail: 'Допуск не выдан (assessment_failed): идентичность executable не установлена' }); return; }
          const frozenDetection = snapshot(detection);
          if (!frozenDetection) { await end({ kind: 'error', reason: 'practical_admission_blocked', detail: 'Допуск не выдан (assessment_failed): диагностика CLI не зафиксирована' }); return; }
          const launchArgs = deepFreeze(built.args);
          const launchEnv = deepFreeze(built.env);
          const context = deepFreeze({ detection: frozenDetection, request, args: launchArgs, env: launchEnv }) as CodexAdmissionContext;
          let admission: unknown;
          try { admission = await assess(context); } catch { admission = undefined; }
          if (aborted()) { await end({ kind: 'interrupted' }); return; }
          const verdict = checkCodexAdmission(admission, request.profile.kind);
          if (verdict.error) {
            await end({ kind: 'error', reason: verdict.error, detail: `Допуск не выдан (${verdict.reason}): ${verdict.detail}` }); return;
          }
          if (!diagnostic({ code: 'codex_limitations', detail: CODEX_LIMITATIONS.join(',') })) {
            await end({ kind: 'error', reason: 'practical_admission_blocked', detail: 'Допуск не выдан (assessment_failed): лимит диагностики не позволяет сообщить границы допуска' }); return;
          }
          // Повторная проверка файла, который получит runner. Это не гарантия: окно между проверкой и spawn остаётся.
          const recheck = await executableIdentity(detection.binaryPath);
          if (aborted()) { await end({ kind: 'interrupted' }); return; }
          if (recheck !== identity) { await end({ kind: 'error', reason: 'practical_admission_blocked', detail: 'Допуск не выдан (context_changed): executable изменился после оценки' }); return; }
          const parser = new CodexStreamParser({ ...options.parserLimits,
            forbiddenItems: request.profile.kind === 'codex-sandbox-read-v1' ? SANDBOX_FORBIDDEN_ITEMS : FORBIDDEN_ITEMS,
            rejectUnknownItems: request.profile.kind === 'codex-sandbox-read-v1' || options.parserLimits?.rejectUnknownItems === true,
            ...(request.resume ? { expectedThreadId: request.thread.threadId } : {}) });
          // До этого вызова процесс заведомо не запускался; после неизвестного throw факт запуска не доказан.
          launchAttempted = true;
          try {
            processRun = runner.start({ executable: frozenDetection.binaryPath ?? detection.binaryPath, args: launchArgs, cwd: request.cwd, stdin: built.stdin, env: launchEnv,
              timeoutMs: limits.timeoutMs, stopGraceMs: limits.stopGraceMs, drainTimeoutMs: limits.drainTimeoutMs, maxQueueBytes: limits.maxQueueBytes });
          } catch (cause) {
            const errorCode = errnoCode(cause);
            addIssue({ code: 'spawn_failed', operation: 'spawn', ...(errorCode ? { errorCode } : {}), detail: 'Запуск процесса завершился исключением' });
            throw cause;
          }
          // Результат фиксируется сразу: отказ done или результат без completion не равны подтверждению.
          processRun.done.then(settled => {
            if (settled?.completion) processResult = settled;
            else addIssue({ code: 'process_result_failed', operation: 'done', detail: 'Runner не вернул данные завершения' });
          }, cause => {
            const errorCode = errnoCode(cause);
            addIssue({ code: 'process_result_failed', operation: 'done', ...(errorCode ? { errorCode } : {}), detail: 'Ожидание завершения процесса завершилось ошибкой' });
          });
          const consume = async (stream: AsyncIterable<Uint8Array>, stderr: boolean): Promise<void> => {
            for await (const chunk of stream) {
              if (finished) break;
              if (stderr) {
                // Сырой stderr может содержать секреты. Сохраняем лишь факт и размер.
                diagnostic({ code: 'stderr', detail: `Получено ${chunk.byteLength} байт stderr; содержимое скрыто` });
                continue;
              }
              // run_started приходит из thread.started: CLI-ID не известен до протокола.
              for (const payload of parser.feed(chunk)) emit(payload);
              if (parser.error) { failure ??= { kind: 'error', ...parser.error }; stopProcess(); break; }
            }
          };
          // Ошибка каждого потока фиксируется отдельно; подписка сразу исключает unhandled rejection.
          const track = (stream: AsyncIterable<Uint8Array>, name: 'stdout' | 'stderr'): Promise<void> => consume(stream, name === 'stderr').catch(cause => {
            readFailed[name] = true;
            const errorCode = errnoCode(cause);
            addIssue({ code: 'stream_failed', operation: name, ...(errorCode ? { errorCode } : {}), detail: 'Ошибка чтения потока процесса' });
            failure ??= { kind: 'error', reason: 'protocol_incompatible', detail: 'Ошибка чтения потока процесса' };
            stopProcess();
          });
          const drained = Promise.all([track(processRun.stdout, 'stdout'), track(processRun.stderr, 'stderr')]).then(() => true);
          const processDone = await processRun.done;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const complete = await Promise.race([
            drained,
            new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), limits.drainTimeoutMs); }),
          ]);
          clearTimeout(timer);
          if (!complete) {
            drainForced = true;
            addIssue({ code: 'drain_timeout', operation: 'wait', detail: 'Потоки не закрылись за отведённое время' });
            stopProcess();
            await settleStops();
            finish({ kind: 'error', reason: 'drain_timeout', detail: 'Потоки не закрылись за отведённое время' }); return;
          }
          const failedBeforeEnd = parser.error !== undefined;
          for (const payload of parser.end()) emit(payload);
          // Отказ впервые на EOF (например, оборванная строка): наблюдённый exit не отменяет доступную остановку.
          if (!failedBeforeEnd && parser.error) { failure ??= { kind: 'error', ...parser.error }; stopProcess(); }
          for (const item of parser.diagnostics) diagnostic(item);
          // Отказ stop-метода мог прийти после done, но до терминального снимка.
          await settleStops();
          if (processDone.error) {
            finish({ kind: 'error', reason: reasonOf(processDone.error), detail: 'Процесс CLI завершился с ошибкой' });
          } else if (parser.error) finish({ kind: 'error', ...parser.error });
          else if (!parser.result) finish({ kind: 'error', reason: 'missing_result', detail: 'CLI не вернул обязательный terminal-результат хода' });
          else if (processDone.signal || (processDone.exitCode !== 0 && parser.result.kind === 'success')) finish({ kind: 'error', reason: 'nonzero_exit', detail: 'Завершение процесса не подтверждает успешный result' });
          else finish(parser.result);
        } catch {
          stopProcess();
          if (processRun) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([
              processRun.done.catch(() => undefined),
              new Promise(resolve => { timer = setTimeout(resolve, limits.drainTimeoutMs); }),
            ]);
            clearTimeout(timer);
            await settleStops();
          }
          const resultLost = completionIssues.some(item => item.code === 'process_result_failed');
          finish(resultLost ? { kind: 'error', reason: 'process_result_failed', detail: 'Не удалось получить результат завершения процесса' }
            : { kind: 'error', reason: 'spawn_failed', detail: 'Не удалось выполнить запуск CLI' });
        }
      };
      // Бюджет включает диагностику/проверку допуска, даже при неисправной внедрённой зависимости.
      const deadline = setTimeout(() => {
        deadlineFired = true;
        failure ??= { kind: 'error', reason: 'timeout', detail: 'Превышено время запуска' };
        addIssue({ code: 'timeout', operation: 'wait', detail: 'Превышено время запуска' });
        stopProcess();
        setTimeout(() => finish(failure!), limits.drainTimeoutMs);
      }, limits.timeoutMs + limits.stopGraceMs + limits.drainTimeoutMs);
      void execute();
      return run;
    },
  };
}
