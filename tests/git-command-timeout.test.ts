import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { createGitAdapter } from '../src/adapters/git/index.ts';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify: promisifyActual } = await import('node:util');
  // Сохраняем настоящий контракт promisify(execFile), включая stdout/stderr.
  return { ...actual, execFile: Object.assign(vi.fn(actual.execFile), {
    [promisifyActual.custom]: vi.fn(promisifyActual(actual.execFile)),
  }) };
});

afterEach(() => { vi.mocked(promisify(execFile)).mockReset(); });

it('Git deadline завершает собственный процесс, игнорирующий SIGTERM, без позднего success', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const execute = vi.mocked(promisify(execFile));
  // Synthetic child вместо Git. Предел сокращён только в double; механизм execFile настоящий.
  // При регрессии ребёнок сам выходит с 0 через 1,5 с: тест не создаёт вечного процесса.
  execute.mockImplementationOnce((_file, _args, options) => promisify(actual.execFile)(process.execPath, ['-e', [
    'process.on("SIGTERM",()=>{});',
    'process.stdout.write(String(process.pid));',
    'setTimeout(()=>{},1500);',
  ].join('')], { ...options, timeout: 300 }));
  const started = performance.now();
  const error = await createGitAdapter().inspectRepository(process.cwd()).catch((failure: unknown) => failure);
  expect(error).toMatchObject({ code: 'not_git_repository', cause: { signal: 'SIGKILL', killed: true } });
  expect(performance.now() - started).toBeLessThan(1_200);
  const pid = Number((error as { cause: { stdout: string } }).cause.stdout);
  expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
  expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
  // После отказа адаптер не продолжает цепочку команд.
  expect(execute).toHaveBeenCalledTimes(1);
});
