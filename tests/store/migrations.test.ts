import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, StorageError } from '../../src/adapters/store/database.ts';
import { APPLICATION_ID, MIGRATIONS, type Migration } from '../../src/adapters/store/migrations/index.ts';
import { TempDir } from './helpers.ts';

let temp: TempDir;
beforeEach(() => { temp = new TempDir(); });
afterEach(() => temp.cleanup());

const addNotes: Migration = {
  version: 2, name: 'notes',
  up: db => { db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL) STRICT'); },
};
const brokenAfterDdl: Migration = {
  version: 2, name: 'broken',
  up: db => {
    db.exec('CREATE TABLE half_done (id INTEGER PRIMARY KEY) STRICT');
    throw new Error('синтетический сбой миграции');
  },
};
const breaksForeignKeys: Migration = {
  version: 2, name: 'dangling',
  up: db => {
    db.exec("INSERT INTO sessions (id, project_id, title, status, detail, created_at, updated_at) VALUES ('s', 'missing', 't', 'ready', '', 'x', 'x')");
  },
};

const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const backups = (dir: string) => readdirSync(dir).filter(name => name.endsWith('.bak'));
const userVersion = (db: Database.Database) => db.pragma('user_version', { simple: true });

describe('SQLite: миграции', () => {
  it('создаёт пустую БД на последней версии с FK, application_id и без резервной копии', () => {
    const path = temp.path('db', 'state.sqlite');
    const opened = openDatabase({ path });
    try {
      expect(opened.version).toBe(MIGRATIONS.length);
      expect(opened.migrated).toEqual({ from: 0, to: MIGRATIONS.length });
      expect(userVersion(opened.db)).toBe(MIGRATIONS.length);
      expect(opened.db.pragma('application_id', { simple: true })).toBe(APPLICATION_ID);
      expect(opened.db.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(opened.db.pragma('journal_mode', { simple: true })).toBe('wal');
      const tables = (opened.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(row => row.name);
      expect(tables).toEqual(expect.arrayContaining(['projects', 'sessions', 'workspaces', 'participants', 'turns', 'events',
        'operations', 'git_operations', 'consents', 'workspace_leases']));
      expect(backups(temp.path('db'))).toEqual([]);
    } finally { opened.db.close(); }
  });

  it('повторное открытие не применяет миграции и не создаёт копию', () => {
    const path = temp.path('state.sqlite');
    openDatabase({ path }).db.close();
    const again = openDatabase({ path });
    try {
      expect(again.migrated).toBeUndefined();
      expect(backups(temp.root)).toEqual([]);
    } finally { again.db.close(); }
  });

  it('обновляет БД с предыдущей версии: данные сохранены, перед миграцией есть согласованная копия', () => {
    const path = temp.path('state.sqlite');
    const first = openDatabase({ path });
    first.db.prepare("INSERT INTO projects (id, canonical_path, name, default_branch, config_version, config_json) VALUES ('p1', '/tmp/p1', 'P1', 'main', 1, '{}')").run();
    first.db.close();

    const upgraded = openDatabase({ path, migrations: [...MIGRATIONS, addNotes] });
    try {
      expect(upgraded.version).toBe(2);
      expect(upgraded.migrated?.from).toBe(1);
      expect(userVersion(upgraded.db)).toBe(2);
      expect(upgraded.db.prepare('SELECT name FROM projects WHERE id = ?').get('p1')).toEqual({ name: 'P1' });
      const copy = upgraded.migrated?.backupPath;
      expect(copy).toBeDefined();
      const snapshot = new Database(copy!, { readonly: true });
      try {
        expect(userVersion(snapshot)).toBe(1);
        expect(snapshot.prepare('SELECT count(*) AS n FROM projects').get()).toEqual({ n: 1 });
        expect(snapshot.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'notes'").get()).toEqual({ n: 0 });
      } finally { snapshot.close(); }
    } finally { upgraded.db.close(); }
  });

  it('сбой миграции откатывает DDL и версию, оставляя копию; следующая попытка с исправленной миграцией проходит', () => {
    const path = temp.path('state.sqlite');
    openDatabase({ path }).db.close();

    let failure: unknown;
    try { openDatabase({ path, migrations: [...MIGRATIONS, brokenAfterDdl] }); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(StorageError);
    expect(failure).toMatchObject({ code: 'migration_failed', details: { failedVersion: 2, fromVersion: 1 } });
    expect(backups(temp.root)).toHaveLength(1);
    expect(String((failure as StorageError).details.backupPath)).toContain('.pre-v1-to-v2-');

    const probe = new Database(path, { readonly: true });
    try {
      expect(userVersion(probe)).toBe(1);
      expect(probe.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'half_done'").get()).toEqual({ n: 0 });
    } finally { probe.close(); }

    const retried = openDatabase({ path, migrations: [...MIGRATIONS, addNotes] });
    expect(retried.version).toBe(2);
    retried.db.close();
  });

  it('миграция с нарушением внешних ключей откатывается', () => {
    const path = temp.path('state.sqlite');
    openDatabase({ path }).db.close();
    expect(() => openDatabase({ path, migrations: [...MIGRATIONS, breaksForeignKeys] }))
      .toThrowError(expect.objectContaining({ code: 'migration_failed' }));
    const probe = new Database(path, { readonly: true });
    try {
      expect(userVersion(probe)).toBe(1);
      expect(probe.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 0 });
    } finally { probe.close(); }
  });

  it('отказывается менять БД более новой версии: байты файла и время изменения не меняются', () => {
    const path = temp.path('state.sqlite');
    openDatabase({ path, migrations: [...MIGRATIONS, addNotes] }).db.close();
    const side = (name: string) => !name.endsWith('-shm') && !name.endsWith('-wal');
    const before = { hash: sha(path), mtime: statSync(path).mtimeMs, files: readdirSync(temp.root).filter(side).sort() };

    expect(() => openDatabase({ path })).toThrowError(expect.objectContaining({
      code: 'database_too_new', details: { found: 2, supported: MIGRATIONS.length },
    }));
    expect(sha(path)).toBe(before.hash);
    expect(statSync(path).mtimeMs).toBe(before.mtime);
    expect(readdirSync(temp.root).filter(side).sort()).toEqual(before.files);
    expect(backups(temp.root)).toEqual([]);
  });

  it('не принимает чужие и повреждённые файлы и не меняет их', () => {
    const foreign = temp.path('foreign.sqlite');
    const other = new Database(foreign);
    other.exec('CREATE TABLE other (id INTEGER)');
    other.close();
    const foreignHash = sha(foreign);
    expect(() => openDatabase({ path: foreign })).toThrowError(expect.objectContaining({ code: 'database_foreign' }));
    expect(sha(foreign)).toBe(foreignHash);

    const versioned = temp.path('versioned.sqlite');
    const stranger = new Database(versioned);
    stranger.pragma('user_version = 1');
    stranger.pragma('application_id = 1234');
    stranger.exec('CREATE TABLE x (id INTEGER)');
    stranger.close();
    expect(() => openDatabase({ path: versioned })).toThrowError(expect.objectContaining({ code: 'database_foreign' }));

    const garbage = temp.path('garbage.sqlite');
    writeFileSync(garbage, Buffer.alloc(4096, 7));
    expect(() => openDatabase({ path: garbage })).toThrowError(expect.objectContaining({ code: 'database_corrupt' }));
  });

  it('отклоняет непоследовательные миграции и не-файловые пути', () => {
    expect(() => openDatabase({ path: temp.path('a.sqlite'), migrations: [{ ...addNotes, version: 2 }] }))
      .toThrowError(expect.objectContaining({ code: 'invalid_migrations' }));
    expect(() => openDatabase({ path: ':memory:' })).toThrowError(expect.objectContaining({ code: 'open_failed' }));
  });
});

describe('SQLite: инварианты схемы', () => {
  function seeded() {
    const { db } = openDatabase({ path: temp.path('state.sqlite') });
    db.prepare("INSERT INTO projects (id, canonical_path, name, default_branch, config_version, config_json) VALUES ('p1', '/p1', 'P1', 'main', 1, '{}')").run();
    for (const id of ['s1', 's2']) {
      db.prepare("INSERT INTO sessions (id, project_id, title, status, detail, created_at, updated_at) VALUES (?, 'p1', ?, 'ready', '', 't', 't')").run(id, id);
      db.prepare("INSERT INTO workspaces (id, session_id, path, branch, base_ref, state, setup_state, config_version) VALUES (?, ?, ?, ?, 'main', 'ready', 'not_configured', 1)")
        .run(`w-${id}`, id, `/w/${id}`, `vs/${id}`);
      db.prepare("INSERT INTO participants (id, session_id, workspace_id, cli, profile, context) VALUES (?, ?, ?, 'claude', 'practical-local-v1', 'new')")
        .run(`pa-${id}`, id, `w-${id}`);
    }
    return db;
  }
  /** Операция должна существовать и принадлежать той же сессии и workspace, что слот или ход. */
  const operation = (db: Database.Database, id: string, workspace: string, status = 'running') =>
    db.prepare("INSERT OR IGNORE INTO operations (id, request_id, kind, fingerprint, status, phase, session_id, workspace_id, created_at, updated_at) VALUES (?, ?, 'send_turn', 'f', ?, 'effect_started', ?, ?, 't', 't')")
      .run(id, id, status, workspace.slice(2), workspace);
  const lease = (db: Database.Database, workspace: string, operationId: string, state = 'held') => {
    operation(db, operationId, workspace);
    return db.prepare("INSERT INTO workspace_leases (workspace_id, operation_id, state, updated_at) VALUES (?, ?, ?, 't') ON CONFLICT(workspace_id) DO UPDATE SET operation_id = excluded.operation_id, state = excluded.state")
      .run(workspace, operationId, state);
  };
  const turn = (db: Database.Database, id: string, session: string, participant: string, seq: number, status: string, operationId = `op-${id}`, workspace = `w-${session}`) => {
    operation(db, operationId, workspace);
    return db.prepare("INSERT INTO turns (id, session_id, workspace_id, participant_id, seq, prompt, conversation, status, operation_id, started_at) VALUES (?, ?, ?, ?, ?, 'p', 'new', ?, ?, 't')")
      .run(id, session, workspace, participant, seq, status, operationId);
  };

  it('participant не может ссылаться на workspace другой сессии и менять CLI', () => {
    const db = seeded();
    try {
      expect(() => db.prepare("INSERT INTO participants (id, session_id, workspace_id, cli, profile, context) VALUES ('bad', 's1', 'w-s2', 'claude', 'practical-local-v1', 'new')").run())
        .toThrowError(/FOREIGN KEY/);
      expect(() => db.prepare("INSERT INTO participants (id, session_id, workspace_id, cli, profile, context) VALUES ('mix', 's1', 'w-s1', 'codex', 'practical-local-v1', 'new')").run())
        .toThrowError(/CHECK/);
      expect(() => db.prepare("UPDATE participants SET cli = 'codex', profile = 'codex-app-server-read-v1' WHERE id = 'pa-s1'").run())
        .toThrowError(/participant_cli_immutable/);
    } finally { db.close(); }
  });

  it('turn принадлежит сессии своего participant; события уникальны по (сессия, seq) и event_id', () => {
    const db = seeded();
    try {
      lease(db, 'w-s1', 'op-t1');
      expect(() => turn(db, 't-bad', 's1', 'pa-s2', 1, 'completed')).toThrowError(/FOREIGN KEY/);
      turn(db, 't1', 's1', 'pa-s1', 1, 'completed');
      const event = (session: string, seq: number, id: string) =>
        db.prepare("INSERT INTO events (session_id, seq, event_id, ts, type, payload_json) VALUES (?, ?, ?, 't', 'diagnostic', '{}')").run(session, seq, id);
      event('s1', 1, 'e1');
      expect(() => event('s1', 1, 'e3')).toThrowError(/UNIQUE|PRIMARY KEY/);
      expect(() => event('s1', 2, 'e1')).toThrowError(/UNIQUE/);
      expect(() => event('missing', 1, 'e9')).toThrowError(/FOREIGN KEY/);
    } finally { db.close(); }
  });

  it('у participant не больше одного активного хода; завершённые не мешают', () => {
    const db = seeded();
    try {
      lease(db, 'w-s1', 'op-t2');
      turn(db, 't1', 's1', 'pa-s1', 1, 'completed');
      turn(db, 't2', 's1', 'pa-s1', 2, 'running');
      lease(db, 'w-s1', 'op-t2', 'released');
      lease(db, 'w-s1', 'op-t3');
      expect(() => turn(db, 't3', 's1', 'pa-s1', 3, 'starting')).toThrowError(/UNIQUE/);
      turn(db, 't5', 's1', 'pa-s1', 5, 'failed');
      expect(() => turn(db, 't6', 's1', 'pa-s1', 2, 'completed')).toThrowError(/UNIQUE/);
    } finally { db.close(); }
  });

  it('активный ход требует слот workspace, принадлежащий его операции', () => {
    const db = seeded();
    try {
      expect(() => turn(db, 't1', 's1', 'pa-s1', 1, 'starting')).toThrowError(/lease_required/);
      lease(db, 'w-s1', 'другая-операция');
      expect(() => turn(db, 't1', 's1', 'pa-s1', 1, 'starting')).toThrowError(/lease_required/);
      lease(db, 'w-s1', 'другая-операция', 'released');
      lease(db, 'w-s1', 'op-t1', 'uncertain');
      expect(() => turn(db, 't1', 's1', 'pa-s1', 1, 'running')).toThrowError(/lease_required/);
    } finally { db.close(); }
  });

  it('слот не перехватывается и не возвращается из uncertain в held без освобождения', () => {
    const db = seeded();
    try {
      lease(db, 'w-s1', 'setup-1');
      expect(() => lease(db, 'w-s1', 'turn-1')).toThrowError(/lease_busy/);
      lease(db, 'w-s1', 'setup-1', 'uncertain');
      expect(() => lease(db, 'w-s1', 'setup-1', 'held')).toThrowError(/lease_uncertain/);
      expect(() => lease(db, 'w-s1', 'turn-1', 'held')).toThrowError(/lease_(busy|uncertain)/);
      lease(db, 'w-s1', 'setup-1', 'released');
      lease(db, 'w-s1', 'turn-1', 'held');
      expect(db.prepare('SELECT operation_id, state FROM workspace_leases WHERE workspace_id = ?').get('w-s1'))
        .toEqual({ operation_id: 'turn-1', state: 'held' });
      expect(() => db.prepare('DELETE FROM workspace_leases').run()).toThrowError(/history_immutable/);
    } finally { db.close(); }
  });

  it('ход связывает participant, workspace, сессию и операцию строго одной принадлежности', () => {
    const db = seeded();
    try {
      db.prepare("INSERT INTO workspaces (id, session_id, path, branch, base_ref, state, setup_state, config_version) VALUES ('w-s1b', 's1', '/w/s1b', 'vs/s1b', 'main', 'ready', 'not_configured', 1)").run();
      // participant принадлежит w-s1, поэтому ход в другом workspace той же сессии недопустим.
      expect(() => turn(db, 'tx', 's1', 'pa-s1', 1, 'completed', 'op-tx', 'w-s1b')).toThrowError(/FOREIGN KEY/);
      // Операция чужой сессии не может быть операцией этого хода.
      operation(db, 'op-foreign', 'w-s2');
      expect(() => db.prepare("INSERT INTO turns (id, session_id, workspace_id, participant_id, seq, prompt, conversation, status, operation_id, started_at) VALUES ('ty', 's1', 'w-s1', 'pa-s1', 1, 'p', 'new', 'completed', 'op-foreign', 't')").run())
        .toThrowError(/FOREIGN KEY/);
      // Операция без workspace не подходит для ходов и слотов.
      db.prepare("INSERT INTO operations (id, request_id, kind, fingerprint, status, phase, created_at, updated_at) VALUES ('op-bare', 'op-bare', 'select_project', 'f', 'completed', 'result_saved', 't', 't')").run();
      expect(() => db.prepare("INSERT INTO workspace_leases (workspace_id, operation_id, state, updated_at) VALUES ('w-s1', 'op-bare', 'released', 't')").run())
        .toThrowError(/FOREIGN KEY/);
      expect(() => db.prepare("INSERT INTO workspace_leases (workspace_id, operation_id, state, updated_at) VALUES ('w-s1', 'op-foreign', 'released', 't')").run())
        .toThrowError(/FOREIGN KEY/);
    } finally { db.close(); }
  });

  it('ссылки операции на сессию, workspace и проект проверяются по принадлежности и при COMMIT', () => {
    const db = seeded();
    try {
      const insert = (id: string, session: string | null, workspace: string | null, project: string | null = null) =>
        db.prepare("INSERT INTO operations (id, request_id, kind, fingerprint, status, phase, session_id, workspace_id, project_id, created_at, updated_at) VALUES (?, ?, 'create_session', 'f', 'pending', 'intent_saved', ?, ?, ?, 't', 't')")
          .run(id, id, session, workspace, project);
      expect(() => insert('o-foreign', 's1', 'w-s2')).toThrowError(/FOREIGN KEY/);
      expect(() => insert('o-orphan', null, 'w-s1')).toThrowError(/CHECK/);
      expect(() => insert('o-project', null, null, 'нет-проекта')).toThrowError(/FOREIGN KEY/);
      insert('o-ok', 's1', 'w-s1', 'p1');

      // Намерение пишется раньше сущности в одной транзакции: порядок внутри неё не важен.
      db.exec('BEGIN');
      insert('o-new', 's-new', 'w-new');
      db.prepare("INSERT INTO sessions (id, project_id, title, status, detail, created_at, updated_at) VALUES ('s-new', 'p1', 't', 'preparing', '', 't', 't')").run();
      db.prepare("INSERT INTO workspaces (id, session_id, path, branch, base_ref, state, setup_state, config_version) VALUES ('w-new', 's-new', '/w/new', 'vs/new', 'main', 'creating', 'pending', 1)").run();
      db.exec('COMMIT');
      expect(db.prepare("SELECT count(*) AS n FROM operations WHERE id = 'o-new'").get()).toEqual({ n: 1 });

      // Если сущность так и не появилась, COMMIT отклоняется целиком.
      db.exec('BEGIN');
      insert('o-dangling', 's-never', null);
      expect(() => db.exec('COMMIT')).toThrowError(/FOREIGN KEY/);
      db.exec('ROLLBACK');
      expect(db.prepare("SELECT count(*) AS n FROM operations WHERE id = 'o-dangling'").get()).toEqual({ n: 0 });
    } finally { db.close(); }
  });

  it('request_id операций и путь проекта уникальны; личность операции неизменна', () => {
    const db = seeded();
    try {
      const op = (id: string, request: string) => db.prepare("INSERT INTO operations (id, request_id, kind, fingerprint, status, phase, created_at, updated_at) VALUES (?, ?, 'send_turn', 'f', 'pending', 'intent_saved', 't', 't')")
        .run(id, request);
      op('o1', 'r1');
      expect(() => op('o2', 'r1')).toThrowError(/UNIQUE/);
      expect(() => db.prepare("UPDATE operations SET fingerprint = 'другой' WHERE id = 'o1'").run()).toThrowError(/operation_identity_immutable/);
      expect(() => db.prepare("UPDATE operations SET request_id = 'r2' WHERE id = 'o1'").run()).toThrowError(/operation_identity_immutable/);
      db.prepare("UPDATE operations SET status = 'completed', phase = 'result_saved' WHERE id = 'o1'").run();
      expect(() => db.prepare("INSERT INTO projects (id, canonical_path, name, default_branch, config_version, config_json) VALUES ('p2', '/p1', 'dup', 'main', 1, '{}')").run())
        .toThrowError(/UNIQUE/);
    } finally { db.close(); }
  });

  it('действует одно выданное согласие на операцию; отзыв освобождает место', () => {
    const db = seeded();
    try {
      const consent = (id: string, status: string) => db.prepare("INSERT INTO consents (id, operation_id, project_id, version, context_digest, fingerprint, coverage_json, status, updated_at) VALUES (?, 'setup:p1', 'p1', 1, 'c', 'f', '{}', ?, 't')")
        .run(id, status);
      consent('c1', 'granted');
      expect(() => consent('c2', 'granted')).toThrowError(/UNIQUE/);
      db.prepare("UPDATE consents SET status = 'revoked' WHERE id = 'c1'").run();
      consent('c3', 'granted');
      consent('c4', 'invalidated');
      expect(() => consent('c5', 'allowed')).toThrowError(/CHECK/);
    } finally { db.close(); }
  });

  it('история не удаляется и события не переписываются, в том числе при уборке workspace', () => {
    const db = seeded();
    try {
      lease(db, 'w-s1', 'op-t1');
      turn(db, 't1', 's1', 'pa-s1', 1, 'completed');
      db.prepare("INSERT INTO events (session_id, seq, event_id, ts, type, payload_json) VALUES ('s1', 1, 'e1', 't', 'diagnostic', '{}')").run();
      db.prepare("INSERT INTO operations (id, request_id, kind, fingerprint, status, phase, session_id, workspace_id, created_at, updated_at) VALUES ('o1', 'r1', 'send_turn', 'f', 'completed', 'result_saved', 's1', 'w-s1', 't', 't')").run();
      db.prepare("INSERT INTO git_operations (request_id, operation_id, kind, repository_id, phase, operation_json, created_at, updated_at) VALUES ('g1', 'go1', 'create', 'r', 'completed', '{}', 't', 't')").run();
      for (const table of ['events', 'turns', 'operations', 'git_operations', 'workspaces']) {
        expect(() => db.prepare(`DELETE FROM ${table}`).run()).toThrowError(/history_immutable/);
      }
      expect(() => db.prepare("UPDATE events SET type = 'x'").run()).toThrowError(/history_immutable/);
      db.prepare("UPDATE workspaces SET state = 'missing' WHERE id = 'w-s1'").run();
      expect(db.prepare('SELECT count(*) AS n FROM events').get()).toEqual({ n: 1 });
      // op-t1 принадлежит слоту и ходу, o1 добавлена тестом.
      expect(db.prepare('SELECT count(*) AS n FROM operations').get()).toEqual({ n: 2 });
      expect(db.prepare('SELECT count(*) AS n FROM turns').get()).toEqual({ n: 1 });
    } finally { db.close(); }
  });
});
