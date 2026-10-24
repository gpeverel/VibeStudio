import { execFile } from 'node:child_process';
import { existsSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DIAGNOSTIC_STEPS, runCodexDiagnostics } from '../scripts/codex-diagnostics.ts';
import type { DiagnosticOptions, DiagnosticReport } from '../scripts/codex-diagnostics.ts';
import type { ProcessRequest, ProcessRunner } from '../src/core/ports/process-runner.ts';
import { createProcessRunner } from '../src/adapters/process-runner/index.ts';
import { CodexStand } from './helpers/codex/stand.ts';
import { cleanCompletion, processDouble, processResult } from './helpers/codex/process-double.ts';

// Весь набор synthetic. Установленный Codex, его auth и сеть не используются.
const HELP = 'Options:\n  --json\n  --sandbox <mode>\n  -c, --config <key=value>\n  --ignore-user-config\n  --ignore-rules\n  --model <model>\n  - Read stdin\n';
// Объявления флагов соответствуют наблюдению D4 2026-10-20; сам текст остаётся synthetic.
const RESUME_HELP = HELP.replace('  --sandbox <mode>\n', '');
const OUTPUTS = ['codex-cli 0.163.0\n', 'Commands:\n  exec Run\n  login Login\n', HELP, RESUME_HELP, 'Commands:\n  status Status\n', ''];
const stands: CodexStand[] = [];
const retained: string[] = [];
const doubles: ReturnType<typeof processDouble>[] = [];
function stand() { const s = new CodexStand(); stands.push(s); return s; }
function controlled() { const d = processDouble(); doubles.push(d); return d; }
function complete(d: ReturnType<typeof processDouble>) {
  d.stdout.end(OUTPUTS[0]); d.stderr.end(); d.result.resolve(processResult());
}
afterEach(() => {
  for (const d of doubles.splice(0)) complete(d);
  for (const dir of retained.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const s of stands.splice(0)) s.cleanup();
});
function options(s: CodexStand, runner: ProcessRunner = createProcessRunner()): DiagnosticOptions {
  const executable = s.fake({ probes: { resumeHelp: { stdout: RESUME_HELP } } });
  return {
    runner, executable, identityFiles: [{ role: 'wrapper', path: executable }], provenance: 'synthetic',
    env: { HOME: s.dir, PATH: '/usr/bin:/bin', CODEX_API_KEY: 'SECRET-key', NODE_OPTIONS: '--require SECRET', EXTRA: 'SECRET-value' },
  };
}
function immediate(index: number, stdout = OUTPUTS[index]!, stderr = index === 5 ? 'SECRET auth output' : '', code = 0) {
  return {
    stdout: (async function* () { yield Buffer.from(stdout); })(),
    stderr: (async function* () { yield Buffer.from(stderr); })(),
    done: Promise.resolve(processResult(cleanCompletion({ process: { state: 'exited', exitCode: code, signal: null } }))),
    interrupt: vi.fn(async () => {}), kill: vi.fn(async () => {}),
  };
}
function syntheticRunner(override?: (index: number, request: ProcessRequest) => ReturnType<typeof immediate>) {
  let index = 0;
  return { start: vi.fn((request: ProcessRequest) => {
    const current = index++;
    return override?.(current, request) ?? immediate(current);
  }) };
}
function remember(report: DiagnosticReport) {
  if (report.workspace && report.cleanup !== 'removed') retained.push(report.workspace);
  return report;
}

describe('Самостоятельный диагностический сценарий P3-D', () => {
  it('проходит шесть немодельных команд через настоящий ProcessRunner и synthetic executable', async () => {
    const s = stand();
    const report = remember(await runCodexDiagnostics(options(s)));
    expect(report).toMatchObject({ status: 'passed', provenance: 'synthetic', attempts: 6, modelCalls: 0, cleanup: 'removed' });
    expect(report.probes.map(p => p.status)).toEqual(Array(6).fill('passed'));
    expect(report.probes[0]?.version).toBe('0.163.0');
    expect(report.probes[3]?.flags).not.toContain('--sandbox');
    expect(report.probes[3]?.flags).toContain('--config');
    expect(report.probes[5]?.auth).toBe('authenticated');
    expect(report.identity[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(existsSync(report.workspace!)).toBe(false);
    const records = s.records();
    expect(records.map(r => r.argv)).toEqual(DIAGNOSTIC_STEPS.map(step => [...step.args]));
    expect(records.every(r => r.probe !== 'run' && r.cwd === report.workspace)).toBe(true);
    expect(records[0]?.env).toMatchObject({ HOME: s.dir, PATH: '/usr/bin:/bin', CODEX_API_KEY: 'SECRET-key' });
    expect(records[0]?.env).not.toHaveProperty('NODE_OPTIONS');
    expect(records[0]?.env).not.toHaveProperty('EXTRA');
    expect(JSON.stringify(report)).not.toContain('SECRET');
  });

  it.each(['--json', '--config', '--ignore-user-config', '--ignore-rules', 'stdin'])('D4 без %s останавливает набор до auth', async missing => {
    const help = RESUME_HELP.split('\n').filter(line => !line.includes(missing)).join('\n');
    const runner = syntheticRunner(i => immediate(i, i === 3 ? help : OUTPUTS[i]!));
    const report = remember(await runCodexDiagnostics(options(stand(), runner)));
    expect(report).toMatchObject({ status: 'failed', reason: 'interface_unsupported', attempts: 4, cleanup: 'removed' });
    expect(report.probes.slice(4).every(p => p.status === 'not_run')).toBe(true);
    expect(runner.start).toHaveBeenCalledTimes(4);
  });

  it('D3 без --sandbox не принимает один --config за поддержку первого хода', async () => {
    const runner = syntheticRunner(i => immediate(i, i === 2 ? RESUME_HELP : OUTPUTS[i]!));
    const report = remember(await runCodexDiagnostics(options(stand(), runner)));
    expect(report).toMatchObject({ status: 'failed', reason: 'interface_unsupported', attempts: 3, cleanup: 'removed' });
    expect(report.probes.slice(3).every(p => p.status === 'not_run')).toBe(true);
    expect(runner.start).toHaveBeenCalledTimes(3);
  });

  it.each([0, 1, 2, 3, 4])('не продолжает после несовместимого интерфейса D%i', async index => {
    const runner = syntheticRunner(i => immediate(i, i === index ? 'SECRET incompatible' : OUTPUTS[i]!));
    const report = remember(await runCodexDiagnostics(options(stand(), runner)));
    expect(report).toMatchObject({ status: 'failed', reason: 'interface_unsupported', attempts: index + 1, cleanup: 'removed' });
    expect(runner.start).toHaveBeenCalledTimes(index + 1);
    expect(report.probes.slice(index + 1).every(p => p.status === 'not_run')).toBe(true);
    expect(JSON.stringify(report)).not.toContain('SECRET');
  });

  it.each([
    [1, 'Not logged in\n', 'not_authenticated', 'unauthenticated'],
    [1, 'SECRET unknown auth\n', 'process_failed', 'unknown'],
  ])('различает отсутствие входа и неизвестный отказ авторизации: %s/%s', async (code, stderr, reason, auth) => {
    const runner = syntheticRunner(i => immediate(i, OUTPUTS[i]!, i === 5 ? String(stderr) : '', i === 5 ? Number(code) : 0));
    const report = remember(await runCodexDiagnostics(options(stand(), runner)));
    expect(report).toMatchObject({ status: 'failed', reason, attempts: 6 });
    expect(report.probes[5]?.auth).toBe(auth);
    expect(JSON.stringify(report)).not.toContain('SECRET');
  });

  it('отклоняет отсутствующий executable до spawn', async () => {
    const runner = syntheticRunner();
    const input = options(stand(), runner);
    rmSync(input.executable);
    const report = await runCodexDiagnostics(input);
    expect(report).toMatchObject({ status: 'failed', reason: 'preflight_failed', attempts: 0, cleanup: 'not_created' });
    expect(runner.start).not.toHaveBeenCalled();
  });

  it('не подменяет node-shim окружением с другим Node', async () => {
    const runner = syntheticRunner();
    const input = options(stand(), runner);
    input.identityFiles = [...input.identityFiles, { role: 'node', path: input.executable }];
    input.env = { HOME: '/synthetic', PATH: '/nonexistent-synthetic-bin' };
    const report = await runCodexDiagnostics(input);
    expect(report).toMatchObject({ status: 'failed', reason: 'preflight_failed', attempts: 0 });
    expect(runner.start).not.toHaveBeenCalled();
  });

  it.each(['', '.', '../candidate-bin'])('не игнорирует неоднозначный компонент PATH %j перед проверенным Node', async component => {
    const runner = syntheticRunner();
    const input = options(stand(), runner);
    input.identityFiles = [...input.identityFiles, { role: 'node', path: process.execPath }];
    input.env = { ...input.env, PATH: `${component}:${dirname(process.execPath)}` };
    const report = remember(await runCodexDiagnostics(input));
    expect(report).toMatchObject({ status: 'failed', reason: 'preflight_failed', attempts: 0, cleanup: 'not_created' });
    expect(runner.start).not.toHaveBeenCalled();
  });

  it('сохраняет абсолютный PATH с проверенным Node без подмены окружения', async () => {
    const runner = syntheticRunner();
    const input = options(stand(), runner);
    input.identityFiles = [...input.identityFiles, { role: 'node', path: process.execPath }];
    const path = `${dirname(process.execPath)}:/usr/bin:/bin`;
    input.env = { ...input.env, PATH: path };
    const report = remember(await runCodexDiagnostics(input));
    expect(report).toMatchObject({ status: 'passed', attempts: 6, cleanup: 'removed' });
    expect(runner.start.mock.calls.every(([request]) => request.env.PATH === path)).toBe(true);
  });

  it('throw start сохраняет неудачную попытку и не выдумывает отсутствие процесса', async () => {
    const runner = { start: vi.fn(() => { throw Object.assign(new Error('SECRET spawn'), { code: 'EACCES' }); }) };
    const report = remember(await runCodexDiagnostics(options(stand(), runner)));
    expect(report).toMatchObject({ status: 'failed', reason: 'process_failed', attempts: 1, cleanup: 'retained' });
    expect(report.probes[0]).toMatchObject({ status: 'failed', completion: { process: { state: 'unconfirmed' } } });
    expect(report.probes[0]?.completion?.issues).toContainEqual(expect.objectContaining({ code: 'spawn_failed', errorCode: 'EACCES' }));
    expect(JSON.stringify(report)).not.toContain('SECRET');
  });

  it('прерывает набор при изменении executable между probes', async () => {
    const runner = syntheticRunner();
    const input = options(stand(), runner);
    input.onProgress = async report => {
      if (report.attempts === 1) writeFileSync(input.executable, '#!/bin/sh\n# changed synthetic identity\n');
    };
    const report = remember(await runCodexDiagnostics(input));
    expect(report).toMatchObject({ status: 'failed', reason: 'identity_changed', attempts: 1, cleanup: 'removed' });
    expect(runner.start).toHaveBeenCalledTimes(1);
  });

  it('ошибка записи evidence запрещает следующую диагностику', async () => {
    const runner = syntheticRunner();
    const report = remember(await runCodexDiagnostics({
      ...options(stand(), runner), onProgress: async r => { if (r.attempts) throw new Error('SECRET disk error'); },
    }));
    expect(report).toMatchObject({ status: 'failed', reason: 'evidence_failed', attempts: 1, cleanup: 'removed' });
    expect(runner.start).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(report)).not.toContain('SECRET');
  });

  it('Stop до запуска не создаёт процесс или рабочий каталог', async () => {
    const runner = syntheticRunner();
    const controller = new AbortController(); controller.abort();
    const report = await runCodexDiagnostics({ ...options(stand(), runner), signal: controller.signal });
    expect(report).toMatchObject({ status: 'interrupted', reason: 'interrupted', attempts: 0, workspace: null });
    expect(runner.start).not.toHaveBeenCalled();
  });

  it('Stop активного probe сохраняет поздний EPERM после done и запрещает последующие команды', async () => {
    const s = stand(); const d = controlled(); const controller = new AbortController();
    d.interrupt.mockImplementation(() => {
      complete(d);
      return new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('SECRET late stop'), { code: 'EPERM' })), 10));
    });
    const runner = { start: vi.fn(() => { controller.abort(); return d.run; }) };
    const report = remember(await runCodexDiagnostics({ ...options(s, runner), signal: controller.signal }));
    expect(report).toMatchObject({ status: 'interrupted', attempts: 1, cleanup: 'removed' });
    expect(report.probes[0]?.completion?.issues).toContainEqual(expect.objectContaining({ code: 'signal_failed', operation: 'interrupt', errorCode: 'EPERM' }));
    expect(runner.start).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(report)).not.toContain('SECRET');
  });

  it.each(['stdout', 'stderr'] as const)('ограничивает %s отдельно, вызывает kill и не запускает следующую команду', async stream => {
    const d = controlled();
    d.kill.mockImplementation(async () => complete(d));
    const runner = { start: vi.fn(() => {
      d[stream].write('SECRET'.repeat(12_000));
      return d.run;
    }) };
    const report = remember(await runCodexDiagnostics(options(stand(), runner)));
    expect(report).toMatchObject({ status: 'failed', reason: 'output_limit', attempts: 1 });
    expect(d.kill).toHaveBeenCalledTimes(1);
    expect(report.probes[0]?.completion?.issues).toContainEqual(expect.objectContaining({ code: 'output_limit', operation: stream }));
    expect(JSON.stringify(report)).not.toContain('SECRET');
  });

  it('ошибка потока и поздний отказ внутреннего kill сохраняются вместе', async () => {
    const d = controlled();
    d.kill.mockImplementation(() => {
      complete(d);
      return new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('SECRET kill'), { code: 'EPERM' })), 10));
    });
    const runner = { start: vi.fn(() => {
      queueMicrotask(() => d.stdout.destroy(Object.assign(new Error('SECRET stream'), { code: 'EIO' })));
      return d.run;
    }) };
    const report = remember(await runCodexDiagnostics(options(stand(), runner)));
    expect(report).toMatchObject({ status: 'failed', reason: 'stream_failed', attempts: 1, cleanup: 'retained' });
    expect(report.probes[0]?.completion?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'stream_failed', operation: 'stdout', errorCode: 'EIO' }),
      expect.objectContaining({ code: 'signal_failed', operation: 'kill', errorCode: 'EPERM' }),
    ]));
    expect(JSON.stringify(report)).not.toContain('SECRET');
  });

  it('deadline конечен; неподтверждённый процесс сохраняет каталог и неизменный evidence', async () => {
    const d = controlled();
    const runner = { start: vi.fn(() => d.run) };
    const report = remember(await runCodexDiagnostics({ ...options(stand(), runner),
      budget: { processMs: 15, graceMs: 5, drainMs: 5, cleanupMs: 15 },
    }));
    expect(report).toMatchObject({ status: 'failed', reason: 'timeout', attempts: 1, cleanup: 'retained' });
    expect(report.probes[0]?.completion?.process.state).toBe('unconfirmed');
    expect(d.kill).toHaveBeenCalledTimes(1);
    const before = JSON.stringify(report);
    complete(d);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(JSON.stringify(report)).toBe(before);
    expect(runner.start).toHaveBeenCalledTimes(1);
  });

  it('зависший результат Stop не отменяет уже подтверждённый exit', async () => {
    const d = controlled(); const controller = new AbortController();
    d.interrupt.mockImplementation(() => { complete(d); return new Promise(() => {}); });
    const runner = { start: vi.fn(() => { controller.abort(); return d.run; }) };
    const report = remember(await runCodexDiagnostics({
      ...options(stand(), runner), signal: controller.signal,
      budget: { processMs: 15, graceMs: 5, drainMs: 5, cleanupMs: 15 },
    }));
    const completion = report.probes[0]?.completion;
    expect(report.status).toBe('interrupted');
    expect(completion?.process.state).toBe('exited');
    expect(completion?.issues).toContainEqual(expect.objectContaining({ code: 'timeout', operation: 'interrupt' }));
    expect(completion?.issues.some(issue => issue.code === 'exit_unconfirmed')).toBe(false);
    expect(d.kill).toHaveBeenCalledTimes(1);
  });

  it('после deadline ждёт новый kill и сохраняет его поздний EPERM', async () => {
    const d = controlled(); const controller = new AbortController();
    let releaseInterrupt: () => void = () => {};
    let killSettled = false;
    const interrupted = new Promise<void>(resolve => { releaseInterrupt = resolve; });
    d.interrupt.mockImplementation(() => { complete(d); return interrupted; });
    d.kill.mockImplementation(() => {
      releaseInterrupt();
      return new Promise((_, reject) => setTimeout(() => {
        killSettled = true;
        reject(Object.assign(new Error('SECRET late kill'), { code: 'EPERM' }));
      }, 10));
    });
    const runner = { start: vi.fn(() => { controller.abort(); return d.run; }) };
    const report = remember(await runCodexDiagnostics({
      ...options(stand(), runner), signal: controller.signal,
      budget: { processMs: 15, graceMs: 5, drainMs: 5, cleanupMs: 100 },
    }));
    expect(killSettled).toBe(true);
    expect(report).toMatchObject({ status: 'interrupted', attempts: 1 });
    expect(report.probes[0]?.completion?.issues).toContainEqual(expect.objectContaining({
      code: 'signal_failed', operation: 'kill', errorCode: 'EPERM',
    }));
    expect(d.kill).toHaveBeenCalledTimes(1);
    expect(runner.start).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(report)).not.toContain('SECRET');
  });

  it('result с unconfirmed exit не принимается за успешную диагностику', async () => {
    const runner = { start: vi.fn(() => ({
      ...immediate(0), done: Promise.resolve(processResult(cleanCompletion({ process: { state: 'unconfirmed' } }))),
    })) };
    const report = remember(await runCodexDiagnostics(options(stand(), runner)));
    expect(report).toMatchObject({ status: 'failed', reason: 'process_failed', attempts: 1, cleanup: 'retained' });
  });

  it('без явного флага CLI-команда печатает инструкцию и выходит до чтения установленной CLI', async () => {
    // Среда передачи может запускать Vitest другим Node; CLI-стенд использует версию проекта.
    await expect(promisify(execFile)('/bin/sh', [
      resolve('scripts/with-node.sh'), 'node', '--experimental-transform-types', resolve('scripts/codex-diagnostics.ts'),
    ], { timeout: 3_000 }))
      .rejects.toMatchObject({ code: 2, stdout: '', stderr: expect.stringContaining('Только после согласования сценария D') });
  });
});
