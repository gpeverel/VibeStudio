import type { AgentDiagnostic, AgentErrorReason, AgentEvent, AgentRunCompletion } from '../../shared/agent.ts';
export type { AgentDiagnostic, AgentErrorReason, AgentEvent, AgentRunCompletion, AgentRunResult, AgentUsage, NormalizedPayload,
  InventoryFact, InventoryOrigin, InventoryProvenance, RuntimeInventory, RuntimeInventoryEntry,
  ProcessCompletion, ProcessCompletionIssue, ProcessCompletionIssueCode, ProcessSignalResult, ProcessStreamState } from '../../shared/agent.ts';

export type ReadTool = 'Read' | 'Glob' | 'Grep';
/** Legacy strict: отсутствие kind сохраняет прежние требования изоляции. */
export interface AccessProfile {
  kind?: never;
  mode: 'read-only';
  tools: readonly ReadTool[];
  allow: readonly string[];
  deny: readonly string[];
  configPolicy: {
    settingSources: readonly [];
    loadHooks: false;
    loadMcp: false;
    loadPlugins: false;
  };
  fs: {
    readRoots: readonly string[];
    writeRoots: readonly [];
    runtimeWriteRoots: readonly string[];
    protectedPaths: readonly string[];
    gitCommonDir?: string;
  };
  network: 'provider-only';
}

/** Политика чтения доверенного проекта, а не обеспеченная ОС-граница процесса.
 * Штатная конфигурация CLI доверена пользователю; полный managed-аудит не требуется.
 * Обязательные настройки запуска и наблюдённый inventory проверяются адаптером. */
export interface PracticalLocalReadProfile {
  kind: 'practical-local-v1';
  mode: 'read-only';
  tools: readonly ReadTool[];
  allow: readonly string[];
  deny: readonly string[];
  /** Ожидаемая область операций; не ограничивает доступ CLI средствами ОС. */
  workspaceRoot: string;
  /** Само поле доверия не заменяет допуск конкретного запуска. */
  projectTrust: 'trusted';
  configPolicy: {
    settingSources: readonly [];
    projectHooks: 'disabled';
    projectMcp: 'disabled';
    projectPlugins: 'disabled';
  };
}
export type AgentAccessProfile = AccessProfile | PracticalLocalReadProfile;

/** Значения принимаются только из документированного allowlist адаптера. */
export type AgentEnvironment = Readonly<Record<string, string>>;
/** Общие данные хода приложения. Профиль, форма CLI-ID и условия resume
 * определяются конкретным адаптером; ID приложения не заменяют CLI-ID. */
export interface AgentRunRequestBase {
  sessionId: string;
  turnId: string;
  participantId: string;
  workspaceId: string;
  cwd: string;
  prompt: string;
  model?: string;
  maxTurns?: number;
  env: AgentEnvironment;
  persistSession?: boolean;
}
/** Существующий запрос Claude: заранее выбранный CLI-ID и прежние профили.
 * Другие адаптеры задают собственный запрос на основе AgentRunRequestBase. */
export interface AgentRunRequest extends AgentRunRequestBase {
  agentSessionId: string;
  resume: boolean;
  profile: AgentAccessProfile;
}
/** Существующий набор возможностей Claude, включая его конкретные флаги.
 * Другие CLI передают свой тип в AgentDetection, без фиктивных значений. */
export interface AgentCapabilities {
  streamJson: boolean;
  partialMessages: boolean;
  sessionId: boolean;
  resume: boolean;
  noSessionPersistence: boolean;
  maxTurns: boolean;
  restricted: boolean;
  safeMode: boolean;
  tools: boolean;
  settingSources: boolean;
  strictMcpConfig: boolean;
  permissionPrompts: boolean;
  /** Только legacy strict. Объявленные флаги и practical-допуск не дают verified. */
  readOnly: 'verified' | 'unverified' | 'unsupported';
}
export interface AgentDetection<TCapabilities = AgentCapabilities> {
  /** Готовность binary/interface/auth; не допуск конкретного профиля. */
  status: 'available' | 'unavailable';
  binaryPath: string | null;
  version: string | null;
  auth: 'authenticated' | 'unauthenticated' | 'unknown';
  capabilities: TCapabilities;
  unavailable: { reason: AgentErrorReason; detail: string }[];
}
export interface AgentDetectOptions { binaryPath?: string; env?: AgentEnvironment }
export interface AgentRun {
  events: AsyncIterable<AgentEvent>;
  /** Принятый до завершения Stop запрещает success; повтор не меняет терминальный снимок. */
  interrupt(): Promise<void>;
  kill(): Promise<void>;
  /** Тот же исход и completion, что у единственного run_finished; не гарантия очистки. */
  done: Promise<AgentRunCompletion>;
  readonly diagnostics: readonly AgentDiagnostic[];
}
/** Параметры по умолчанию сохраняют контракт прежнего Claude-потребителя.
 * Конкретный адаптер связывает собственные запрос и возможности с общим
 * контрактом событий/завершения; перенос истории между CLI не подразумевается. */
export interface AgentAdapter<TRequest extends AgentRunRequestBase = AgentRunRequest, TCapabilities = AgentCapabilities> {
  detect(options?: AgentDetectOptions): Promise<AgentDetection<TCapabilities>>;
  start(request: TRequest): Promise<AgentRun>;
}
