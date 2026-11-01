import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createJournal } from '../../src/adapters/journal/index.ts';
import { TempDir } from '../store/helpers.ts';

let temp: TempDir;
beforeEach(() => { temp = new TempDir(); });
afterEach(() => temp.cleanup());

const entry = (detail: string, overrides: Partial<Parameters<ReturnType<typeof createJournal>['append']>[0]> = {}) =>
  ({ timestamp: '2026-10-29T10:00:00.000Z', sessionId: 'session-1', code: 'diagnostic', detail, ...overrides });
const lines = (path: string) => readFileSync(path, 'utf8').split('\n').filter(Boolean);

describe('JSONL-журнал диагностики', () => {
  it('пишет по одной JSON-строке на запись, с правами только владельца', async () => {
    const directory = temp.path('logs');
    const journal = createJournal({ directory });
    await journal.append(entry('первая'));
    await journal.append(entry('вторая', { code: 'recovery' }));

    const rows = lines(`${directory}/journal.jsonl`).map(line => JSON.parse(line) as Record<string, string>);
    expect(rows).toEqual([
      { ts: '2026-10-29T10:00:00.000Z', session: 'session-1', code: 'diagnostic', detail: 'первая' },
      { ts: '2026-10-29T10:00:00.000Z', session: 'session-1', code: 'recovery', detail: 'вторая' },
    ]);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(`${directory}/journal.jsonl`).mode & 0o777).toBe(0o600);
  });

  it('недоверенный текст не разрывает строки и не раскрывает типичные секреты; длина ограничена', async () => {
    const directory = temp.path('logs');
    const journal = createJournal({ directory });
    await journal.append(entry('a\nb\r\n{"forged":true}\u0000\u001b[31m'));
    await journal.append(entry('Authorization: Bearer abcdefghijklmnop1234 и API_KEY=supersecretvalue и sk-abcdefghijklmnopqrstuv'));
    await journal.append(entry('x'.repeat(50_000)));

    const rows = lines(`${directory}/journal.jsonl`);
    expect(rows).toHaveLength(3);
    const [first, second, third] = rows.map(line => JSON.parse(line) as { detail: string });
    expect([...first!.detail].some(char => char < ' ' || char === '\u007f')).toBe(false);
    expect(first?.detail).toContain('{"forged":true}');
    expect(second?.detail).not.toMatch(/abcdefghijklmnop1234|supersecretvalue|sk-abcdefghijklmnopqrstuv/);
    expect(second?.detail).toContain('[скрыто]');
    expect(third?.detail.length).toBeLessThanOrEqual(1_001);
  });

  it('ротирует файл по размеру и хранит ограниченное число файлов, оставляя новейшие записи', async () => {
    const directory = temp.path('logs');
    let tick = 0;
    const journal = createJournal({ directory, maxFileBytes: 400, maxFiles: 3, now: () => ++tick });
    for (let index = 0; index < 40; index++) await journal.append(entry(`запись-${String(index).padStart(2, '0')}`));

    const names = readdirSync(directory).sort();
    expect(names).toHaveLength(3);
    expect(names).toContain('journal.jsonl');
    const total = names.reduce((sum, name) => sum + statSync(`${directory}/${name}`).size, 0);
    expect(total).toBeLessThanOrEqual(3 * 400);
    const kept = names.flatMap(name => lines(`${directory}/${name}`)).map(line => (JSON.parse(line) as { detail: string }).detail);
    expect(kept).toContain('запись-39');
    expect(kept).not.toContain('запись-00');
    // Остаётся непрерывный хвост самых новых записей, без дыр в середине.
    const indexes = kept.map(detail => Number(detail.slice('запись-'.length))).sort((a, b) => a - b);
    expect(indexes).toEqual(Array.from({ length: indexes.length }, (_, offset) => 40 - indexes.length + offset));
  });

  it('параллельные записи не перемешиваются и сохраняют порядок', async () => {
    const directory = temp.path('logs');
    const journal = createJournal({ directory });
    await Promise.all(Array.from({ length: 60 }, (_, index) => journal.append(entry(`n-${index}`))));
    const details = lines(`${directory}/journal.jsonl`).map(line => (JSON.parse(line) as { detail: string }).detail);
    expect(details).toEqual(Array.from({ length: 60 }, (_, index) => `n-${index}`));
  });

  it('сбой записи отклоняет только этот append: следующий проходит после исправления причины', async () => {
    const directory = temp.path('logs');
    // На месте каталога журнала лежит обычный файл.
    writeFileSync(directory, 'не каталог');
    const journal = createJournal({ directory });
    const failing = journal.append(entry('потеряна'));
    await expect(failing).rejects.toBeInstanceOf(Error);
    await expect(journal.append(entry('снова потеряна'))).rejects.toBeInstanceOf(Error);

    rmSync(directory);
    mkdirSync(directory);
    await journal.append(entry('дошла'));
    expect(lines(`${directory}/journal.jsonl`).map(line => (JSON.parse(line) as { detail: string }).detail)).toEqual(['дошла']);
  });

  it('продолжает существующий файл после перезапуска и учитывает его размер при ротации', async () => {
    const directory = temp.path('logs');
    const first = createJournal({ directory, maxFileBytes: 300, maxFiles: 2 });
    for (let index = 0; index < 3; index++) await first.append(entry(`до-перезапуска-${index}`));
    const second = createJournal({ directory, maxFileBytes: 300, maxFiles: 2 });
    for (let index = 0; index < 6; index++) await second.append(entry(`после-перезапуска-${index}`));
    const names = readdirSync(directory);
    expect(names.length).toBeLessThanOrEqual(2);
    for (const name of names) expect(statSync(`${directory}/${name}`).size).toBeLessThanOrEqual(300);
  });
});
