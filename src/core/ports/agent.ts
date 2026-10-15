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
export interface AgentRunRequest {
  sessionId: string;
  turnId: string;
  participantId: string;
  workspaceId: string;
  cwd: string;
  prompt: string;
  agentSessionId: string;
  resume: boolean;
  profile: AgentAccessProfile;
  model?: string;
  maxTurns?: number;
  env: AgentEnvironment;
  persistSession?: boolean;
}
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
export interface AgentDetection {
  /** Готовность binary/interface/auth; не допуск конкретного профиля. */
  status: 'available' | 'unavailable';
  binaryPath: string | null;
  version: string | null;
  auth: 'authenticated' | 'unauthenticated' | 'unknown';
  capabilities: AgentCapabilities;
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
export interface AgentAdapter {
  detect(options?: AgentDetectOptions): Promise<AgentDetection>;
  start(request: AgentRunRequest): Promise<AgentRun>;
}
