/** Контракт событий 0C. sessionId приложения не равен ID диалога CLI. */
export type AgentErrorReason =
  | 'binary_missing' | 'not_authenticated' | 'capability_missing' | 'invalid_request'
  | 'profile_unverified' | 'profile_unsupported' | 'spawn_failed' | 'timeout'
  | 'drain_timeout' | 'output_limit' | 'protocol_incompatible' | 'missing_result'
  | 'nonzero_exit' | 'network' | 'overloaded' | 'rate_limit' | 'unknown';

export interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** Оценка всей беседы CLI, включая прежние ходы при resume; не стоимость нового хода. */
  costUsd?: number;
  durationMs?: number;
}

export type AgentRunResult =
  | { kind: 'success'; text?: string; usage?: AgentUsage }
  | { kind: 'error'; reason: AgentErrorReason; detail: string }
  | { kind: 'max_turns'; usage?: AgentUsage }
  | { kind: 'interrupted' }
  | { kind: 'limit'; usage?: AgentUsage; resetAt?: string };

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
  | { type: 'run_finished'; result: AgentRunResult };

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
