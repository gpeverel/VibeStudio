import { randomUUID } from 'node:crypto';
import type { AgentAdapter, AgentDetection, AgentDetectOptions, AgentDiagnostic, AgentEnvironment, AgentEvent, AgentRun, AgentRunRequest, AgentRunResult, NormalizedPayload } from '../../core/ports/agent.ts';
import type { ProcessRequest, ProcessRun, ProcessRunner } from '../../core/ports/process-runner.ts';
import { createProcessRunner } from '../process-runner/index.ts';
import { BoundedQueue } from '../process-runner/queue.ts';
import { buildClaudeArgs, buildClaudeEnv, forbiddenEnvNames } from './args.ts';
import { detectClaude } from './detect.ts';
import { ClaudeStreamParser } from './parser.ts';
import type { ParserOptions } from './parser.ts';
import { UNVERIFIED_ACCESS_DETAIL, getAccessProfileKind, validateAccessProfile } from './profile.ts';
import type { AccessVerifier, PracticalAdmissionContext, PracticalAdmissionEvaluator, PracticalAdmissionLimitation, PracticalAdmissionReason } from './profile.ts';

export interface ClaudeAdapterOptions {
  runner?: ProcessRunner;
  binaryPath?: string;
  env?: AgentEnvironment;
  /** Только доверенная композиция/тестовый стенд. Никогда не принимать через IPC. */
  detect?: (options: AgentDetectOptions) => Promise<AgentDetection>;
  /** Только strict-маршрут (профиль без kind): проверенный launch. */
  verifyAccess?: AccessVerifier;
  /** Только практический маршрут. Доверенная композиция/тестовый стенд, никогда не IPC и не config.
   * В P1 production-реализации нет: без неё practical-local-v1 всегда отклоняется до prompt. */
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

const PRACTICAL_REASONS: readonly PracticalAdmissionReason[] = ['assessment_missing', 'project_untrusted', 'prerequisite_unknown', 'configuration_conflict', 'cli_unsupported', 'assessment_failed'];
/** Все три ограничения безусловны для practical-local-v1: пропуск не означает их отсутствие. */
const PRACTICAL_LIMITATIONS: readonly PracticalAdmissionLimitation[] = ['no_os_sandbox', 'no_provider_only_network', 'detached_children_not_guaranteed'];
interface PracticalVerdict {
  error?: 'practical_admission_blocked' | 'practical_admission_unsupported';
  reason: PracticalAdmissionReason | 'ready';
  detail: string;
  /** Только известные значения: произвольные строки оценщика в диагностику не попадают. */
  limitations: PracticalAdmissionLimitation[];
}
const isPracticalReason = (value: unknown): value is PracticalAdmissionReason => PRACTICAL_REASONS.includes(value as PracticalAdmissionReason);
const isPracticalLimitation = (value: unknown): value is PracticalAdmissionLimitation => PRACTICAL_LIMITATIONS.includes(value as PracticalAdmissionLimitation);

/** Runtime-проверка результата доверенной оценки: неполная или неизвестная форма — не допуск. */
function checkPracticalAdmission(admission: unknown): PracticalVerdict {
  const blocked = (reason: PracticalAdmissionReason, detail: string, limitations: PracticalAdmissionLimitation[] = []): PracticalVerdict =>
    ({ error: 'practical_admission_blocked', reason, detail, limitations });
  if (!admission || typeof admission !== 'object') return blocked('assessment_failed', 'оценка допуска не вернула результат');
  const value = admission as { status?: unknown; reason?: unknown; detail?: unknown; limitations?: unknown };
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
  return { reason: 'ready', detail, limitations: known };
}

export function createClaudeAdapter(options: ClaudeAdapterOptions = {}): AgentAdapter {
  const runner = options.runner ?? createProcessRunner();
  const baseEnv = buildClaudeEnv(options.env ?? process.env);
  const limits = { ...DEFAULT_AGENT_LIMITS, ...options };
  for (const name of Object.keys(DEFAULT_AGENT_LIMITS) as (keyof typeof DEFAULT_AGENT_LIMITS)[]) {
    if (!Number.isSafeInteger(limits[name]) || limits[name] < 1 || limits[name] > 2_147_483_647) throw new Error('Лимиты адаптера должны быть конечными положительными целыми');
  }
  const sequences = new Map<string, number>();
  const detect = (request: AgentDetectOptions = {}): Promise<AgentDetection> => {
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
      let stopped = false;
      let failure: AgentRunResult | undefined;
      let resolveDone!: (result: AgentRunResult) => void;
      const done = new Promise<AgentRunResult>(resolve => { resolveDone = resolve; });
      const stopProcess = (hard = true): void => {
        try {
          const stopping = hard ? processRun?.kill() : processRun?.interrupt();
          void stopping?.catch(() => { /* Общий deadline ограничивает неисправный runner. */ });
        } catch { /* Контроль done остаётся у общего deadline. */ }
      };
      const envelope = (payload: NormalizedPayload): AgentEvent => {
        const seq = (sequences.get(request.sessionId) ?? 0) + 1;
        sequences.set(request.sessionId, seq);
        return { ...payload, schemaVersion: 1, eventId: randomUUID(), sessionId: request.sessionId,
          turnId: request.turnId, participantId: request.participantId, seq, timestamp: new Date().toISOString() };
      };
      const diagnostic = (item: AgentDiagnostic): void => {
        const bytes = Buffer.byteLength(item.code + item.detail);
        if (diagnosticBytes + bytes <= limits.maxDiagBytes) { diagnostics.push(item); diagnosticBytes += bytes; }
      };
      const finish = (result: AgentRunResult): void => {
        if (finished) return;
        finished = true;
        clearTimeout(deadline);
        const final = stopped ? { kind: 'interrupted' as const } : failure ?? result;
        queue.finish(envelope({ type: 'run_finished', result: final }));
        resolveDone(final);
      };
      const emit = (payload: NormalizedPayload): void => {
        if (finished || failure) return;
        if (!queue.push(envelope(payload))) {
          failure = { kind: 'error', reason: 'output_limit', detail: 'Потребитель не успевает читать ограниченную очередь событий' };
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
          if (practical) {
            // Не AccessVerification: ready не несёт verified/evidence и не изображает изоляцию.
            if (!options.assessPractical) {
              finish({ kind: 'error', reason: 'practical_admission_blocked', detail: 'Практический допуск не выдан (assessment_missing): оценка допуска не подключена' }); return;
            }
            const frozenDetection = snapshot(detection);
            if (!frozenDetection) { finish({ kind: 'error', reason: 'practical_admission_blocked', detail: 'Практический допуск не выдан (assessment_failed): диагностика CLI не зафиксирована' }); return; }
            launchArgs = deepFreeze(built.args);
            launchEnv = deepFreeze(built.env);
            executable = frozenDetection.binaryPath ?? executable;
            const context = deepFreeze({ detection: frozenDetection, request, args: launchArgs, env: launchEnv }) as PracticalAdmissionContext;
            let admission: unknown;
            try { admission = await options.assessPractical(context); } catch { admission = undefined; }
            if (aborted()) { finish({ kind: 'interrupted' }); return; }
            const verdict = checkPracticalAdmission(admission);
            if (verdict.limitations.length) diagnostic({ code: 'practical_limitations', detail: verdict.limitations.join(',') });
            if (verdict.error) {
              finish({ kind: 'error', reason: verdict.error, detail: `Практический допуск не выдан (${verdict.reason}): ${verdict.detail}` }); return;
            }
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
          const parser = new ClaudeStreamParser({ ...options.parserLimits, expectedSessionId: request.agentSessionId });
          processRun = launch({ executable, args: launchArgs, cwd: request.cwd, stdin: built.stdin, env: launchEnv,
            timeoutMs: limits.timeoutMs, stopGraceMs: limits.stopGraceMs, drainTimeoutMs: limits.drainTimeoutMs, maxQueueBytes: limits.maxQueueBytes });
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
          const streams = Promise.all([consume(processRun.stdout, false), consume(processRun.stderr, true)]);
          // Подписываемся сразу, чтобы ошибка чтения не стала unhandled rejection.
          const drained = streams.then(() => true, () => {
            failure ??= { kind: 'error', reason: 'protocol_incompatible', detail: 'Ошибка чтения потока процесса' };
            stopProcess();
            return true;
          });
          const processResult = await processRun.done;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const complete = await Promise.race([
            drained,
            new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), limits.drainTimeoutMs); }),
          ]);
          clearTimeout(timer);
          if (!complete) {
            stopProcess();
            finish({ kind: 'error', reason: 'drain_timeout', detail: 'Потоки не закрылись за отведённое время' }); return;
          }
          for (const payload of parser.end()) if (payload.type !== 'run_started') emit(payload);
          for (const item of parser.diagnostics) diagnostic(item);
          if (processResult.error) {
            const reason = processResult.error === 'stdin_failed' || processResult.error === 'unsupported_platform' ? 'spawn_failed' : processResult.error;
            finish({ kind: 'error', reason, detail: 'Процесс CLI завершился с ошибкой' });
          } else if (parser.error) finish({ kind: 'error', ...parser.error });
          else if (!parser.result) finish({ kind: 'error', reason: 'missing_result', detail: 'CLI не вернул обязательный result' });
          else if (processResult.signal || (processResult.exitCode !== 0 && parser.result.kind === 'success')) finish({ kind: 'error', reason: 'nonzero_exit', detail: 'Завершение процесса не подтверждает успешный result' });
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
          }
          finish({ kind: 'error', reason: 'spawn_failed', detail: 'Не удалось выполнить запуск CLI' });
        }
      };
      // Бюджет включает диагностику/проверку профиля, даже при неисправной внедрённой зависимости.
      const deadline = setTimeout(() => {
        failure ??= { kind: 'error', reason: 'timeout', detail: 'Превышено время запуска' };
        stopProcess();
        setTimeout(() => finish(failure!), limits.drainTimeoutMs);
      }, limits.timeoutMs + limits.stopGraceMs + limits.drainTimeoutMs);
      void execute();
      return run;
    },
  };
}
