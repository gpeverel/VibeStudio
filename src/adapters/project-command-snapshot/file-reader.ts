import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import type { ProjectCommandSnapshotIssue } from '../../shared/project-command-consent.ts';

/** Минимальная файловая поверхность адаптера; тесты подменяют её для детерминированной гонки. */
export interface SnapshotFileStat {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly ino: number;
  readonly dev: number;
  readonly mode: number;
}
export interface SnapshotFileHandle {
  stat(): Promise<SnapshotFileStat>;
  read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ readonly bytesRead: number }>;
  close(): Promise<void>;
}
export interface SnapshotFs {
  lstat(path: string): Promise<SnapshotFileStat>;
  realpath(path: string): Promise<string>;
  open(path: string, flags: number): Promise<SnapshotFileHandle>;
}

export const nodeSnapshotFs: SnapshotFs = {
  lstat: (path) => lstat(path),
  realpath: (path) => realpath(path),
  async open(path, flags) {
    const handle = await open(path, flags);
    return {
      stat: () => handle.stat(),
      read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
      close: () => handle.close(),
    };
  },
};

/** O_NONBLOCK: подменённый на FIFO путь не повесит чтение; O_NOFOLLOW: путь уже канонический. */
const READ_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;
const CHUNK_BYTES = 64 * 1024;
const PREFIX_BYTES = 256;

/** Внутренняя причина: код из закрытого DTO и безопасная метка для тестов адаптера. */
export interface SnapshotIssue {
  readonly code: ProjectCommandSnapshotIssue;
  readonly detail: string;
}

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Не раскрывает errno-текст, путь или сообщение: только категория. */
export function issueFromError(error: unknown, detail: string): SnapshotIssue {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : '';
  switch (code) {
    case 'ENOENT': case 'ENOTDIR': return { code: 'missing_input', detail };
    case 'EACCES': case 'EPERM': case 'EIO': return { code: 'unreadable_input', detail };
    case 'ELOOP': case 'ENAMETOOLONG': return { code: 'ambiguous_path', detail };
    case 'EISDIR': return { code: 'non_regular_input', detail };
    default: return { code: 'snapshot_failed', detail };
  }
}

export interface ReadBudget {
  remaining: number;
}

export interface ReadOptions {
  readonly maxBytes: number;
  /** Сколько байт содержимого сохранить для разбора; 0 — только хэш. Больший файл хэшируется без сохранения. */
  readonly keepBytes: number;
  readonly budget: ReadBudget;
  readonly detail: string;
}

export type ReadOutcome =
  | {
      readonly ok: true; readonly digest: string; readonly bytes: number; readonly content: Uint8Array | undefined;
      /** Первые байты файла независимо от keepBytes: по ним распознаётся shebang крупного файла. */
      readonly prefix: Uint8Array;
    }
  | { readonly ok: false; readonly issue: SnapshotIssue };

function same(a: SnapshotFileStat, b: SnapshotFileStat): boolean {
  return a.ino === b.ino && a.dev === b.dev && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

/**
 * Читает обычный файл по каноническому пути и считает SHA-256 байтов. Идентичность — содержимое,
 * mtime используется только для обнаружения изменения во время чтения. Состояние до открытия, после
 * открытия, после чтения и по пути в конце должно совпадать, иначе `unstable_input`. Это не защищает от
 * изменения после возврата результата.
 */
export async function readStable(fs: SnapshotFs, realPath: string, options: ReadOptions): Promise<ReadOutcome> {
  const fail = (issue: SnapshotIssue): ReadOutcome => ({ ok: false, issue });
  try {
    const before = await fs.lstat(realPath);
    if (!before.isFile()) return fail({ code: 'non_regular_input', detail: options.detail });
    if (before.size > options.maxBytes) return fail({ code: 'limit_exceeded', detail: options.detail });
    const handle = await fs.open(realPath, READ_FLAGS);
    try {
      const opened = await handle.stat();
      if (!opened.isFile()) return fail({ code: 'non_regular_input', detail: options.detail });
      if (!same(before, opened)) return fail({ code: 'unstable_input', detail: options.detail });
      const hash = createHash('sha256');
      const kept: Uint8Array[] = [];
      const chunk = new Uint8Array(CHUNK_BYTES);
      let total = 0;
      let prefix = new Uint8Array(0);
      for (;;) {
        const { bytesRead } = await handle.read(chunk, 0, CHUNK_BYTES, total);
        if (bytesRead === 0) break;
        total += bytesRead;
        // Файл вырос относительно состояния после открытия: меняется прямо во время чтения.
        if (total > opened.size) return fail({ code: 'unstable_input', detail: options.detail });
        if (total > options.maxBytes) return fail({ code: 'limit_exceeded', detail: options.detail });
        options.budget.remaining -= bytesRead;
        if (options.budget.remaining < 0) return fail({ code: 'limit_exceeded', detail: 'total_bytes' });
        const piece = chunk.subarray(0, bytesRead);
        if (total === bytesRead) prefix = piece.slice(0, PREFIX_BYTES);
        hash.update(piece);
        if (options.keepBytes > 0 && total <= options.keepBytes) kept.push(piece.slice());
      }
      const after = await handle.stat();
      const byPath = await fs.lstat(realPath);
      if (total !== opened.size || !same(opened, after) || !same(opened, byPath)) {
        return fail({ code: 'unstable_input', detail: options.detail });
      }
      const content = options.keepBytes > 0 && total <= options.keepBytes ? Buffer.concat(kept) : undefined;
      return { ok: true, digest: hash.digest('hex'), bytes: total, content, prefix };
    } finally {
      await handle.close().catch(() => undefined);
    }
  } catch (error) {
    return fail(issueFromError(error, options.detail));
  }
}
