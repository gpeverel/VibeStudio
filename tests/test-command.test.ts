import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const wrapper = fileURLToPath(new URL('../scripts/with-test-awake.sh', import.meta.url));
const execute = promisify(execFile);

describe('Npm-команды тестов выбирают закреплённый Node без профиля оболочки', () => {
  it.each(['test', 'test:node'] as const)('%s не наследует неподдерживаемый Node из PATH', async name => {
    const root = await mkdtemp(join(tmpdir(), 'vs-test-runtime-'));
    try {
      const requiredNode = readFileSync(new URL('../.nvmrc', import.meta.url), 'utf8').trim();
      const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
        scripts: Record<'test' | 'test:node', string>;
      };
      const wrongBin = join(root, 'unsupported-bin');
      const fixtureNvm = join(root, 'fixture-nvm');
      const selectedBin = join(fixtureNvm, 'versions', 'node', `v${requiredNode}`, 'bin');
      await Promise.all([wrongBin, selectedBin, join(root, 'scripts'), join(root, 'tests')]
        .map(path => mkdir(path, { recursive: true })));
      await Promise.all([
        copyFile(new URL('../scripts/with-node.sh', import.meta.url), join(root, 'scripts', 'with-node.sh')),
        copyFile(wrapper, join(root, 'scripts', 'with-test-awake.sh')),
        writeFile(join(root, '.nvmrc'), `${requiredNode}\n`),
        // Собственный двойник более нового Node: сообщает версию, но не может запустить runner.
        writeFile(join(wrongBin, 'node'), '#!/bin/sh\nif [ "$1" = --version ]; then printf "v26.11.0\\n"; exit 0; fi\nprintf "unsupported runtime executed\\n" >&2\nexit 91\n', { mode: 0o755 }),
        symlink(process.execPath, join(selectedBin, 'node')),
      ]);
      const report = 'console.log(JSON.stringify({runtime:process.versions.node,args:process.argv.slice(2)}));\n';
      await Promise.all([
        writeFile(join(wrongBin, 'vitest'), `#!/usr/bin/env node\n${report}`, { mode: 0o755 }),
        writeFile(join(root, 'tests', 'run-git-boundaries.node.ts'), report),
      ]);
      const args = name === 'test' ? ['аргумент с пробелом', '$(не-команда)'] : [];
      const result = await execute('sh', ['-c', `${scripts[name]} "$@"`, 'test-command', ...args], {
        cwd: root, env: { ...process.env, PATH: `${wrongBin}:${process.env.PATH ?? '/usr/bin:/bin'}`, NVM_DIR: fixtureNvm },
        timeout: 5_000, killSignal: 'SIGKILL',
      });
      expect(result.stdout).toContain(JSON.stringify({ runtime: requiredNode, args: name === 'test' ? ['run', ...args] : [] }));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

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
