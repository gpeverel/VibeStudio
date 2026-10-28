import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const wrapper = fileURLToPath(new URL('../scripts/with-test-awake.sh', import.meta.url));
const execute = promisify(execFile);

describe('Команда тестов с временной защитой от автоматического сна', () => {
  it('сохраняет аргументы буквально и возвращает ненулевой код дочерней команды', async () => {
    const args = ['аргумент с пробелом', '$(не-команда)', '"кавычки"'];
    await expect(execute('sh', [wrapper, process.execPath, '-e',
      'process.stdout.write(JSON.stringify(process.argv.slice(1)));process.exitCode=7', '--', ...args],
    { timeout: 5_000, killSignal: 'SIGKILL' })).rejects.toMatchObject({
      code: 7, stdout: JSON.stringify(args), stderr: '',
    });
  });

  it('без команды отказывает сразу', async () => {
    await expect(execute('sh', [wrapper], { timeout: 5_000, killSignal: 'SIGKILL' })).rejects.toMatchObject({
      code: 1, stdout: '', stderr: expect.stringContaining('Использование:'),
    });
  });

  it('сохраняет PID команды и передаёт SIGTERM без зависшего посредника', async () => {
    // Свой Node, не CLI/модель. Даже при регрессии сам завершится через 5 секунд.
    const child = spawn('sh', [wrapper, process.execPath, '-e',
      'process.stdout.write(String(process.pid));setTimeout(()=>{},5000)'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = once(child, 'close');
    try {
      const [output] = await once(child.stdout, 'data', { signal: AbortSignal.timeout(5_000) });
      expect(Number(String(output))).toBe(child.pid);
      expect(child.kill('SIGTERM')).toBe(true);
      expect(await closed).toEqual([null, 'SIGTERM']);
    } finally {
      child.kill('SIGKILL');
      await closed;
    }
  });
});
