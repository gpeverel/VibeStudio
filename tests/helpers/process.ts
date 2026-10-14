import { execFileSync } from 'node:child_process';

interface TestProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** Только собственные процессы стендов. Таймер Vitest не прерывает execFileSync.
 * SIGKILL нужен явно: при игнорировании SIGTERM sync-вызов ждёт даже после timeout.
 * stdout/stderr остаются в результате/ошибке, не наследуют канал отчёта тестов.
 */
export function runTestProcess(executable: string, args: readonly string[], options: TestProcessOptions = {}): string {
  const { timeoutMs = 5_000, ...context } = options;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 5_000) {
    throw new RangeError('Deadline процесса стенда должен быть от 1 до 5000 мс');
  }
  return execFileSync(executable, args, {
    ...context, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, killSignal: 'SIGKILL',
  });
}

export function isTestProcessTimeout(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
}
