// Самостоятельная немодельная диагностика. Собирает только соседний фиксированный исходник.
// Результат не заменяет npm run smoke; любой отказ сохраняет ненулевой exit.
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
let dir;
try {
  if (process.platform !== 'darwin' || process.argv.length !== 2) {
    throw new Error('Поддерживается только macOS, аргументы не принимаются.');
  }
  dir = await mkdtemp(join(tmpdir(), 'vibestudio-gui-probe-'));
  const executable = join(dir, 'probe');
  await run('/usr/bin/clang', [
    '-Wall', '-Wextra', '-Werror',
    fileURLToPath(new URL('./macos-gui-probe.c', import.meta.url)), '-o', executable,
  ], { timeout: 15_000, killSignal: 'SIGKILL', maxBuffer: 65_536 });
  try {
    const result = await run(executable, [], { timeout: 3_000, killSignal: 'SIGKILL', maxBuffer: 65_536 });
    process.stdout.write(result.stdout);
  } catch (error) {
    // execFile ждёт close дочернего процесса. Сохраняем JSON отрицательного результата.
    if (error.code === 1 && !error.signal && !error.killed && error.stdout) {
      process.stdout.write(error.stdout);
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
} catch (error) {
  process.stderr.write(`Диагностика GUI не завершена: ${error.message}\n`);
  process.exitCode = 2;
} finally {
  if (dir) await rm(dir, { recursive: true, force: true });
}
