import { z } from 'zod';
import type { AgentEvent, AgentRunCompletion, ProcessCompletion } from './agent.ts';
import type { ProjectCommandConsentDecision } from './project-command-consent.ts';

export type AgentKind = 'claude' | 'codex';
export type SessionStatus = 'preparing' | 'needs_consent' | 'ready' | 'running' | 'stopping'
  | 'answered' | 'interrupted' | 'error' | 'recovery_required';
export type SoloErrorCode = 'invalid_request' | 'unauthorized' | 'not_found' | 'foreign_entity'
  | 'request_conflict' | 'busy' | 'invalid_transition' | 'store_failed' | 'workspace_failed'
  | 'consent_required' | 'consent_blocked' | 'history_missing' | 'adapter_unavailable'
  | 'recovery_required' | 'signal_failed' | 'internal_error'
  | 'invalid_project' | 'not_git_repository' | 'no_commits' | 'detached_head'
  | 'git_unavailable' | 'git_timeout' | 'git_failed';
export interface SoloError { code: SoloErrorCode; message: string }
export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: SoloError };
export interface ProjectView { id: string; name: string; setup: string | null; configVersion: number }
export interface OperationView {
  id: string; requestId: string; sessionId: string | null; kind: OperationKind;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'uncertain';
  error: SoloError | null;
}
export type OperationKind = 'select_project' | 'create_session' | 'prepare_setup' | 'confirm_setup'
  | 'revoke_consent' | 'send_turn' | 'stop';
export interface SessionView {
  id: string; projectId: string; title: string; status: SessionStatus; detail: string;
  participant: { id: string; cli: AgentKind; profile: string; context: 'new' | 'available' | 'missing' | 'unknown' };
  workspace: { id: string; state: 'creating' | 'ready' | 'missing' | 'uncertain'; branch: string };
  setup: { state: 'not_configured' | 'pending' | 'needs_consent' | 'running' | 'completed' | 'failed' | 'uncertain';
    command: string | null; decision: ProjectCommandConsentDecision | null; completion: ProcessCompletion | null;
    /** Только отображение доверенной области запуска; renderer не возвращает эти поля как разрешение. */
    execution?: { cwd: string; configVersion: number; environmentNames: string[];
      permissions: { fileSystem: 'read-only' | 'workspace-write' | 'unrestricted'; network: 'denied' | 'allowed'; elevated: boolean } } };
  result: AgentRunCompletion | null;
  actions: { send: boolean; stop: boolean; prepareSetup: boolean; newConversation: boolean; reason: string | null };
  limitations: readonly string[]; updatedAt: string;
}
export type SoloEventPayload =
  | { type: 'session_state'; status: SessionStatus; detail: string }
  | { type: 'user_message'; turnId: string; text: string; conversation: 'continue' | 'new' }
  | { type: 'agent'; event: AgentEvent }
  | { type: 'setup'; state: SessionView['setup']['state']; decision: ProjectCommandConsentDecision | null; completion: ProcessCompletion | null }
  | { type: 'recovery'; code: 'effect_uncertain' | 'workspace_missing' | 'history_missing' | 'recovered'; detail: string }
  | { type: 'diagnostic'; code: string; detail: string };
export interface SoloEvent { id: string; sessionId: string; seq: number; timestamp: string; payload: SoloEventPayload }
export interface EventPage { events: SoloEvent[]; nextCursor: number; hasMore: boolean }
export interface EventsAvailable { sessionId: string; seq: number }

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9:_.-]*$/);
const request = { requestId: id };
const session = { ...request, sessionId: id };
export const soloSchemas = {
  selectProject: z.object(request).strict(),
  listProjects: z.object({}).strict(),
  listSessions: z.object({}).strict(),
  getSession: z.object({ sessionId: id }).strict(),
  createSession: z.object({ ...request, projectId: id, cli: z.enum(['claude', 'codex']), title: z.string().trim().min(1).max(200).optional() }).strict(),
  prepareSetup: z.object(session).strict(),
  confirmSetup: z.object({ ...session, challengeId: id }).strict(),
  revokeConsent: z.object({ ...session, consentId: id }).strict(),
  sendTurn: z.object({ ...session, prompt: z.string().trim().min(1).max(64_000), conversation: z.enum(['continue', 'new']) }).strict(),
  stop: z.object(session).strict(),
  readEvents: z.object({ sessionId: id, after: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), limit: z.number().int().min(1).max(200) }).strict(),
};
export type SelectProjectRequest = z.infer<typeof soloSchemas.selectProject>;
export type CreateSessionRequest = z.infer<typeof soloSchemas.createSession>;
export type SessionCommandRequest = z.infer<typeof soloSchemas.prepareSetup>;
export type ConfirmSetupRequest = z.infer<typeof soloSchemas.confirmSetup>;
export type RevokeConsentRequest = z.infer<typeof soloSchemas.revokeConsent>;
export type SendTurnRequest = z.infer<typeof soloSchemas.sendTurn>;
export type ReadEventsRequest = z.infer<typeof soloSchemas.readEvents>;
