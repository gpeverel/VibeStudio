import type { Migration } from './types.ts';

/** PRAGMA application_id: ASCII «VSTU». Отличает БД VibeStudio от чужой базы с тем же user_version. */
export const APPLICATION_ID = 0x56535455;

/**
 * Статусы хода, которые держат слот participant. `uncertain` сюда не входит: неизвестный исход
 * блокирует workspace через workspace_leases, а явное решение пользователя переводит ход в
 * `interrupted` и освобождает слот отдельными записями.
 */
export const ACTIVE_TURN_STATUSES = ['starting', 'running', 'stopping'] as const;

const activeList = ACTIVE_TURN_STATUSES.map(status => `'${status}'`).join(', ');

/**
 * Схема версии 1.
 *
 * История (turns, events, operations, git_operations, workspaces) не удаляется ни каскадом,
 * ни вручную: при уборке workspace меняется его state, строки истории остаются.
 * Ссылки operations.* → sessions/workspaces/projects/turns и turns/workspace_leases → operations
 * объявлены DEFERRABLE INITIALLY DEFERRED: намерение и создаваемые им сущности пишутся одной
 * транзакцией в любом порядке, а нарушение принадлежности обнаруживается при COMMIT.
 * Права на изменяющий слот держит workspace_leases; триггеры не дают ни забрать чужой слот,
 * ни вернуть неопределённый слот в `held` без явного освобождения.
 */
const SCHEMA = `
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  canonical_path TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  config_version INTEGER NOT NULL CHECK (config_version >= 1),
  config_json TEXT NOT NULL CHECK (json_valid(config_json))
) STRICT;

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX sessions_by_project ON sessions(project_id, created_at);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  path TEXT NOT NULL UNIQUE,
  branch TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  initial_base_sha TEXT,
  state TEXT NOT NULL CHECK (state IN ('creating', 'ready', 'missing', 'uncertain')),
  setup_state TEXT NOT NULL,
  setup_decision_json TEXT CHECK (setup_decision_json IS NULL OR json_valid(setup_decision_json)),
  setup_completion_json TEXT CHECK (setup_completion_json IS NULL OR json_valid(setup_completion_json)),
  config_version INTEGER NOT NULL CHECK (config_version >= 1),
  UNIQUE (id, session_id)
) STRICT;
CREATE INDEX workspaces_by_session ON workspaces(session_id);

CREATE TABLE participants (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  workspace_id TEXT NOT NULL,
  cli TEXT NOT NULL CHECK (cli IN ('claude', 'codex')),
  profile TEXT NOT NULL,
  agent_session_id TEXT,
  context TEXT NOT NULL CHECK (context IN ('new', 'available', 'missing', 'unknown')),
  UNIQUE (id, session_id),
  UNIQUE (id, workspace_id, session_id),
  FOREIGN KEY (workspace_id, session_id) REFERENCES workspaces(id, session_id),
  CHECK ((cli = 'claude' AND profile = 'practical-local-v1') OR (cli = 'codex' AND profile = 'codex-app-server-read-v1'))
) STRICT;
CREATE INDEX participants_by_session ON participants(session_id);

CREATE TABLE turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  prompt TEXT NOT NULL,
  conversation TEXT NOT NULL CHECK (conversation IN ('continue', 'new')),
  status TEXT NOT NULL CHECK (status IN ('starting', 'running', 'stopping', 'completed', 'failed', 'interrupted', 'uncertain')),
  operation_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  process_identity_json TEXT CHECK (process_identity_json IS NULL OR json_valid(process_identity_json)),
  UNIQUE (participant_id, seq),
  UNIQUE (id, session_id),
  FOREIGN KEY (participant_id, workspace_id, session_id) REFERENCES participants(id, workspace_id, session_id),
  FOREIGN KEY (operation_id, session_id, workspace_id) REFERENCES operations(id, session_id, workspace_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE UNIQUE INDEX turns_one_active_per_participant ON turns(participant_id)
  WHERE status IN (${activeList});
CREATE INDEX turns_by_session ON turns(session_id, seq);

CREATE TABLE events (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  seq INTEGER NOT NULL CHECK (seq >= 1),
  event_id TEXT NOT NULL UNIQUE,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  PRIMARY KEY (session_id, seq)
) STRICT, WITHOUT ROWID;

CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'uncertain')),
  phase TEXT NOT NULL CHECK (phase IN ('intent_saved', 'effect_pending', 'effect_started', 'result_saved', 'uncertain')),
  session_id TEXT,
  workspace_id TEXT,
  project_id TEXT,
  turn_id TEXT,
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (id, workspace_id),
  UNIQUE (id, session_id, workspace_id),
  CHECK (workspace_id IS NULL OR session_id IS NOT NULL),
  FOREIGN KEY (session_id) REFERENCES sessions(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, session_id) REFERENCES workspaces(id, session_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (project_id) REFERENCES projects(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (turn_id) REFERENCES turns(id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE INDEX operations_by_session ON operations(session_id, created_at);

CREATE TABLE git_operations (
  request_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  operation_json TEXT NOT NULL CHECK (json_valid(operation_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX git_operations_by_repository ON git_operations(repository_id);

CREATE TABLE consents (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id),
  version INTEGER NOT NULL CHECK (version = 1),
  context_digest TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  coverage_json TEXT NOT NULL CHECK (json_valid(coverage_json)),
  status TEXT NOT NULL CHECK (status IN ('granted', 'revoked', 'invalidated')),
  updated_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX consents_one_granted ON consents(operation_id) WHERE status = 'granted';
CREATE INDEX consents_by_operation ON consents(operation_id, updated_at);

CREATE TABLE workspace_leases (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),
  operation_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('held', 'uncertain', 'released')),
  updated_at TEXT NOT NULL,
  FOREIGN KEY (operation_id, workspace_id) REFERENCES operations(id, workspace_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TRIGGER events_never_deleted BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'history_immutable'); END;
CREATE TRIGGER events_never_rewritten BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'history_immutable'); END;
CREATE TRIGGER turns_never_deleted BEFORE DELETE ON turns
BEGIN SELECT RAISE(ABORT, 'history_immutable'); END;
CREATE TRIGGER operations_never_deleted BEFORE DELETE ON operations
BEGIN SELECT RAISE(ABORT, 'history_immutable'); END;
CREATE TRIGGER git_operations_never_deleted BEFORE DELETE ON git_operations
BEGIN SELECT RAISE(ABORT, 'history_immutable'); END;
CREATE TRIGGER workspaces_never_deleted BEFORE DELETE ON workspaces
BEGIN SELECT RAISE(ABORT, 'history_immutable'); END;
CREATE TRIGGER leases_never_deleted BEFORE DELETE ON workspace_leases
BEGIN SELECT RAISE(ABORT, 'history_immutable'); END;

CREATE TRIGGER operations_identity_immutable BEFORE UPDATE ON operations
WHEN NEW.request_id <> OLD.request_id OR NEW.fingerprint <> OLD.fingerprint OR NEW.kind <> OLD.kind
BEGIN SELECT RAISE(ABORT, 'operation_identity_immutable'); END;

CREATE TRIGGER participants_cli_immutable BEFORE UPDATE ON participants
WHEN NEW.cli <> OLD.cli OR NEW.profile <> OLD.profile
BEGIN SELECT RAISE(ABORT, 'participant_cli_immutable'); END;

CREATE TRIGGER lease_not_taken_over BEFORE UPDATE ON workspace_leases
WHEN OLD.state <> 'released' AND NEW.operation_id <> OLD.operation_id
BEGIN SELECT RAISE(ABORT, 'lease_busy'); END;

CREATE TRIGGER lease_uncertain_needs_release BEFORE UPDATE ON workspace_leases
WHEN OLD.state = 'uncertain' AND NEW.state = 'held'
BEGIN SELECT RAISE(ABORT, 'lease_uncertain'); END;

CREATE TRIGGER active_turn_needs_lease BEFORE INSERT ON turns
WHEN NEW.status IN (${activeList})
  AND NOT EXISTS (SELECT 1 FROM workspace_leases
    WHERE workspace_id = NEW.workspace_id AND operation_id = NEW.operation_id AND state = 'held')
BEGIN SELECT RAISE(ABORT, 'lease_required'); END;
`;

export const migration0001: Migration = {
  version: 1,
  name: 'initial',
  up(db) {
    db.exec(SCHEMA);
    db.pragma(`application_id = ${APPLICATION_ID}`);
  },
};
