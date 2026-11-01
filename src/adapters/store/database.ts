import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { APPLICATION_ID, MIGRATIONS, type Migration } from './migrations/index.ts';

export type StorageErrorCode =
  | 'invalid_migrations' | 'open_failed' | 'database_corrupt' | 'database_foreign'
  | 'database_too_new' | 'backup_failed' | 'migration_failed';

/** Ошибки открытия БД: только код и безопасные числовые/путевые факты, без содержимого таблиц. */
export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly details: Readonly<Record<string, string | number>>;

  constructor(code: StorageErrorCode, message: string, details: Record<string, string | number> = {}, cause?: unknown) {
    super(message, { cause });
    this.name = 'StorageError';
    this.code = code;
    this.details = details;
  }
}

export interface OpenDatabaseOptions {
  /** Путь к файлу БД. In-memory и временные «:memory:» не принимаются: P5 проверяет настоящий файл. */
  path: string;
  /** Для тестов миграций; в продукте используется MIGRATIONS. */
  migrations?: readonly Migration[];
  now?: () => Date;
}

export interface MigrationReport {
  from: number;
  to: number;
  /** Есть только при обновлении непустой БД. */
  backupPath?: string;
}

export interface OpenedDatabase {
  db: Database.Database;
  version: number;
  migrated?: MigrationReport;
}

function validateMigrations(migrations: readonly Migration[]): void {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1 || !Number.isSafeInteger(migration.version)) {
      throw new StorageError('invalid_migrations', 'Миграции должны быть пронумерованы подряд с 1.', { index, version: migration.version });
    }
  });
}

interface Inspection { version: number; applicationId: number; tables: number }

/** Чтение без записи: у более новой или чужой БД не меняются ни файл, ни режим журнала. */
function inspect(path: string): Inspection {
  let db: Database.Database | undefined;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
    const quick = db.pragma('quick_check', { simple: true });
    if (quick !== 'ok') throw new StorageError('database_corrupt', 'Проверка целостности БД не пройдена.');
    return {
      version: db.pragma('user_version', { simple: true }) as number,
      applicationId: db.pragma('application_id', { simple: true }) as number,
      tables: (db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number }).n,
    };
  } catch (error) {
    if (error instanceof StorageError) throw error;
    const code = (error as { code?: unknown }).code;
    if (code === 'SQLITE_NOTADB' || code === 'SQLITE_CORRUPT') throw new StorageError('database_corrupt', 'Файл не является БД SQLite или повреждён.', {}, error);
    throw new StorageError('open_failed', 'Не удалось открыть БД для проверки.', {}, error);
  } finally {
    db?.close();
  }
}

function backupPathFor(path: string, from: number, to: number, now: Date): string {
  const stamp = now.toISOString().replace(/[-:.]/g, '').replace('T', '-').slice(0, 15);
  const base = `${path}.pre-v${from}-to-v${to}-${stamp}`;
  for (let attempt = 0; ; attempt++) {
    const candidate = attempt === 0 ? `${base}.bak` : `${base}-${attempt}.bak`;
    if (!existsSync(candidate)) return candidate;
  }
}

/** Согласованная копия через VACUUM INTO: целостный снимок без остановки писателей и WAL-хвоста. */
function backup(db: Database.Database, path: string, from: number, to: number, now: Date): string {
  const target = backupPathFor(path, from, to, now);
  try {
    db.prepare('VACUUM INTO ?').run(target);
    const copy = new Database(target, { readonly: true, fileMustExist: true });
    try {
      if (copy.pragma('quick_check', { simple: true }) !== 'ok' || copy.pragma('user_version', { simple: true }) !== from) {
        throw new Error('Резервная копия не прошла проверку.');
      }
    } finally {
      copy.close();
    }
  } catch (error) {
    throw new StorageError('backup_failed', 'Не удалось создать согласованную резервную копию перед миграцией.', { from, to }, error);
  }
  return target;
}

function applyMigration(db: Database.Database, migration: Migration): void {
  // PRAGMA foreign_keys не меняется внутри транзакции; проверка целостности — до commit.
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      migration.up(db);
      const violations = db.pragma('foreign_key_check') as unknown[];
      if (violations.length) throw new Error(`Миграция нарушила внешние ключи: ${violations.length}`);
      db.pragma(`user_version = ${migration.version}`);
    }).immediate();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

/**
 * Открывает настоящий файл БД и доводит схему до последней миграции.
 * Более новая и чужая БД не изменяются; при сбое миграции транзакция откатывается,
 * резервная копия остаётся рядом с БД.
 */
export function openDatabase(options: OpenDatabaseOptions): OpenedDatabase {
  const migrations = options.migrations ?? MIGRATIONS;
  const now = options.now ?? (() => new Date());
  validateMigrations(migrations);
  const latest = migrations.length;
  const { path } = options;
  if (!path || path === ':memory:' || path.startsWith('file:')) {
    throw new StorageError('open_failed', 'Нужен путь к файлу БД.');
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  let current = 0;
  if (existsSync(path)) {
    const found = inspect(path);
    if (found.version === 0) {
      if (found.tables > 0) throw new StorageError('database_foreign', 'В файле есть таблицы без версии схемы VibeStudio.');
    } else if (found.applicationId !== APPLICATION_ID) {
      throw new StorageError('database_foreign', 'Файл принадлежит другому приложению.', { applicationId: found.applicationId });
    } else if (found.version > latest) {
      throw new StorageError('database_too_new', 'БД создана более новой версией VibeStudio и не будет изменена.',
        { found: found.version, supported: latest });
    }
    current = found.version;
  }

  let db: Database.Database;
  try {
    db = new Database(path, { fileMustExist: false });
  } catch (error) {
    throw new StorageError('open_failed', 'Не удалось открыть БД.', {}, error);
  }
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = FULL');
    db.pragma('busy_timeout = 5000');
    const report: MigrationReport | undefined = current < latest ? { from: current, to: latest } : undefined;
    if (report && current > 0) report.backupPath = backup(db, path, current, latest, now());
    for (const migration of migrations.slice(current)) {
      try {
        applyMigration(db, migration);
      } catch (error) {
        throw new StorageError('migration_failed', `Миграция ${migration.version} (${migration.name}) не применена.`, {
          failedVersion: migration.version, fromVersion: migration.version - 1,
          ...(report?.backupPath ? { backupPath: report.backupPath } : {}),
        }, error);
      }
    }
    return { db, version: latest, ...(report ? { migrated: report } : {}) };
  } catch (error) {
    db.close();
    throw error;
  }
}
