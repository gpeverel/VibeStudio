import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAccessStand } from '../helpers/claude/access-stand.ts';
import { runTestProcess } from '../helpers/process.ts';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});
afterEach(() => { vi.mocked(execFileSync).mockReset(); });

describe('Процессы тестового стенда: конечное синхронное ожидание', () => {
  it('возвращает stdout успешного процесса', () => {
    expect(runTestProcess(process.execPath, ['-e', 'process.stdout.write("controlled")'], { env: {} })).toBe('controlled');
  });

  it('ненулевой exit остаётся ошибкой с исходным status', () => {
    expect(() => runTestProcess(process.execPath, ['-e', 'process.exit(7)'], { env: {} })).toThrow(expect.objectContaining({ status: 7 }));
  });

  it('deadline завершает свой процесс, даже если SIGTERM игнорируется и таймер родителя не работает', () => {
    let parentTimerFired = false;
    const timer = setTimeout(() => { parentTimerFired = true; }, 10);
    let failure: unknown;
    try {
      try {
        // Сам завершится через 2 с даже при регрессии helper: тест не создаёт вечного процесса.
        runTestProcess(process.execPath, ['-e', 'process.on("SIGTERM",()=>{}); process.stdout.write("ready"); setTimeout(()=>{},2000)'],
          { env: {}, timeoutMs: 500 });
      } catch (error) { failure = error; }
      expect(failure).toMatchObject({ code: 'ETIMEDOUT', signal: 'SIGKILL', stdout: 'ready' });
      expect(parentTimerFired).toBe(false); // Тот же предел относится к таймеру Vitest.
      const pid = (failure as { pid: number }).pid;
      expect(pid).toBeGreaterThan(0);
      expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    } finally { clearTimeout(timer); }
  });

  it.each([0, -1, Infinity])('timeout=%s не отключает deadline', timeoutMs => {
    expect(() => runTestProcess(process.execPath, [], { timeoutMs })).toThrow(RangeError);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('ошибка подготовки убирает собственный каталог до возврата стенда вызывающему тесту', () => {
    let ownRoot: string | undefined;
    vi.mocked(execFileSync).mockImplementationOnce((_file, _args, options) => {
      const candidate = dirname(String(options?.cwd));
      expect(dirname(candidate)).toBe(realpathSync(tmpdir()));
      expect(basename(candidate)).toMatch(/^vs-access-/);
      ownRoot = candidate;
      throw Object.assign(new Error('synthetic setup deadline'), { code: 'ETIMEDOUT' });
    });
    try {
      expect(() => createAccessStand()).toThrow('synthetic setup deadline');
      expect(ownRoot).toBeDefined();
      expect(existsSync(ownRoot!)).toBe(false);
    } finally { if (ownRoot) rmSync(ownRoot, { recursive: true, force: true }); }
  });

  it('deadline снимка не превращается в одинаковый UNREADABLE до и после проверки', () => {
    const stand = createAccessStand();
    try {
      vi.mocked(execFileSync).mockImplementationOnce(() => {
        throw Object.assign(new Error('synthetic snapshot deadline'), { code: 'ETIMEDOUT' });
      });
      expect(() => stand.snapshot()).toThrow('synthetic snapshot deadline');
    } finally { stand.cleanup(); }
  });
});
