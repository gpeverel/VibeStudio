/** Контракт событий 0C. sessionId приложения не равен ID диалога CLI. */
export type AgentErrorReason =
  | 'binary_missing' | 'not_authenticated' | 'capability_missing' | 'invalid_request'
  | 'profile_unverified' | 'profile_unsupported' | 'spawn_failed' | 'timeout'
  | 'practical_admission_blocked' | 'practical_admission_unsupported'
  | 'runtime_inventory_unknown' | 'runtime_inventory_mismatch'
  | 'drain_timeout' | 'output_limit' | 'protocol_incompatible' | 'missing_result'
  | 'signal_failed' | 'stream_failed' | 'process_result_failed' | 'exit_unconfirmed'
  | 'nonzero_exit' | 'network' | 'overloaded' | 'rate_limit' | 'unknown';

/** Источник наблюдения не равен происхождению расширения и не доказывает его исполнение. */
export type InventoryProvenance = 'cli-init' | 'effective-config' | 'version-contract';
export type InventoryOrigin = 'project' | 'user' | 'builtin' | 'managed' | 'unknown';
export type InventoryFact<T> = { readonly provenance: InventoryProvenance } & (
  | { readonly state: 'known'; readonly value: T }
  | { readonly state: 'unknown'; readonly reason: 'missing' | 'malformed' | 'unsupported' | 'unattributed' }
  | { readonly state: 'conflict'; readonly reason: 'source_conflict' }
);
export interface RuntimeInventoryEntry {
  /** SHA-256 имени: исходные имена, пути, команды и значения конфигурации не передаются. */
  readonly id: string;
  readonly origin: InventoryOrigin;
}
/** Безопасный ограниченный снимок регистрации из init; не effective-политика и не разрешение.
 * Пустой known-список означает только явно сообщённый пустой список этого поля.
 * Наблюдения об отсутствующих hooks/managed-источниках из init не выводятся. */
export interface RuntimeInventory {
  /** Известные имена инструментов из закрытого словаря; остальные — SHA-256. */
  readonly tools: InventoryFact<readonly string[]>;
  readonly plugins: InventoryFact<readonly RuntimeInventoryEntry[]>;
  readonly mcpServers: InventoryFact<readonly RuntimeInventoryEntry[]>;
  /** Имена этих регистраций всегда передаются как SHA-256. */
  readonly skills: InventoryFact<readonly string[]>;
  readonly slashCommands: InventoryFact<readonly string[]>;
  readonly agents: InventoryFact<readonly string[]>;
  readonly cliVersion: InventoryFact<string>;
  /** Только dontAsk сохраняется открытым текстом; прочие значения — SHA-256. */
  readonly permissionMode: InventoryFact<string>;
}

/** Сериализуемые факты завершения; без Node-типов, Error и идентичности старого PID. */
export type ProcessCompletionIssueCode =
  | 'spawn_failed' | 'timeout' | 'drain_timeout' | 'output_limit' | 'stdin_failed'
  | 'unsupported_platform' | 'signal_failed' | 'stream_failed'
  | 'process_result_failed' | 'exit_unconfirmed';

export interface ProcessCompletionIssue {
  readonly code: ProcessCompletionIssueCode;
  readonly operation?: 'spawn' | 'interrupt' | 'kill' | 'stdin' | 'stdout' | 'stderr' | 'done' | 'wait';
  /** Безопасный код системной ошибки, если он известен; не замена типизированной причине. */
  readonly errorCode?: string;
  /** Ограниченное безопасное описание, без сырого вывода, prompt или stack. */
  readonly detail: string;
}

export interface ProcessSignalResult {
  readonly signal: 'SIGTERM' | 'SIGKILL';
  readonly target: 'process' | 'group';
  /** sent подтверждает отправку; not_found (ESRCH) не подтверждает exit. */
  readonly status: 'sent' | 'not_found' | 'failed';
  readonly errorCode?: string;
  readonly detail?: string;
}

/** ended — наблюдённый EOF процесса, не доказательство чтения всей очереди потребителем;
 * forced_closed — принудительное закрытие, а не EOF.
 * Ошибка чтения сохраняется в issues, даже если позже наблюдался EOF. */
export type ProcessStreamState = 'not_started' | 'ended' | 'errored' | 'forced_closed' | 'unconfirmed';

export interface ProcessCompletion {
  /** not_started требует знания, что запуск не состоялся. exited — наблюдения exit
   * основного процесса; resolved done, null-коды и закрытие pipes его не доказывают. */
  readonly process:
    | { readonly state: 'not_started' }
    | { readonly state: 'exited'; readonly exitCode: number | null; readonly signal: string | null }
    | { readonly state: 'unconfirmed' };
  readonly stdout: ProcessStreamState;
  readonly stderr: ProcessStreamState;
  /** Только известные результаты отправки; пустой список не доказывает остановку. */
  readonly signals: readonly ProcessSignalResult[];
  /** settled означает завершение ожидания без deadline, но не отсутствие ошибок. */
  readonly wait: 'settled' | 'deadline';
  /** Все наблюдённые причины сохраняются независимо от Stop и первой ошибки. */
  readonly issues: readonly ProcessCompletionIssue[];
  /** Даже exited и ended не доказывают остановку detached/setsid-потомков. */
  readonly descendants: 'not_guaranteed';
}

export interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** Оценка всей беседы CLI, включая прежние ходы при resume; не стоимость нового хода. */
  costUsd?: number;
  durationMs?: number;
}

/** Исход задачи/протокола. Сам по себе не описывает завершение управляемого запуска. */
export type AgentRunResult =
  | { kind: 'success'; text?: string; usage?: AgentUsage }
  | { kind: 'error'; reason: AgentErrorReason; detail: string }
  | { kind: 'max_turns'; usage?: AgentUsage }
  | { kind: 'interrupted' }
  | { kind: 'limit'; usage?: AgentUsage; resetAt?: string };

/** Единый неизменяемый после выдачи снимок для done и единственного run_finished.
 * Принятый Stop требует kind=interrupted, сохраняя completion со всеми ошибками.
 * При зависшем чтении очереди адаптером известный ended runner сохраняется.
 * Исчерпание ожидания отражается отдельно через drain_timeout в issues
 * и wait=deadline и запрещает success.
 * Success требует подтверждённого exit(0), EOF обоих потоков и отсутствия ошибок. */
export type AgentRunCompletion = AgentRunResult & {
  /** Только принятый пользовательский interrupt/kill; внутренняя очистка не считается Stop. */
  readonly stopAccepted: boolean;
  readonly completion: ProcessCompletion;
};

/** snapshot заменяет предыдущее значение; usage всегда абсолютный снимок. */
export type NormalizedPayload =
  | { type: 'run_started'; agentSessionId: string }
  | { type: 'text'; messageId: string; mode: 'delta' | 'snapshot'; text: string }
  | { type: 'tool_started'; toolCallId: string; tool: string; inputPreview: string }
  | { type: 'tool_finished'; toolCallId: string; isError: boolean }
  | { type: 'permission_denied'; tool: string; inputPreview: string; reason: string;
      scope: 'turn' | 'session' | 'unknown'; source: 'allow_missing' | 'deny' | 'external' | 'unknown' }
  | { type: 'retry'; attempt?: number; reason: string }
  | { type: 'usage'; usage: AgentUsage; mode: 'snapshot'; messageId?: string }
  | { type: 'rate_limit'; status: string; resetAt?: string }
  | { type: 'run_finished'; result: AgentRunCompletion };

export type AgentEvent = NormalizedPayload & {
  schemaVersion: 1;
  eventId: string;
  sessionId: string;
  turnId: string;
  participantId: string;
  seq: number;
  timestamp: string;
};

/** Только безопасные метаданные: сырой stdout/stderr и входы инструментов не сохраняются. */
export interface AgentDiagnostic { code: string; detail: string }
