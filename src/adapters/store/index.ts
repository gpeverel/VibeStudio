import type { GitOperationStore } from '../../core/ports/git.ts';
import type { Store } from '../../core/ports/store.ts';
import { Connection, type StoreFaultInjector } from './connection.ts';
import { openDatabase, type MigrationReport, type OpenDatabaseOptions } from './database.ts';
import { createSqliteGitOperationStore } from './git-operation-store.ts';
import { SqliteStore } from './sqlite-store.ts';

export { StorageError, type StorageErrorCode } from './database.ts';
export { MIGRATIONS, type Migration } from './migrations/index.ts';
export type { StoreFaultContext, StoreFaultInjector, StoreFaultPoint } from './connection.ts';

export interface SqliteStorageOptions extends Omit<OpenDatabaseOptions, 'path'> {
  /** Используется в тестах аварий: вызывается до и после SQLite COMMIT каждой записи. */
  faultInjector?: StoreFaultInjector;
  /** ISO-время записей, которых нет в доменных записях (слоты, git_operations). */
  clock?: () => string;
}

export interface SqliteStorage {
  /** Состояние Solo, события и согласия; синхронные транзакции. */
  readonly store: Store;
  /** Durable GitOperationStore 0B на том же соединении и той же защёлке отказа. */
  readonly gitOperationStore: GitOperationStore;
  /** Что сделала миграция при открытии. */
  readonly migration: MigrationReport | undefined;
  close(): void;
}

/** Открывает настоящий файл БД, применяет миграции и собирает хранилища на одном соединении. */
export function openSqliteStorage(path: string, options: SqliteStorageOptions = {}): SqliteStorage {
  const { faultInjector, clock, ...database } = options;
  const opened = openDatabase({ path, ...database });
  const connection = new Connection(opened.db, faultInjector);
  const store = new SqliteStore(connection, clock ? { now: clock } : {});
  return {
    store,
    gitOperationStore: createSqliteGitOperationStore(connection, clock),
    migration: opened.migrated,
    close: () => connection.close(),
  };
}
