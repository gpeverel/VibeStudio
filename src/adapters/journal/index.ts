import { appendFile, chmod, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Journal } from '../../core/ports/journal.ts';

export interface JournalOptions {
  /** Каталог журнала приложения. Создаётся с правами только владельца. */
  directory: string;
  /** Размер текущего файла, после которого он ротируется. */
  maxFileBytes?: number;
  /** Сколько файлов хранить вместе с текущим; более старые удаляются. */
  maxFiles?: number;
  now?: () => number;
}

export const DEFAULT_JOURNAL_LIMITS = { maxFileBytes: 1_048_576, maxFiles: 5 } as const;
/** Верхние границы полей: журнал — ограниченная диагностика, а не хранилище событий. */
const MAX_CODE_CHARS = 80;
const MAX_DETAIL_CHARS = 1_000;
const CURRENT = 'journal.jsonl';
const ROTATED = /^journal-\d+-\d+\.jsonl$/;

/** Управляющие символы заменяются пробелом, чтобы запись не превращалась в несколько строк журнала. */
function withoutControl(value: string): string {
  let result = '';
  for (const char of value) {
    const code = char.codePointAt(0)!;
    result += code < 0x20 || code === 0x7f ? ' ' : char;
  }
  return result;
}
/** Типичные формы секретов; список намеренно узкий, а не гарантия очистки произвольного текста. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:sk|pk|ghp|gho|github_pat|xox[abprs])[-_][A-Za-z0-9_-]{16,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_?KEY|CREDENTIAL)[A-Z0-9_]*\s*[=:]\s*\S+/g,
  /\b(?:token|secret|password|passwd|api[_-]?key)\s*[=:]\s*\S+/gi,
];

function clean(value: string, limit: number): string {
  let text = withoutControl(value);
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '[скрыто]');
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/**
 * JSONL-диагностика с ограничением размера и числа файлов. Журнал не источник бизнес-состояния:
 * сбой записи отклоняет append, но не ломает последующие записи и не меняет состояние Store.
 */
export function createJournal(options: JournalOptions): Journal {
  const maxFileBytes = positive(options.maxFileBytes, DEFAULT_JOURNAL_LIMITS.maxFileBytes);
  const maxFiles = positive(options.maxFiles, DEFAULT_JOURNAL_LIMITS.maxFiles);
  const now = options.now ?? Date.now;
  const current = join(options.directory, CURRENT);
  let size: number | undefined;
  let rotations = 0;
  // Записи идут по одной: строки разных вызовов не перемешиваются, ротация не гоняется сама с собой.
  let tail: Promise<void> = Promise.resolve();

  async function prepare(): Promise<void> {
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    if (size === undefined) {
      size = await stat(current).then(info => info.size, (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return 0;
        throw error;
      });
    }
  }

  async function rotate(): Promise<void> {
    await rename(current, join(options.directory, `journal-${now()}-${rotations++}.jsonl`));
    size = 0;
    const old = (await readdir(options.directory)).filter(name => ROTATED.test(name)).sort((a, b) => {
      const [at, an] = a.slice('journal-'.length, -'.jsonl'.length).split('-').map(Number);
      const [bt, bn] = b.slice('journal-'.length, -'.jsonl'.length).split('-').map(Number);
      return (at! - bt!) || (an! - bn!);
    });
    for (const name of old.slice(0, Math.max(0, old.length - (maxFiles - 1)))) {
      await rm(join(options.directory, name), { force: true });
    }
  }

  async function write(entry: Parameters<Journal['append']>[0]): Promise<void> {
    await prepare();
    const line = `${JSON.stringify({
      ts: clean(entry.timestamp, 40), session: clean(entry.sessionId, 128),
      code: clean(entry.code, MAX_CODE_CHARS), detail: clean(entry.detail, MAX_DETAIL_CHARS),
    })}\n`;
    const bytes = Buffer.byteLength(line);
    if (size! > 0 && size! + bytes > maxFileBytes) await rotate();
    await appendFile(current, line, { mode: 0o600 });
    await chmod(current, 0o600);
    size = size! + bytes;
  }

  return {
    append(entry) {
      const result = tail.then(() => write(entry));
      // Отказ одной записи не блокирует очередь: размер перечитывается при следующей.
      tail = result.catch(() => { size = undefined; });
      return result;
    },
  };
}
