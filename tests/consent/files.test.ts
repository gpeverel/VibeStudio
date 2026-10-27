import { mkdirSync, renameSync, statSync, utimesSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nodeSnapshotFs, readStable } from '../../src/adapters/project-command-snapshot/file-reader.ts';
import type { SnapshotFs } from '../../src/adapters/project-command-snapshot/file-reader.ts';
import { ConsentStand } from '../helpers/consent.ts';

const stands: ConsentStand[] = [];
function setup(): ConsentStand { const stand = new ConsentStand(); stands.push(stand); return stand; }
afterEach(() => { for (const stand of stands.splice(0)) stand.cleanup(); });
function options(maxBytes = 1024) {
  return { maxBytes, keepBytes: maxBytes, budget: { remaining: 4096 }, detail: 'fixture-file' };
}

describe('P4: снимок реальных байтов и ошибки чтения', () => {
  it('считает SHA-256 содержимого и не зависит от одного mtime', async () => {
    const stand = setup();
    const path = stand.file('entry.js', 'abc');
    const first = await readStable(nodeSnapshotFs, path, options());
    expect(first).toMatchObject({ ok: true, digest: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', bytes: 3 });
    utimesSync(path, new Date('2001-01-01T00:00:00Z'), new Date('2001-01-01T00:00:00Z'));
    expect(await readStable(nodeSnapshotFs, path, options())).toEqual(first);
  });

  it('обнаруживает новые байты при прежних размере и времени файла', async () => {
    const stand = setup();
    const path = stand.file('entry.js', 'abc');
    utimesSync(path, 1_000_000, 1_000_000);
    const before = statSync(path);
    const first = await readStable(nodeSnapshotFs, path, options());
    stand.replaceKeepingTimes('entry.js', 'abd');
    const after = statSync(path);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    const second = await readStable(nodeSnapshotFs, path, options());
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error('Ожидались два установленных снимка');
    expect(second.digest).not.toBe(first.digest);
  });

  it('отсутствующий файл возвращает missing_input', async () => {
    const stand = setup();
    expect(await readStable(nodeSnapshotFs, stand.path('missing.js'), options())).toEqual({
      ok: false, issue: { code: 'missing_input', detail: 'fixture-file' },
    });
  });

  it('отказ чтения возвращает unreadable_input без сырого пути и секрета', async () => {
    const stand = setup();
    const path = stand.file('entry.js', 'abc');
    const fs: SnapshotFs = { ...nodeSnapshotFs, open: async () => {
      throw Object.assign(new Error(`/private/P4_SECRET_DENIED/${path}`), { code: 'EACCES' });
    } };
    const result = await readStable(fs, path, options());
    expect(result).toEqual({ ok: false, issue: { code: 'unreadable_input', detail: 'fixture-file' } });
    expect(JSON.stringify(result)).not.toContain('P4_SECRET_DENIED');
    expect(JSON.stringify(result)).not.toContain(stand.root);
  });

  it('каталог вместо файла отклоняется до открытия', async () => {
    const stand = setup();
    const path = stand.path('entry.js');
    mkdirSync(path);
    const open = vi.fn(nodeSnapshotFs.open);
    expect(await readStable({ ...nodeSnapshotFs, open }, path, options())).toMatchObject({
      ok: false, issue: { code: 'non_regular_input' },
    });
    expect(open).not.toHaveBeenCalled();
  });

  it('файл сверх лимита отклоняется до открытия', async () => {
    const stand = setup();
    const path = stand.file('entry.js', '12345');
    const open = vi.fn(nodeSnapshotFs.open);
    expect(await readStable({ ...nodeSnapshotFs, open }, path, options(4))).toMatchObject({
      ok: false, issue: { code: 'limit_exceeded' },
    });
    expect(open).not.toHaveBeenCalled();
  });

  it('общий бюджет чтения ограничивает сумму входов', async () => {
    const stand = setup();
    const config = options();
    config.budget.remaining = 5;
    expect((await readStable(nodeSnapshotFs, stand.file('first.js', 'abc'), config)).ok).toBe(true);
    expect(await readStable(nodeSnapshotFs, stand.file('second.js', 'def'), config)).toMatchObject({
      ok: false, issue: { code: 'limit_exceeded' },
    });
  });

  it('атомарная замена пути во время чтения даёт unstable_input и закрывает дескриптор', async () => {
    const stand = setup();
    const path = stand.file('entry.js', 'abc');
    const replacement = stand.file('replacement.js', 'def');
    let replaced = false;
    const close = vi.fn<() => Promise<void>>();
    const fs: SnapshotFs = { ...nodeSnapshotFs, open: async (target, flags) => {
      const handle = await nodeSnapshotFs.open(target, flags);
      close.mockImplementation(() => handle.close());
      return { ...handle, close, read: async (...args) => {
        const result = await handle.read(...args);
        if (!replaced) { replaced = true; renameSync(replacement, path); }
        return result;
      } };
    } };
    expect(await readStable(fs, path, options())).toMatchObject({ ok: false, issue: { code: 'unstable_input' } });
    expect(replaced).toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });
});
