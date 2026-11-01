import type Database from 'better-sqlite3';
import { StoreError } from '../../core/ports/store.ts';

/** До и после SQLite COMMIT. Для тестов аварий: инжектор может бросить ошибку или завершить процесс. */
export type StoreFaultPoint = 'before_commit' | 'after_commit';
export interface StoreFaultContext {
  readonly operation: 'begin_operation' | 'commit' | 'git_operation';
  readonly requestId?: string;
  readonly eventTypes: readonly string[];
}
export type StoreFaultInjector = (point: StoreFaultPoint, context: StoreFaultContext) => void;

/** Ошибка, внесённая инжектором до COMMIT: для фиксации отказа записи неотличима от сбоя SQLite. */
class InjectedFault extends Error {}

function sqliteCode(error: unknown): string | undefined {
  const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && code.startsWith('SQLITE_') ? code : undefined;
}

/**
 * Единственное соединение приложения с БД и защёлка отказа.
 * После первой ошибки записи, не являющейся нарушением ограничения, соединение больше
 * не принимает записей: намерения и исходы нельзя фиксировать, значит новые эффекты запрещены.
 */
export class Connection {
  private failure: StoreError | undefined;
  private isClosed = false;

  constructor(readonly db: Database.Database, private readonly injector?: StoreFaultInjector) {}

  get failed(): boolean { return this.failure !== undefined || this.isClosed; }

  /** Запись одной транзакцией (BEGIN IMMEDIATE). Чтения вне транзакций идут через read(). */
  transact<T>(context: StoreFaultContext, work: () => T): T {
    this.assertWritable();
    let value: T;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        value = work();
        this.inject('before_commit', context);
        this.db.exec('COMMIT');
      } catch (error) {
        try { this.db.exec('ROLLBACK'); } catch { /* транзакция уже завершена SQLite */ }
        throw error;
      }
    } catch (error) {
      throw this.classify(error);
    }
    // После COMMIT исключение инжектора не отменяет запись: так выглядит сбой до уведомления.
    this.injector?.('after_commit', context);
    return value;
  }

  read<T>(work: () => T): T {
    if (this.isClosed) throw new StoreError('store_failed', 'Хранилище закрыто.');
    try {
      return work();
    } catch (error) {
      if (error instanceof StoreError) throw error;
      throw new StoreError('store_failed', 'Не удалось прочитать состояние.', error);
    }
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.db.close();
  }

  private assertWritable(): void {
    if (this.isClosed) throw new StoreError('store_failed', 'Хранилище закрыто.');
    if (this.failure) throw new StoreError('store_failed', 'Запись состояния остановлена после предыдущей ошибки SQLite.', this.failure);
  }

  private inject(point: StoreFaultPoint, context: StoreFaultContext): void {
    if (!this.injector) return;
    try {
      this.injector(point, context);
    } catch (error) {
      throw new InjectedFault('Инжектор отказа прервал запись.', { cause: error });
    }
  }

  private classify(error: unknown): StoreError {
    if (error instanceof StoreError) return error;
    const code = sqliteCode(error);
    if (code?.startsWith('SQLITE_CONSTRAINT')) {
      const message = (error as Error).message;
      if (message.includes('operations.request_id') || message.includes('operation_identity_immutable')) {
        return new StoreError('request_conflict', 'Этот requestId уже использован для другой операции.', error);
      }
      return new StoreError('constraint', `Запись нарушает ограничение хранилища: ${message}`, error);
    }
    if (code !== undefined || error instanceof InjectedFault) {
      // Отказ записи: дальнейшие эффекты без возможности зафиксировать намерение запрещены.
      this.failure = new StoreError('store_failed', 'Не удалось записать состояние в SQLite.', error);
      return this.failure;
    }
    // Ошибка вызывающего кода (например, неэкспортируемое значение): транзакция откатана, БД исправна.
    return new StoreError('constraint', 'Недопустимая запись состояния.', error);
  }
}
