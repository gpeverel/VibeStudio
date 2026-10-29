import type { GitOperation, GitOperationStore } from '../../core/ports/git.ts';
import type { Connection } from './connection.ts';

interface GitOperationRow { operation_json: string }

/**
 * Durable GitOperationStore 0B на той же БД. Контракт сохранён: save заменяет запись по requestId,
 * get/list отдают независимые копии. Сбой записи фиксируется общей защёлкой Connection.
 */
export function createSqliteGitOperationStore(connection: Connection, now: () => string = () => new Date().toISOString()): GitOperationStore {
  const { db } = connection;
  const find = db.prepare('SELECT operation_json FROM git_operations WHERE request_id = ?');
  const all = db.prepare('SELECT operation_json FROM git_operations ORDER BY created_at, rowid');
  const upsert = db.prepare(`INSERT INTO git_operations (request_id, operation_id, kind, repository_id, phase, operation_json, created_at, updated_at)
    VALUES (@request, @operation, @kind, @repository, @phase, @json, @now, @now)
    ON CONFLICT(request_id) DO UPDATE SET operation_id = excluded.operation_id, kind = excluded.kind,
      repository_id = excluded.repository_id, phase = excluded.phase, operation_json = excluded.operation_json,
      updated_at = excluded.updated_at`);
  const parse = (row: GitOperationRow): GitOperation => JSON.parse(row.operation_json) as GitOperation;

  return {
    async get(requestId) {
      const row = connection.read(() => find.get(requestId) as GitOperationRow | undefined);
      return row ? parse(row) : undefined;
    },
    async save(operation) {
      connection.transact({ operation: 'git_operation', requestId: operation.requestId, eventTypes: [] }, () => {
        upsert.run({
          request: operation.requestId, operation: operation.operationId, kind: operation.kind,
          repository: operation.repositoryId, phase: operation.phase, json: JSON.stringify(operation), now: now(),
        });
      });
    },
    async list() {
      return connection.read(() => (all.all() as GitOperationRow[]).map(parse));
    },
  };
}
