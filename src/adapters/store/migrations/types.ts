import type Database from 'better-sqlite3';

/** Миграция выполняется в одной транзакции вместе с повышением user_version. */
export interface Migration {
  /** Целевое значение PRAGMA user_version; последовательность начинается с 1 без пропусков. */
  readonly version: number;
  readonly name: string;
  up(db: Database.Database): void;
}
