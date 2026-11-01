import type Database from 'better-sqlite3';
import {
  StoreError,
  type ConsentRecord, type NewSoloEvent, type OperationRecord, type ParticipantRecord, type ProjectRecord,
  type SessionRecord, type Store, type StoreWrite, type TurnRecord, type WorkspaceLease, type WorkspaceRecord,
} from '../../core/ports/store.ts';
import type { EventPage, SoloEvent, SoloEventPayload } from '../../shared/solo.ts';
import type { Connection } from './connection.ts';

type Row = Record<string, string | number | null>;

const text = (value: unknown): string => value as string;
const maybe = (value: unknown): string | null => (value === null || value === undefined ? null : (value as string));
const toJson = (value: unknown): string | null => (value === null || value === undefined ? null : JSON.stringify(value));
const fromJson = <T>(value: unknown): T | null => (value === null || value === undefined ? null : (JSON.parse(value as string) as T));

const projectOf = (row: Row): ProjectRecord => ({
  id: text(row.id), canonicalPath: text(row.canonical_path), name: text(row.name), defaultBranch: text(row.default_branch),
  configVersion: row.config_version as number, config: JSON.parse(text(row.config_json)) as ProjectRecord['config'],
});
const sessionOf = (row: Row): SessionRecord => ({
  id: text(row.id), projectId: text(row.project_id), title: text(row.title), status: text(row.status) as SessionRecord['status'],
  detail: text(row.detail), createdAt: text(row.created_at), updatedAt: text(row.updated_at),
});
const workspaceOf = (row: Row): WorkspaceRecord => ({
  id: text(row.id), sessionId: text(row.session_id), path: text(row.path), branch: text(row.branch), baseRef: text(row.base_ref),
  initialBaseSha: maybe(row.initial_base_sha), state: text(row.state) as WorkspaceRecord['state'],
  setupState: text(row.setup_state) as WorkspaceRecord['setupState'],
  setupDecision: fromJson(row.setup_decision_json), setupCompletion: fromJson(row.setup_completion_json),
  configVersion: row.config_version as number,
});
const participantOf = (row: Row): ParticipantRecord => ({
  id: text(row.id), sessionId: text(row.session_id), workspaceId: text(row.workspace_id),
  cli: text(row.cli) as ParticipantRecord['cli'], profile: text(row.profile) as ParticipantRecord['profile'],
  agentSessionId: maybe(row.agent_session_id), context: text(row.context) as ParticipantRecord['context'],
});
const turnOf = (row: Row): TurnRecord => ({
  id: text(row.id), participantId: text(row.participant_id), sessionId: text(row.session_id), workspaceId: text(row.workspace_id),
  seq: row.seq as number, prompt: text(row.prompt), conversation: text(row.conversation) as TurnRecord['conversation'],
  status: text(row.status) as TurnRecord['status'], operationId: text(row.operation_id), startedAt: text(row.started_at),
  endedAt: maybe(row.ended_at), result: fromJson(row.result_json), processIdentity: fromJson(row.process_identity_json),
});
const operationOf = (row: Row): OperationRecord => ({
  id: text(row.id), requestId: text(row.request_id), kind: text(row.kind) as OperationRecord['kind'],
  fingerprint: text(row.fingerprint), status: text(row.status) as OperationRecord['status'],
  phase: text(row.phase) as OperationRecord['phase'], sessionId: maybe(row.session_id), workspaceId: maybe(row.workspace_id),
  projectId: maybe(row.project_id), turnId: maybe(row.turn_id), error: fromJson(row.error_json), result: fromJson(row.result_json),
  createdAt: text(row.created_at), updatedAt: text(row.updated_at),
});
const consentOf = (row: Row): ConsentRecord => ({
  id: text(row.id), operationId: text(row.operation_id), projectId: text(row.project_id), version: 1,
  contextDigest: text(row.context_digest), fingerprint: text(row.fingerprint),
  coverage: JSON.parse(text(row.coverage_json)) as ConsentRecord['coverage'],
  status: text(row.status) as ConsentRecord['status'], updatedAt: text(row.updated_at),
});
const leaseOf = (row: Row): WorkspaceLease => ({
  workspaceId: text(row.workspace_id), operationId: text(row.operation_id), state: text(row.state) as WorkspaceLease['state'],
});
const eventOf = (row: Row): SoloEvent => ({
  id: text(row.event_id), sessionId: text(row.session_id), seq: row.seq as number, timestamp: text(row.ts),
  payload: JSON.parse(text(row.payload_json)) as SoloEventPayload,
});

export interface SqliteStoreOptions {
  /** Время записей слотов, которых нет в доменных записях. */
  now?: () => string;
}

/**
 * Синхронное хранилище состояния Solo. Каждая запись (beginOperation/commit) — одна транзакция:
 * записи сущностей и нормализованные события получают seq и фиксируются вместе.
 */
export class SqliteStore implements Store {
  private readonly now: () => string;
  private readonly stmt: ReturnType<typeof prepareStatements>;

  constructor(private readonly connection: Connection, options: SqliteStoreOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.stmt = prepareStatements(connection.db);
  }

  get failed(): boolean { return this.connection.failed; }

  beginOperation(operation: OperationRecord, initialWrite: StoreWrite = {}): { operation: OperationRecord; created: boolean; events: SoloEvent[] } {
    const eventTypes = (initialWrite.events ?? []).map(event => event.payload.type);
    return this.connection.transact({ operation: 'begin_operation', requestId: operation.requestId, eventTypes }, () => {
      const existing = this.stmt.operationByRequest.get(operation.requestId) as Row | undefined;
      if (existing) {
        const found = operationOf(existing);
        if (found.fingerprint !== operation.fingerprint || found.kind !== operation.kind) {
          throw new StoreError('request_conflict', 'Этот requestId уже использован для другого запроса.');
        }
        return { operation: found, created: false, events: [] };
      }
      this.upsertOperation(operation);
      const events = this.apply(initialWrite);
      return { operation: operationOf(this.stmt.operationById.get(operation.id) as Row), created: true, events };
    });
  }

  commit(write: StoreWrite): SoloEvent[] {
    const eventTypes = (write.events ?? []).map(event => event.payload.type);
    return this.connection.transact({ operation: 'commit', eventTypes }, () => this.apply(write));
  }

  private apply(write: StoreWrite): SoloEvent[] {
    // Порядок удовлетворяет внешним ключам и триггеру: слот раньше активного хода.
    for (const record of write.projects ?? []) this.upsertProject(record);
    for (const record of write.sessions ?? []) this.upsertSession(record);
    for (const record of write.workspaces ?? []) this.upsertWorkspace(record);
    for (const record of write.participants ?? []) this.upsertParticipant(record);
    for (const record of write.operations ?? []) this.upsertOperation(record);
    for (const record of write.leases ?? []) this.upsertLease(record);
    for (const record of write.turns ?? []) this.upsertTurn(record);
    for (const record of write.consents ?? []) this.upsertConsent(record);
    return (write.events ?? []).map(event => this.appendEvent(event));
  }

  private upsertProject(r: ProjectRecord): void {
    this.stmt.upsertProject.run({ id: r.id, path: r.canonicalPath, name: r.name, branch: r.defaultBranch, version: r.configVersion, config: JSON.stringify(r.config) });
  }
  private upsertSession(r: SessionRecord): void {
    this.stmt.upsertSession.run({ id: r.id, project: r.projectId, title: r.title, status: r.status, detail: r.detail, created: r.createdAt, updated: r.updatedAt });
  }
  private upsertWorkspace(r: WorkspaceRecord): void {
    this.stmt.upsertWorkspace.run({
      id: r.id, session: r.sessionId, path: r.path, branch: r.branch, base: r.baseRef, sha: r.initialBaseSha, state: r.state,
      setup: r.setupState, decision: toJson(r.setupDecision), completion: toJson(r.setupCompletion), version: r.configVersion,
    });
  }
  private upsertParticipant(r: ParticipantRecord): void {
    this.stmt.upsertParticipant.run({ id: r.id, session: r.sessionId, workspace: r.workspaceId, cli: r.cli, profile: r.profile, agent: r.agentSessionId, context: r.context });
  }
  private upsertOperation(r: OperationRecord): void {
    this.stmt.upsertOperation.run({
      id: r.id, request: r.requestId, kind: r.kind, fingerprint: r.fingerprint, status: r.status, phase: r.phase,
      session: r.sessionId, workspace: r.workspaceId, project: r.projectId, turn: r.turnId,
      error: toJson(r.error), result: toJson(r.result), created: r.createdAt, updated: r.updatedAt,
    });
  }
  private upsertLease(r: WorkspaceLease): void {
    this.stmt.upsertLease.run({ workspace: r.workspaceId, operation: r.operationId, state: r.state, updated: this.now() });
  }
  private upsertTurn(r: TurnRecord): void {
    this.stmt.upsertTurn.run({
      id: r.id, session: r.sessionId, workspace: r.workspaceId, participant: r.participantId, seq: r.seq, prompt: r.prompt,
      conversation: r.conversation, status: r.status, operation: r.operationId, started: r.startedAt, ended: r.endedAt,
      result: toJson(r.result), identity: toJson(r.processIdentity),
    });
  }
  private upsertConsent(r: ConsentRecord): void {
    this.stmt.upsertConsent.run({
      id: r.id, operation: r.operationId, project: r.projectId, version: r.version, digest: r.contextDigest,
      fingerprint: r.fingerprint, coverage: JSON.stringify(r.coverage), status: r.status, updated: r.updatedAt,
    });
  }
  /** seq выделяется внутри транзакции записи: приложение — единственный писатель БД. */
  private appendEvent(event: NewSoloEvent): SoloEvent {
    const last = this.stmt.lastSeq.get(event.sessionId) as { seq: number };
    const seq = last.seq + 1;
    this.stmt.insertEvent.run({ session: event.sessionId, seq, id: event.id, ts: event.timestamp, type: event.payload.type, payload: JSON.stringify(event.payload) });
    return { id: event.id, sessionId: event.sessionId, seq, timestamp: event.timestamp, payload: event.payload };
  }

  private one<T>(statement: Database.Statement, mapper: (row: Row) => T, ...params: unknown[]): T | undefined {
    return this.connection.read(() => {
      const row = statement.get(...params) as Row | undefined;
      return row ? mapper(row) : undefined;
    });
  }
  private many<T>(statement: Database.Statement, mapper: (row: Row) => T, ...params: unknown[]): T[] {
    return this.connection.read(() => (statement.all(...params) as Row[]).map(mapper));
  }

  getProject(id: string) { return this.one(this.stmt.projectById, projectOf, id); }
  findProjectByPath(path: string) { return this.one(this.stmt.projectByPath, projectOf, path); }
  listProjects() { return this.many(this.stmt.projects, projectOf); }
  getSession(id: string) { return this.one(this.stmt.sessionById, sessionOf, id); }
  listSessions() { return this.many(this.stmt.sessions, sessionOf); }
  getWorkspace(id: string) { return this.one(this.stmt.workspaceById, workspaceOf, id); }
  getSessionWorkspace(sessionId: string) { return this.one(this.stmt.workspaceBySession, workspaceOf, sessionId); }
  getParticipant(id: string) { return this.one(this.stmt.participantById, participantOf, id); }
  getSessionParticipant(sessionId: string) { return this.one(this.stmt.participantBySession, participantOf, sessionId); }
  getTurn(id: string) { return this.one(this.stmt.turnById, turnOf, id); }
  listTurns(sessionId: string) { return this.many(this.stmt.turnsBySession, turnOf, sessionId); }
  getOperation(id: string) { return this.one(this.stmt.operationById, operationOf, id); }
  findOperation(requestId: string) { return this.one(this.stmt.operationByRequest, operationOf, requestId); }
  listOperations() { return this.many(this.stmt.operations, operationOf); }
  getLease(workspaceId: string) { return this.one(this.stmt.leaseByWorkspace, leaseOf, workspaceId); }
  getConsent(id: string) { return this.one(this.stmt.consentById, consentOf, id); }
  findConsent(operationId: string) { return this.one(this.stmt.consentByOperation, consentOf, operationId); }

  readEvents(sessionId: string, after: number, limit: number): EventPage {
    const size = Math.min(Math.max(Math.trunc(limit), 1), 1_000);
    const rows = this.connection.read(() => this.stmt.events.all(sessionId, Math.max(Math.trunc(after), 0), size + 1) as Row[]);
    const page = rows.slice(0, size).map(eventOf);
    return { events: page, nextCursor: page.at(-1)?.seq ?? after, hasMore: rows.length > size };
  }

  close(): void { this.connection.close(); }
}

function prepareStatements(db: Database.Database) {
  return {
    upsertProject: db.prepare(`INSERT INTO projects (id, canonical_path, name, default_branch, config_version, config_json)
      VALUES (@id, @path, @name, @branch, @version, @config)
      ON CONFLICT(id) DO UPDATE SET canonical_path = excluded.canonical_path, name = excluded.name,
        default_branch = excluded.default_branch, config_version = excluded.config_version, config_json = excluded.config_json`),
    upsertSession: db.prepare(`INSERT INTO sessions (id, project_id, title, status, detail, created_at, updated_at)
      VALUES (@id, @project, @title, @status, @detail, @created, @updated)
      ON CONFLICT(id) DO UPDATE SET title = excluded.title, status = excluded.status, detail = excluded.detail,
        updated_at = excluded.updated_at`),
    upsertWorkspace: db.prepare(`INSERT INTO workspaces (id, session_id, path, branch, base_ref, initial_base_sha, state, setup_state,
        setup_decision_json, setup_completion_json, config_version)
      VALUES (@id, @session, @path, @branch, @base, @sha, @state, @setup, @decision, @completion, @version)
      ON CONFLICT(id) DO UPDATE SET initial_base_sha = excluded.initial_base_sha, state = excluded.state,
        setup_state = excluded.setup_state, setup_decision_json = excluded.setup_decision_json,
        setup_completion_json = excluded.setup_completion_json, config_version = excluded.config_version`),
    upsertParticipant: db.prepare(`INSERT INTO participants (id, session_id, workspace_id, cli, profile, agent_session_id, context)
      VALUES (@id, @session, @workspace, @cli, @profile, @agent, @context)
      ON CONFLICT(id) DO UPDATE SET agent_session_id = excluded.agent_session_id, context = excluded.context,
        cli = excluded.cli, profile = excluded.profile`),
    upsertOperation: db.prepare(`INSERT INTO operations (id, request_id, kind, fingerprint, status, phase, session_id, workspace_id,
        project_id, turn_id, error_json, result_json, created_at, updated_at)
      VALUES (@id, @request, @kind, @fingerprint, @status, @phase, @session, @workspace, @project, @turn, @error, @result, @created, @updated)
      ON CONFLICT(id) DO UPDATE SET request_id = excluded.request_id, kind = excluded.kind, fingerprint = excluded.fingerprint,
        status = excluded.status, phase = excluded.phase, session_id = excluded.session_id, workspace_id = excluded.workspace_id,
        project_id = excluded.project_id, turn_id = excluded.turn_id, error_json = excluded.error_json,
        result_json = excluded.result_json, updated_at = excluded.updated_at`),
    upsertLease: db.prepare(`INSERT INTO workspace_leases (workspace_id, operation_id, state, updated_at)
      VALUES (@workspace, @operation, @state, @updated)
      ON CONFLICT(workspace_id) DO UPDATE SET operation_id = excluded.operation_id, state = excluded.state, updated_at = excluded.updated_at`),
    upsertTurn: db.prepare(`INSERT INTO turns (id, session_id, workspace_id, participant_id, seq, prompt, conversation, status,
        operation_id, started_at, ended_at, result_json, process_identity_json)
      VALUES (@id, @session, @workspace, @participant, @seq, @prompt, @conversation, @status, @operation, @started, @ended, @result, @identity)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, ended_at = excluded.ended_at,
        result_json = excluded.result_json, process_identity_json = excluded.process_identity_json`),
    upsertConsent: db.prepare(`INSERT INTO consents (id, operation_id, project_id, version, context_digest, fingerprint, coverage_json, status, updated_at)
      VALUES (@id, @operation, @project, @version, @digest, @fingerprint, @coverage, @status, @updated)
      ON CONFLICT(id) DO UPDATE SET context_digest = excluded.context_digest, fingerprint = excluded.fingerprint,
        coverage_json = excluded.coverage_json, status = excluded.status, updated_at = excluded.updated_at`),
    lastSeq: db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE session_id = ?'),
    insertEvent: db.prepare('INSERT INTO events (session_id, seq, event_id, ts, type, payload_json) VALUES (@session, @seq, @id, @ts, @type, @payload)'),
    events: db.prepare('SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?'),
    projectById: db.prepare('SELECT * FROM projects WHERE id = ?'),
    projectByPath: db.prepare('SELECT * FROM projects WHERE canonical_path = ?'),
    projects: db.prepare('SELECT * FROM projects ORDER BY name, canonical_path'),
    sessionById: db.prepare('SELECT * FROM sessions WHERE id = ?'),
    sessions: db.prepare('SELECT * FROM sessions ORDER BY created_at DESC, rowid DESC'),
    workspaceById: db.prepare('SELECT * FROM workspaces WHERE id = ?'),
    workspaceBySession: db.prepare('SELECT * FROM workspaces WHERE session_id = ? ORDER BY rowid LIMIT 1'),
    participantById: db.prepare('SELECT * FROM participants WHERE id = ?'),
    participantBySession: db.prepare('SELECT * FROM participants WHERE session_id = ? ORDER BY rowid LIMIT 1'),
    turnById: db.prepare('SELECT * FROM turns WHERE id = ?'),
    turnsBySession: db.prepare('SELECT * FROM turns WHERE session_id = ? ORDER BY rowid'),
    operationById: db.prepare('SELECT * FROM operations WHERE id = ?'),
    operationByRequest: db.prepare('SELECT * FROM operations WHERE request_id = ?'),
    operations: db.prepare('SELECT * FROM operations ORDER BY created_at, rowid'),
    leaseByWorkspace: db.prepare('SELECT * FROM workspace_leases WHERE workspace_id = ?'),
    consentById: db.prepare('SELECT * FROM consents WHERE id = ?'),
    consentByOperation: db.prepare('SELECT * FROM consents WHERE operation_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1'),
  };
}
