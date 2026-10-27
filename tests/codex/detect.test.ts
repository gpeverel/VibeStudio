import { chmodSync, copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { detectCodex } from '../../src/adapters/codex/detect.ts';
import { createProcessRunner } from '../../src/adapters/process-runner/index.ts';
import { CodexStand } from '../helpers/codex/stand.ts';
import type { FakeScenario } from '../helpers/codex/stand.ts';

const stands: CodexStand[] = [];
function stand() { const s = new CodexStand(); stands.push(s); return s; }
afterEach(() => { while (stands.length) stands.pop()?.cleanup(); });
const runner = createProcessRunner();
const environment = (s: CodexStand) => ({ HOME: s.dir, PATH: '/usr/bin:/bin' });
async function detection(scenario: FakeScenario = {}) {
  const s = stand();
  const binaryPath = s.fake(scenario);
  return { s, binaryPath, result: await detectCodex(runner, { binaryPath, env: environment(s) }) };
}
const reasons = (value: Awaited<ReturnType<typeof detectCodex>>) => value.unavailable.map(item => item.reason);

describe('Codex detect: синтетический executable, interface и штатный login status', () => {
  it('missing executable не превращается в auth error и не запускает установку', async () => {
    const s = stand();
    const result = await detectCodex(runner, { binaryPath: s.path('missing'), env: environment(s) });
    expect(result.status).toBe('unavailable');
    expect(result.binaryPath).toBeNull();
    expect(reasons(result)).toContain('binary_missing');
    expect(reasons(result)).not.toContain('not_authenticated');
    expect(s.records()).toEqual([]);
  });

  it.each(['codex', './codex'])('относительный explicit path %s запрещён', async binaryPath => {
    const s = stand();
    const result = await detectCodex(runner, { binaryPath, env: environment(s) });
    expect(result.status).toBe('unavailable');
    expect(reasons(result)).toContain('binary_missing');
    expect(s.records()).toEqual([]);
  });

  it('directory и файл без execute bit не принимаются за CLI', async () => {
    const s = stand();
    mkdirSync(s.path('directory'));
    writeFileSync(s.path('not-executable'), '#!/bin/sh\nexit 0\n');
    chmodSync(s.path('not-executable'), 0o600);
    for (const name of ['directory', 'not-executable']) {
      const result = await detectCodex(runner, { binaryPath: s.path(name), env: environment(s) });
      expect(reasons(result)).toContain('binary_missing');
    }
  });

  it('явный ошибочный путь не заменяется другой CLI из PATH', async () => {
    const s = stand();
    copyFileSync(s.fake(), s.path('codex'));
    chmodSync(s.path('codex'), 0o755);
    const result = await detectCodex(runner, { binaryPath: s.path('missing'), env: { ...environment(s), PATH: s.dir } });
    expect(result.status).toBe('unavailable');
    expect(s.records()).toEqual([]);
  });

  it('PATH запроса достаточен без окружения Electron/Finder', async () => {
    const s = stand();
    copyFileSync(s.fake(), s.path('codex'));
    chmodSync(s.path('codex'), 0o755);
    const result = await detectCodex(runner, { env: { ...environment(s), PATH: s.dir } });
    expect(result.binaryPath).toBe(realpathSync(s.path('codex')));
    expect(result.version).toBe('0.163.0');
    expect(result.status).toBe('available');
  });

  it('доступность interface/auth не является разрешением выбранного профиля', async () => {
    const { s, result, binaryPath } = await detection();
    expect(result).toMatchObject({ status: 'available', binaryPath, version: '0.163.0', auth: 'authenticated' });
    expect(s.records().some(record => record.probe === 'auth' && record.argv.join(' ') === 'login status')).toBe(true);
    expect(s.records().some(record => record.probe === 'run')).toBe(false);
    expect(result.capabilities).not.toHaveProperty('restricted');
    expect(result.capabilities).not.toHaveProperty('strictMcpConfig');
    expect(result.capabilities).not.toHaveProperty('readOnly', 'verified');
  });

  it('unauthenticated отличается от binary_missing', async () => {
    const { result } = await detection({ probes: { auth: { stderr: 'Not logged in\n', exit: 1 } } });
    expect(result.status).toBe('unavailable');
    expect(result.auth).toBe('unauthenticated');
    expect(reasons(result)).toContain('not_authenticated');
    expect(reasons(result)).not.toContain('binary_missing');
  });

  it('сбой диагностики auth не выдаётся за authenticated', async () => {
    const { result } = await detection({ probes: { auth: { stderr: 'SECRET-AUTH-DIAGNOSTIC', exit: 2 } } });
    expect(result.status).toBe('unavailable');
    expect(result.auth).not.toBe('authenticated');
    expect(JSON.stringify(result)).not.toContain('SECRET-AUTH-DIAGNOSTIC');
  });

  it.each(['version', 'execHelp'] as const)('ошибка %s не даёт available', async probe => {
    const { result } = await detection({ probes: { [probe]: { stdout: 'SECRET-PROBE-DUMP', exit: 2 } } });
    expect(result.status).toBe('unavailable');
    expect(JSON.stringify(result)).not.toContain('SECRET-PROBE-DUMP');
  });

  it('ошибка отдельной resume-диагностики отключает resume, не подменяет auth', async () => {
    const { result } = await detection({ probes: { resumeHelp: { stderr: 'synthetic failure', exit: 2 } } });
    expect(result.capabilities.resume).toBe(false);
    expect(result.auth).toBe('authenticated');
  });

  it('полный resume help с короткими clap-алиасами подтверждает resume', async () => {
    const help = (name: string) => readFileSync(new URL(`../fixtures/codex/synthetic-${name}-help.txt`, import.meta.url), 'utf8');
    expect(help('resume')).not.toContain('--sandbox');
    const { result, s } = await detection({ probes: { execHelp: { stdout: help('exec') }, resumeHelp: { stdout: help('resume') } } });
    expect(result).toMatchObject({ status: 'available', auth: 'authenticated',
      capabilities: { resume: true, configOverrides: true, sandbox: true, model: true } });
    expect(s.records().map(record => record.probe)).toEqual(['version', 'execHelp', 'resumeHelp', 'auth']);
  });

  it.each(['exec', 'resume'] as const)('strict-config для %s не наследуется из help другого маршрута', async missing => {
    const help = (name: string) => readFileSync(new URL(`../fixtures/codex/synthetic-${name}-help.txt`, import.meta.url), 'utf8')
      .split('\n').filter(line => name !== missing || !line.includes('--strict-config')).join('\n');
    const { result, s } = await detection({
      probes: { execHelp: { stdout: help('exec') }, resumeHelp: { stdout: help('resume') } },
    });
    expect(result.capabilities.strictConfig).toBe(missing !== 'exec');
    expect(result.capabilities.resumeStrictConfig).toBe(missing !== 'resume');
    // Старый профиль продолжает иметь свой интерфейс; новый допуск проверяет strict отдельно.
    expect(result.status).toBe('available');
    expect(s.records().map(record => record.probe)).toEqual(['version', 'execHelp', 'resumeHelp', 'auth']);
  });

  it('упоминание strict-config в prose не заменяет объявление опции', async () => {
    const help = readFileSync(new URL('../fixtures/codex/synthetic-exec-help.txt', import.meta.url), 'utf8')
      .replace('      --strict-config', '      --other  see --strict-config');
    const { result } = await detection({ probes: { execHelp: { stdout: help } } });
    expect(result.capabilities.strictConfig).toBe(false);
  });

  it.each(['--json', '--config', '--ignore-user-config', '--ignore-rules', 'stdin'])('resume без %s не подтверждает собственную политику и ввод', async missing => {
    const help = readFileSync(new URL('../fixtures/codex/synthetic-resume-help.txt', import.meta.url), 'utf8')
      .split('\n').filter(line => !line.includes(missing)).join('\n');
    const { result } = await detection({ probes: { resumeHelp: { stdout: help } } });
    expect(result.capabilities.resume).toBe(false);
    expect(result.auth).toBe('authenticated');
  });

  it('first turn всё ещё требует --sandbox, даже если --config объявлен', async () => {
    const help = readFileSync(new URL('../fixtures/codex/synthetic-exec-help.txt', import.meta.url), 'utf8')
      .split('\n').filter(line => !line.includes('--sandbox')).join('\n');
    const { result } = await detection({ probes: { execHelp: { stdout: help } } });
    expect(result.status).toBe('unavailable');
    expect(result.capabilities).toMatchObject({ sandbox: false, configOverrides: true });
    expect(reasons(result)).toContain('capability_missing');
  });

  it('произвольный вывод version не считается совместимой версией', async () => {
    const { result } = await detection({ probes: { version: { stdout: 'other tool 1.2.3\n' } } });
    expect(result.status).toBe('unavailable');
    expect(result.version).toBeNull();
  });

  it('упоминание --json в описании другого флага не объявляет поддержку', async () => {
    const help = 'Usage: codex exec [OPTIONS]\n  resume\n  --other  see --json for another tool\n  --sandbox <MODE>\n  --config <KEY>\n  --ignore-user-config\n  --ignore-rules\n  - read stdin\n';
    const { result } = await detection({ probes: { execHelp: { stdout: help } } });
    expect(result.status).toBe('unavailable');
    expect(result.capabilities.execJson).toBe(false);
    expect(reasons(result)).toContain('capability_missing');
  });

  it('diagnostic env исключает секреты приложения и произвольные настройки запуска', async () => {
    const s = stand();
    await detectCodex(runner, { binaryPath: s.fake(), env: {
      ...environment(s), APP_SECRET: 'synthetic-secret', NODE_OPTIONS: '--trace-warnings', OPENAI_BASE_URL: 'https://example.invalid',
    } });
    expect(s.records().length).toBeGreaterThan(0);
    for (const record of s.records()) {
      expect(record.env.HOME).toBe(s.dir);
      expect(record.env).not.toHaveProperty('APP_SECRET');
      expect(record.env).not.toHaveProperty('NODE_OPTIONS');
      expect(record.env).not.toHaveProperty('OPENAI_BASE_URL');
    }
  });
});
