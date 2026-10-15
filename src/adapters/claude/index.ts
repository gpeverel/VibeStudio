import { randomUUID } from 'node:crypto';
import type { AgentAdapter, AgentDetection, AgentDetectOptions, AgentDiagnostic, AgentEnvironment, AgentErrorReason, AgentEvent, AgentRun, AgentRunCompletion, AgentRunRequest, AgentRunResult, NormalizedPayload, ProcessCompletion, ProcessCompletionIssue } from '../../core/ports/agent.ts';
import type { ProcessRequest, ProcessResult, ProcessRun, ProcessRunner } from '../../core/ports/process-runner.ts';
import { createProcessRunner } from '../process-runner/index.ts';
import { BoundedQueue } from '../process-runner/queue.ts';
import { createClaudeAdmission } from './admission.ts';
import { buildClaudeArgs, buildClaudeEnv, forbiddenEnvNames } from './args.ts';
import { detectClaude } from './detect.ts';
import { ClaudeStreamParser } from './parser.ts';
import type { ParserOptions } from './parser.ts';
import { PRACTICAL_LIMITATIONS, UNVERIFIED_ACCESS_DETAIL, getAccessProfileKind, isRuntimeInventoryExpectation, validateAccessProfile } from './profile.ts';
import type { AccessVerifier, PracticalAdmissionContext, PracticalAdmissionEvaluator, PracticalAdmissionLimitation, PracticalAdmissionReason, RuntimeInventoryExpectation } from './profile.ts';

export interface ClaudeAdapterOptions {
  runner?: ProcessRunner;
  binaryPath?: string;
  env?: AgentEnvironment;
  /** Только доверенная композиция/тестовый стенд. Никогда не принимать через IPC. */
  detect?: (options: AgentDetectOptions) => Promise<AgentDetection>;
  /** Только strict-маршрут (профиль без kind): проверенный launch. */
  verifyAccess?: AccessVerifier;
  /** Только практический маршрут. Доверенная композиция/тестовый стенд, никогда не IPC и не config.
   * Без неё работает production-оценщик admission.ts (P2b), доверяющий штатной конфигурации CLI
   * при сохранении проверок обязательных настроек запуска. Переопределение — явная подстановка. */
  assessPractical?: PracticalAdmissionEvaluator;
  parserLimits?: ParserOptions;
  maxQueue?: number;
  maxQueueBytes?: number;
  maxDiagBytes?: number;
  timeoutMs?: number;
  stopGraceMs?: number;
  drainTimeoutMs?: number;
}
export const DEFAULT_AGENT_LIMITS = {
  maxQueue: 256,
  maxQueueBytes: 1_048_576,
  maxDiagBytes: 16_384,
  timeoutMs: 120_000,
  stopGraceMs: 500,
  drainTimeoutMs: 1_000,
};

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
const PRACTICAL_DETAIL_LIMIT = 512;

/** Только безопасный errno-код: текст исходной ошибки в completion не попадает. */
function errnoCode(cause: unknown): string | undefined {
  const code = (cause as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' ? code.slice(0, 32) : undefined;
}
/** Причина процесса → причина исхода; прежнее сопоставление stdin/платформы сохранено. */
function reasonOf(code: ProcessCompletionIssue['code']): AgentErrorReason {
  return code === 'stdin_failed' || code === 'unsupported_platform' ? 'spawn_failed' : code;
}
/** Чистое завершение: подтверждённый exit(0), штатный EOF обоих потоков, без ошибок и deadline. */
function isCleanCompletion(completion: ProcessCompletion): boolean {
  return completion.process.state === 'exited' && completion.process.exitCode === 0 && completion.process.signal === null
    && completion.stdout === 'ended' && completion.stderr === 'ended' && completion.wait === 'settled' && completion.issues.length === 0;
}

const PRACTICAL_REASONS: readonly PracticalAdmissionReason[] = ['assessment_missing', 'project_untrusted', 'prerequisite_unknown', 'configuration_conflict', 'cli_unsupported', 'assessment_failed',
  'context_changed', 'runtime_inventory_unknown', 'runtime_inventory_mismatch'];
interface PracticalVerdict {
  error?: 'practical_admission_blocked' | 'practical_admission_unsupported';
  reason: PracticalAdmissionReason | 'ready';
  detail: string;
  /** Только известные значения: произвольные строки оценщика в диагностику не попадают. */
  limitations: PracticalAdmissionLimitation[];
  /** Только для ready: независимое ожидание inventory и отпечаток контекста допуска. */
  expectedInventory?: RuntimeInventoryExpectation;
  contextFingerprint?: string;
}
const isPracticalReason = (value: unknown): value is PracticalAdmissionReason => PRACTICAL_REASONS.includes(value as PracticalAdmissionReason);
const isPracticalLimitation = (value: unknown): value is PracticalAdmissionLimitation => PRACTICAL_LIMITATIONS.includes(value as PracticalAdmissionLimitation);

/** Runtime-проверка результата доверенной оценки: неполная или неизвестная форма — не допуск. */
function checkPracticalAdmission(admission: unknown, production: boolean): PracticalVerdict {
  const blocked = (reason: PracticalAdmissionReason, detail: string, limitations: PracticalAdmissionLimitation[] = []): PracticalVerdict =>
    ({ error: 'practical_admission_blocked', reason, detail, limitations });
  if (!admission || typeof admission !== 'object') return blocked('assessment_failed', 'оценка допуска не вернула результат');
  const value = admission as { status?: unknown; reason?: unknown; detail?: unknown; limitations?: unknown; expectedInventory?: unknown; contextFingerprint?: unknown };
  const detail = typeof value.detail === 'string' ? value.detail.slice(0, PRACTICAL_DETAIL_LIMIT) : '';
  const reported = Array.isArray(value.limitations) ? value.limitations : undefined;
  const known = [...new Set((reported ?? []).filter(isPracticalLimitation))];
  if (value.status === 'blocked' || value.status === 'unsupported') {
    if (!isPracticalReason(value.reason) || !detail) return blocked('assessment_failed', 'некорректный результат оценки допуска', known);
    return { error: value.status === 'blocked' ? 'practical_admission_blocked' : 'practical_admission_unsupported', reason: value.reason, detail, limitations: known };
  }
  if (value.status !== 'ready' || !detail || !reported) return blocked('assessment_failed', 'некорректный результат оценки допуска', known);
  if (reported.length !== PRACTICAL_LIMITATIONS.length || known.length !== PRACTICAL_LIMITATIONS.length) {
    return blocked('prerequisite_unknown', 'ready без полного набора известных ограничений practical-local-v1', known);
  }
  const hasInventory = value.expectedInventory !== undefined;
  const hasFingerprint = value.contextFingerprint !== undefined;
  if ((hasInventory && !isRuntimeInventoryExpectation(value.expectedInventory))
    || (hasFingerprint && (typeof value.contextFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(value.contextFingerprint)))) {
    return blocked('assessment_failed', 'ready с некорректным ожиданием inventory или отпечатком контекста', known);
  }
  // Половинчатый ready не допуск в любой ветке; production требует пару целиком.
  if (hasInventory !== hasFingerprint) return blocked('assessment_failed', 'ready только с одним из ожидания inventory и отпечатка контекста', known);
  if (production && !hasInventory) return blocked('prerequisite_unknown', 'ready без ожидаемого inventory и отпечатка контекста', known);
  return { reason: 'ready', detail, limitations: known,
    ...(hasInventory ? { expectedInventory: value.expectedInventory as RuntimeInventoryExpectation } : {}),
    ...(hasFingerprint ? { contextFingerprint: value.contextFingerprint as string } : {}) };
}

export function createClaudeAdapter(options: ClaudeAdapterOptions = {}): AgentAdapter {
  const runner = options.runner ?? createProcessRunner();
  const baseEnv = buildClaudeEnv(options.env ?? process.env);
  const limits = { ...DEFAULT_AGENT_LIMITS, ...options };
  for (const name of Object.keys(DEFAULT_AGENT_LIMITS) as (keyof typeof DEFAULT_AGENT_LIMITS)[]) {
    if (!Number.isSafeInteger(limits[name]) || limits[name] < 1 || limits[name] > 2_147_483_647) throw new Error('Лимиты адаптера должны быть конечными положительными целыми');
  }
  const sequences = new Map<string, number>();
  // Production-путь practical: без явной подстановки оценивает admission.ts (без кэша решений).
  const productionAdmission = options.assessPractical ? undefined : createClaudeAdmission();
  const detect =(request: AgentDetectOptions = {}): Promise<AgentDetection> => {
    const params = { binaryPath: request.binaryPath ?? options.binaryPath, env: request.env ?? baseEnv };
    return options.detect ? options.detect(params) : detectClaude(runner, params);
  };
  return {
    detect,
    start: async (input: AgentRunRequest): Promise<AgentRun> => {
      // kind читается из исходного объекта: structuredClone теряет унаследованные/неперечислимые поля.
      const originalKind = getAccessProfileKind((input as { profile?: unknown } | null | undefined)?.profile);
      const frozenRequest = snapshot(input);
      const request = frozenRequest ?? input;
      const queue = new BoundedQueue<AgentEvent>(limits.maxQueueBytes, event => Buffer.byteLength(JSON.stringify(event)), limits.maxQueue);
      const diagnostics: AgentDiagnostic[] = [];
      let diagnosticBytes = 0;
      let processRun: ProcessRun | undefined;
      let finished = false;
      /** Только принятый пользовательский Stop; внутренняя очистка при ошибке им не является. */
      let stopped = false;
      let failure: AgentRunResult | undefined;
      // Факты завершения. Отсутствие наблюдения остаётся unconfirmed, а не подтверждением.
      let launchAttempted = false;
      let processResult: ProcessResult | undefined;
      let deadlineFired = false;
      let drainForced = false;
      const readFailed = { stdout: false, stderr: false };      const completionIssues: ProcessCompletionIssue[] = [];
      const pendingStops = new Map<Promise<void>, 'interrupt' | 'kill'>();
      let resolveDone!: (result: AgentRunCompletion) => void;
      const done = new Promise<AgentRunCompletion>(resolve => { resolveDone = resolve; });
      const sameIssue = (a: ProcessCompletionIssue, b: ProcessCompletionIssue): boolean => a.code === b.code && a.operation === b.operation && a.errorCode === b.errorCode;
      const addIssue = (item: ProcessCompletionIssue): void => {
        if (!finished && !completionIssues.some(known => sameIssue(known, item))) completionIssues.push(item);
      };
      /** Throw и rejection interrupt()/kill() сохраняются; успешная отправка здесь не выдумывается. */
      const stopProcess = (hard = true): void => {
        const operation = hard ? 'kill' : 'interrupt';
        const lost = (cause: unknown): void => {
          const errorCode = errnoCode(cause);
          addIssue({ code: 'signal_failed', operation, ...(errorCode ? { errorCode } : {}), detail: 'Остановка процесса завершилась ошибкой' });
        };
        try {
          const stopping = hard ? processRun?.kill() : processRun?.interrupt();
          if (stopping) {
            const tracked: Promise<void> = Promise.resolve(stopping).then(() => undefined, lost).finally(() => { pendingStops.delete(tracked); });
            pendingStops.set(tracked, operation);
          }
        } catch (cause) { lost(cause); }
      };
      /** Отказ stop-метода может прийти после done: ждём его, но не дольше drain-лимита. */
      const settleStops = async (): Promise<void> => {
        if (!pendingStops.size) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([Promise.allSettled([...pendingStops.keys()]), new Promise(resolve => { timer = setTimeout(resolve, limits.drainTimeoutMs); })]);
        clearTimeout(timer);
      };
      const assembleCompletion = (): ProcessCompletion => {
        const base = processResult?.completion;
        const issues = (base?.issues ?? []).map(item => ({ ...item }));
        for (const item of completionIssues) if (!issues.some(known => sameIssue(known, item))) issues.push({ ...item });
        // Stop-метод, не давший результата к снимку, не считается успешной отправкой: ожидание исчерпано.
        for (const operation of new Set(pendingStops.values())) {
          issues.push({ code: 'timeout', operation, detail: 'Результат остановки не получен к завершению; отправка сигнала не подтверждена' });
        }
        const wait = deadlineFired || drainForced || pendingStops.size > 0 || base?.wait === 'deadline' ? 'deadline' as const : 'settled' as const;
        const frozen = (): readonly ProcessCompletionIssue[] => Object.freeze(issues.map(item => Object.freeze({ ...item })));
        if (base) {
          // Копия, а не ссылки runner: поздняя мутация его объектов не меняет выданный terminal.
          const baseProcess = base.process.state === 'exited'
            ? Object.freeze({ state: 'exited' as const, exitCode: base.process.exitCode, signal: base.process.signal })
            : Object.freeze({ state: base.process.state });
          const stream = (name: 'stdout' | 'stderr'): ProcessCompletion['stdout'] => (readFailed[name] ? 'errored' : base[name]);
          return Object.freeze({ process: baseProcess, stdout: stream('stdout'), stderr: stream('stderr'),
            signals: Object.freeze(base.signals.map(item => Object.freeze({ ...item }))), wait, issues: frozen(), descendants: 'not_guaranteed' as const });
        }
        if (!launchAttempted) {
          return Object.freeze({ process: Object.freeze({ state: 'not_started' as const }), stdout: 'not_started' as const, stderr: 'not_started' as const,
            signals: Object.freeze([]), wait, issues: frozen(), descendants: 'not_guaranteed' as const });
        }
        // Запуск начат, но достоверного результата runner нет: exit и потоки не подтверждены.
        if (!issues.some(item => item.code === 'process_result_failed' || item.code === 'spawn_failed')) {
          issues.push({ code: 'exit_unconfirmed', operation: 'wait', detail: 'Результат завершения процесса не получен' });
        }
        const stream = (name: 'stdout' | 'stderr'): ProcessCompletion['stdout'] => (readFailed[name] ? 'errored' : 'unconfirmed');
        return Object.freeze({ process: Object.freeze({ state: 'unconfirmed' as const }), stdout: stream('stdout'), stderr: stream('stderr'),
          signals: Object.freeze([]), wait, issues: frozen(), descendants: 'not_guaranteed' as const });
      };
      const envelope = (payload: NormalizedPayload): AgentEvent => {
        const seq = (sequences.get(request.sessionId) ?? 0) + 1;
        sequences.set(request.sessionId, seq);
        return { ...payload, schemaVersion: 1, eventId: randomUUID(), sessionId: request.sessionId,
          turnId: request.turnId, participantId: request.participantId, seq, timestamp: new Date().toISOString() };
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
        const final: AgentRunCompletion = Object.freeze({ ...outcome, stopAccepted: stopped, completion });
        queue.finish(envelope({ type: 'run_finished', result: final }));
        resolveDone(final);
      };
      const emit = (payload: NormalizedPayload): void => {
        if (finished || failure) return;
        if (!queue.push(envelope(payload))) {
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
          if (originalKind === 'unknown' || getAccessProfileKind(request.profile) !== originalKind) {
            finish({ kind: 'error', reason: 'profile_unsupported', detail: 'Неизвестный вид профиля доступа' }); return;
          }
          const practical = originalKind === 'practical-local-v1';
          if (practical && (request.profile as { projectTrust?: unknown }).projectTrust !== 'trusted') {
            finish({ kind: 'error', reason: 'practical_admission_blocked', detail: 'Практический допуск не выдан (project_untrusted): проект не помечен доверенным' }); return;
          }
          const profileIssues = validateAccessProfile(request.profile, request.cwd);
          if (profileIssues.length) { finish({ kind: 'error', ...profileIssues[0]! }); return; }
          let built: ReturnType<typeof buildClaudeArgs>;
          try { built = buildClaudeArgs({ ...request, env: { ...baseEnv, ...request.env } }); }
          catch { finish({ kind: 'error', reason: 'invalid_request', detail: 'Некорректный запрос запуска' }); return; }
          if (practical) {
            const forbidden = forbiddenEnvNames(request.env);
            if (forbidden.length) { finish({ kind: 'error', reason: 'invalid_request', detail: `Запрещённые переменные окружения: ${forbidden.join(', ').slice(0, PRACTICAL_DETAIL_LIMIT)}` }); return; }
          }
          const detection = await detect({ env: built.env });
          if (aborted()) { finish({ kind: 'interrupted' }); return; }
          const unavailable = detection.unavailable.find(item => item.reason !== 'profile_unverified');
          if (unavailable || !detection.binaryPath || detection.auth !== 'authenticated') {
            finish({ kind: 'error', reason: unavailable?.reason ?? 'capability_missing', detail: unavailable?.detail ?? 'CLI не готов к запуску' }); return;
          }
          if ((request.resume && !detection.capabilities.resume) || (request.maxTurns !== undefined && !detection.capabilities.maxTurns) || (request.persistSession === false && !detection.capabilities.noSessionPersistence)) {
            finish({ kind: 'error', reason: 'capability_missing', detail: 'CLI не подтвердил запрошенную возможность запуска' }); return;
          }
          let launch: (processRequest: ProcessRequest) => ProcessRun;
          let launchArgs: readonly string[] = built.args;
          let launchEnv: Readonly<Record<string, string>> = built.env;
          let executable: string = detection.binaryPath;
          let expectedInventory: RuntimeInventoryExpectation | undefined;
          if (practical) {
            // Не AccessVerification: ready не несёт verified/evidence и не изображает изоляцию.
            const assess = options.assessPractical ?? productionAdmission?.assess;
            if (!assess) {
              finish({ kind: 'error', reason: 'practical_admission_blocked', detail: 'Практический допуск не выдан (assessment_missing): оценка допуска не подключена' }); return;
            }
            const frozenDetection = snapshot(detection);
            if (!frozenDetection) { finish({ kind: 'error', reason: 'practical_admission_blocked', detail: 'Практический допуск не выдан (assessment_failed): диагностика CLI не зафиксирована' }); return; }
            launchArgs = deepFreeze(built.args);
            launchEnv = deepFreeze(built.env);
            executable = frozenDetection.binaryPath ?? executable;
            const context = deepFreeze({ detection: frozenDetection, request, args: launchArgs, env: launchEnv }) as PracticalAdmissionContext;
            let admission: unknown;
            try { admission = await assess(context); } catch { admission = undefined; }
            if (aborted()) { finish({ kind: 'interrupted' }); return; }
            const verdict = checkPracticalAdmission(admission, productionAdmission !== undefined);
            const limitationsVisible = verdict.limitations.length > 0
              && diagnostic({ code: 'practical_limitations', detail: verdict.limitations.join(',') });
            if (verdict.error) {
              finish({ kind: 'error', reason: verdict.error, detail: `Практический допуск не выдан (${verdict.reason}): ${verdict.detail}` }); return;
            }
            if (!limitationsVisible) {
              finish({ kind: 'error', reason: 'practical_admission_blocked', detail: 'Практический допуск не выдан (assessment_failed): лимит диагностики не позволяет сообщить границы допуска' }); return;
            }
            // Повторно собираем доступные факты executable и сверяем отпечаток с замороженным контекстом.
            // Detect версии/auth не повторяется, глобальная конфигурация не читается; внешние гонки остаются.
            if (productionAdmission && verdict.contextFingerprint) {
              let unchanged = false;
              try { unchanged = await productionAdmission.recheck(context, verdict.contextFingerprint); } catch { unchanged = false; }
              if (aborted()) { finish({ kind: 'interrupted' }); return; }
              if (!unchanged) {
                finish({ kind: 'error', reason: 'practical_admission_blocked', detail: 'Практический допуск не выдан (context_changed): контекст запуска изменился после оценки' }); return;
              }
            }
            expectedInventory = verdict.expectedInventory;
            if (verdict.contextFingerprint) diagnostic({ code: 'practical_context', detail: `fingerprint:${verdict.contextFingerprint.slice(0, 16)}` });
            launch = processRequest => runner.start(processRequest);
          } else {
            const verification = await options.verifyAccess?.({ detection, request, args: built.args, env: built.env });
            if (aborted()) { finish({ kind: 'interrupted' }); return; }
            if (!verification || verification.status !== 'verified' || !verification.evidence.length || typeof verification.launch !== 'function') {
              finish({ kind: 'error', reason: verification?.status === 'unsupported' ? 'profile_unsupported' : 'profile_unverified',
                detail: `Запуск заблокирован: ${verification?.detail.slice(0, 512) || UNVERIFIED_ACCESS_DETAIL}` }); return;
            }
            launch = verification.launch;
          }
          // expectedInventory только у practical с ожиданием оценщика: init проверяется синхронно внутри разбора.
          // Расхождение — controlled error через failure и внутренний stopProcess, не пользовательский Stop.
          const parser = new ClaudeStreamParser({ ...options.parserLimits, expectedSessionId: request.agentSessionId, ...(expectedInventory ? { expectedInventory } : {}) });
          // До этого вызова процесс заведомо не запускался; после неизвестного throw факт запуска не доказан.
          launchAttempted = true;
          try {
            processRun = launch({ executable, args: launchArgs, cwd: request.cwd, stdin: built.stdin, env: launchEnv,
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
          emit({ type: 'run_started', agentSessionId: request.agentSessionId });
          const consume = async (stream: AsyncIterable<Uint8Array>, stderr: boolean): Promise<void> => {
            for await (const chunk of stream) {
              if (finished) break;
              if (stderr) {
                // Сырой stderr может содержать секреты. Сохраняем лишь факт и размер.
                diagnostic({ code: 'stderr', detail: `Получено ${chunk.byteLength} байт stderr; содержимое скрыто` });
                continue;
              }
              for (const payload of parser.feed(chunk)) if (payload.type !== 'run_started') emit(payload);
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
          for (const payload of parser.end()) if (payload.type !== 'run_started') emit(payload);
          // Отказ впервые на EOF (например init без завершающего LF): наблюдённый exit не отменяет доступную остановку.
          if (!failedBeforeEnd && parser.error) { failure ??= { kind: 'error', ...parser.error }; stopProcess(); }
          for (const item of parser.diagnostics) diagnostic(item);
          // Отказ stop-метода мог прийти после done, но до терминального снимка.
          await settleStops();
          if (processDone.error) {
            finish({ kind: 'error', reason: reasonOf(processDone.error), detail: 'Процесс CLI завершился с ошибкой' });
          } else if (parser.error) finish({ kind: 'error', ...parser.error });
          else if (!parser.result) finish({ kind: 'error', reason: 'missing_result', detail: 'CLI не вернул обязательный result' });
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
      // Бюджет включает диагностику/проверку профиля, даже при неисправной внедрённой зависимости.
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
