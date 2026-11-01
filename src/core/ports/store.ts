import type { AgentRunCompletion, ProcessCompletion } from '../../shared/agent.ts';
import type { ProjectCommandConsentDecision, ProjectCommandCoverage } from '../../shared/project-command-consent.ts';
import type { AgentKind, EventPage, OperationView, SessionStatus, SessionView, SoloEvent, SoloEventPayload } from '../../shared/solo.ts';
import type { ProjectCommand } from './project-command-snapshot.ts';

export class StoreError extends Error {
  constructor(readonly code: 'store_failed' | 'request_conflict' | 'constraint' | 'newer_database', message: string, cause?: unknown) {
    super(message, { cause }); this.name = 'StoreError';
  }
}
export interface ProjectRecord {
  id: string; canonicalPath: string; name: string; defaultBranch: string; configVersion: number;
  config: { setup: ProjectCommand | null; copyFiles: readonly string[]; setupTimeoutMs: number };
}
export interface SessionRecord {
  id: string; projectId: string; title: string; status: SessionStatus; detail: string;
  createdAt: string; updatedAt: string;
}
export interface WorkspaceRecord {
  id: string; sessionId: string; path: string; branch: string; baseRef: string; initialBaseSha: string | null;
  state: SessionView['workspace']['state']; setupState: SessionView['setup']['state'];
  setupDecision: ProjectCommandConsentDecision | null; setupCompletion: ProcessCompletion | null; configVersion: number;
}
export interface ParticipantRecord {
  id: string; sessionId: string; workspaceId: string; cli: AgentKind; profile: 'practical-local-v1' | 'codex-app-server-read-v1';
  agentSessionId: string | null; context: SessionView['participant']['context'];
}
export interface TurnRecord {
  id: string; participantId: string; sessionId: string; workspaceId: string; seq: number; prompt: string;
  conversation: 'continue' | 'new'; status: 'starting' | 'running' | 'stopping' | 'completed' | 'failed' | 'interrupted' | 'uncertain';
  operationId: string; startedAt: string; endedAt: string | null; result: AgentRunCompletion | null;
  processIdentity: RunIdentity | null;
}
export interface RunIdentity {
  runId: string; applicationInstanceId: string; pid?: number; requestedExecutable?: string; cwd?: string;
  /** Время наблюдения spawn не выдаётся за время создания процесса по данным ОС. */
  spawnObservedAt?: string; osCreatedAt?: null;
}
export interface OperationRecord extends OperationView {
  fingerprint: string; workspaceId: string | null; projectId: string | null; turnId: string | null;
  phase: 'intent_saved' | 'effect_pending' | 'effect_started' | 'result_saved' | 'uncertain';
  createdAt: string; updatedAt: string;
  result: { projectId?: string | null; sessionId?: string; consentId?: string; processIdentity?: RunIdentity } | null;
}
/** Нет env/argv и одноразовых challenges. contextDigest вычисляет доверенная композиция. */
export interface ConsentRecord {
  id: string; operationId: string; projectId: string; version: 1; contextDigest: string; fingerprint: string;
  coverage: ProjectCommandCoverage; status: 'granted' | 'revoked' | 'invalidated'; updatedAt: string;
}
export interface WorkspaceLease { workspaceId: string; operationId: string; state: 'held' | 'uncertain' | 'released' }
export interface NewSoloEvent { id: string; sessionId: string; timestamp: string; payload: SoloEventPayload }
/** Массивы полных записей, не частичный SQL. Весь write и его events — одна транзакция. */
export interface StoreWrite {
  projects?: readonly ProjectRecord[]; sessions?: readonly SessionRecord[]; workspaces?: readonly WorkspaceRecord[];
  participants?: readonly ParticipantRecord[]; turns?: readonly TurnRecord[]; operations?: readonly OperationRecord[];
  consents?: readonly ConsentRecord[]; leases?: readonly WorkspaceLease[]; events?: readonly NewSoloEvent[];
}
export interface Store {
  readonly failed: boolean;
  /** UNIQUE(requestId), сравнение fingerprint и initialWrite выполняются одной транзакцией.
   * При повторе initialWrite игнорируется; никаких повторных событий/эффектов. */
  beginOperation(operation: OperationRecord, initialWrite?: StoreWrite): { operation: OperationRecord; created: boolean; events: SoloEvent[] };
  commit(write: StoreWrite): SoloEvent[];
  getProject(id: string): ProjectRecord | undefined;
  findProjectByPath(path: string): ProjectRecord | undefined;
  listProjects(): ProjectRecord[];
  getSession(id: string): SessionRecord | undefined;
  listSessions(): SessionRecord[];
  getWorkspace(id: string): WorkspaceRecord | undefined;
  getSessionWorkspace(sessionId: string): WorkspaceRecord | undefined;
  getParticipant(id: string): ParticipantRecord | undefined;
  getSessionParticipant(sessionId: string): ParticipantRecord | undefined;
  getTurn(id: string): TurnRecord | undefined;
  listTurns(sessionId: string): TurnRecord[];
  getOperation(id: string): OperationRecord | undefined;
  findOperation(requestId: string): OperationRecord | undefined;
  listOperations(): OperationRecord[];
  getLease(workspaceId: string): WorkspaceLease | undefined;
  getConsent(id: string): ConsentRecord | undefined;
  findConsent(operationId: string): ConsentRecord | undefined;
  readEvents(sessionId: string, after: number, limit: number): EventPage;
  close(): void;
}
