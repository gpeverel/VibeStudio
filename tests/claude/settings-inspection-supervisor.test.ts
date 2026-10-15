import type { ChildProcess, ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { INSPECTION_BUDGET as B, INSPECTION_PROTOCOL_FAILURES } from '../helpers/claude/settings-inspection.ts';
import { projectInspectionReport, superviseSettingsInspection } from '../helpers/claude/settings-inspection-supervisor.ts';
import type { SettingsInspectionReport } from '../helpers/claude/settings-inspection.ts';
import type { InspectionSupervisorBudget } from '../helpers/claude/settings-inspection-supervisor.ts';
import { inspectionEnvironment, spawnInspectionWorker, writeInspectionResult } from '../helpers/claude/settings-inspection-cli.ts';

/** Только synthetic doubles; не свидетельство совместимости настоящего CLI. */
function transportReport(): SettingsInspectionReport {
  return { cliCompatibility: 'unconfirmed', outcome: 'observed', stopAccepted: false, initialize: 'accepted',
    getSettings: 'accepted', sessionState: 'unknown', inventoryObserved: false, reasons: [], stdoutBytes: 10,
    stderrBytes: 0, elapsedMs: 10, stdin: 'finished', completion: { process: { state: 'exited', exitCode: 0, signal: null },
      stdout: 'ended', stderr: 'ended', signals: [], wait: 'settled', issues: [], descendants: 'not_guaranteed' } };
}
function processDouble(pid: number) {
  return Object.assign(new EventEmitter(), { pid, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    connected: true, kill: vi.fn<(name: string) => boolean>(() => true), unref: vi.fn(), disconnect: vi.fn(),
    send: vi.fn((_message: unknown, callback?: (error?: Error) => void) => { callback?.(); return true; }),
  });
}
function setup() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'hrtime'] });
  const cli = processDouble(12340), worker = processDouble(12341);
  const spawnCli = vi.fn(() => cli as unknown as ChildProcessWithoutNullStreams);
  const spawnWorker = vi.fn(() => worker as unknown as ChildProcess);
  const run = superviseSettingsInspection({ spawnCli, spawnWorker });
  return { cli, worker, spawnCli, spawnWorker, run, ready: () => worker.emit('message', { type: 'ready' }),
    accepted: () => worker.emit('message', { type: 'settings_accepted' }) };
}
// Реестр принадлежит hook, а не async-тесту: Vitest timeout не размораживает await run.done/finally.
const ownProcesses = new Set<ChildProcess>(), ownDirectories = new Set<string>();
function own<T extends ChildProcess>(child: T): T { ownProcesses.add(child); return child; }
async function releaseOwnProcesses() {
  const results = await Promise.all([...ownProcesses].map(child => new Promise<boolean>(resolveExit => {
    const confirmed = () => child.exitCode !== null || child.signalCode !== null;
    const done = (exited: boolean) => {
      clearTimeout(timer); child.removeListener('exit', onExit); child.removeListener('error', onError);
      // Только handles, созданные этим тестовым файлом. Результат teardown не меняет report стенда.
      child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
      if (child.connected) child.disconnect();
      child.unref(); ownProcesses.delete(child); resolveExit(exited);
    };
    const onExit = () => done(true), onError = () => { if (child.pid === undefined) done(true); };
    const timer = setTimeout(() => done(confirmed()), 1000);
    child.once('exit', onExit); child.on('error', onError);
    if (confirmed()) { done(true); return; }
    if (child.pid !== undefined) try { child.kill('SIGKILL'); } catch { /* Только exit подтверждает уборку. */ }
  })));
  if (results.some(exited => !exited)) throw new Error('Выход собственного Node-double не подтверждён за 1000 мс');
}
afterEach(async () => {
  vi.useRealTimers();
  await releaseOwnProcesses();
  for (const cwd of ownDirectories) rmSync(cwd, { recursive: true, force: true });
  ownDirectories.clear();
});

describe('Независимый supervisor: synthetic handles и IPC', () => {
  it.each(['response', 'work', 'outer', 'term', 'kill', 'drain'] as const)('увеличенный budget.%s отклоняется до любой фабрики', key => {
    const spawnCli = vi.fn(), spawnWorker = vi.fn();
    expect(() => superviseSettingsInspection({ spawnCli, spawnWorker,
      budget: { response: B.response, work: B.work, outer: B.outer, term: B.term, kill: B.kill, drain: B.drain,
        [key]: B[key] + 1 } })).toThrow('Некорректный бюджет');
    expect(spawnCli).not.toHaveBeenCalled(); expect(spawnWorker).not.toHaveBeenCalled();
  });
  it('наблюдает выход обоих handles, один spawn каждого; terminal неизменяем', async () => {
    const h = setup(); h.ready(); h.accepted();
    h.cli.emit('exit', 0, null);
    h.worker.emit('message', { type: 'report', report: transportReport() });
    h.worker.emit('exit', 0, null);
    const result = await h.run.done, snapshot = JSON.stringify(result);
    expect(result).toMatchObject({ transport: { outcome: 'observed' }, supervisor: {
      cli: { state: 'exited', exitCode: 0 }, worker: { state: 'exited', exitCode: 0 }, reasons: [], signals: [], deadline: false } });
    h.run.stop(); h.cli.emit('exit', 9, 'SIGABRT'); h.worker.emit('message', { type: 'failed', secret: 'SECRET' });
    expect(JSON.stringify(await h.run.done)).toBe(snapshot); expect(Object.isFrozen(result.supervisor)).toBe(true);
    expect(h.spawnCli).toHaveBeenCalledTimes(1); expect(h.spawnWorker).toHaveBeenCalledTimes(1);
    expect(h.spawnWorker).toHaveBeenCalledWith(h.cli); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['exit', 'disconnect', 'send-error'] as const)('ранний worker %s сохраняет неизвестный результат и останавливает только собственные handles', async event => {
    const h = setup();
    if (event === 'exit') h.worker.emit('exit', 7, null);
    else if (event === 'disconnect') h.worker.emit('disconnect');
    else { h.worker.send.mockImplementation((_message, callback) => { callback?.(new Error('SECRET-ipc')); return false; }); h.ready(); }
    await vi.advanceTimersByTimeAsync(B.term + B.kill + B.drain);
    const result = await h.run.done;
    expect(result.transport).toBeUndefined(); expect(result.supervisor.cli.state).toBe('unconfirmed');
    expect(result.supervisor.reasons).toContain(event === 'exit' ? 'worker_exited_without_report' : 'channel_lost');
    expect(h.cli.kill.mock.calls.map(call => call[0])).toEqual(['SIGTERM', 'SIGKILL']);
    expect(h.spawnCli).toHaveBeenCalledTimes(1); expect(h.spawnWorker).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('SECRET'); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['cli', 'worker'] as const)('исключение фабрики %s не объявляет неизвестный процесс not_started', async stage => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'hrtime'] });
    const cli = processDouble(12340);
    const spawnCli = vi.fn(() => { if (stage === 'cli') throw new Error('SECRET-spawn'); return cli as unknown as ChildProcessWithoutNullStreams; });
    const spawnWorker = vi.fn((): ChildProcess => { throw new Error('SECRET-handoff'); });
    const run = superviseSettingsInspection({ spawnCli, spawnWorker });
    await vi.advanceTimersByTimeAsync(B.term + B.kill + B.drain); const result = await run.done;
    expect(result.supervisor[stage].state).toBe('unconfirmed'); expect(result.supervisor.reasons).toContain(`${stage}_spawn_failed`);
    expect(spawnCli).toHaveBeenCalledTimes(1); expect(spawnWorker).toHaveBeenCalledTimes(stage === 'cli' ? 0 : 1);
    expect(JSON.stringify(result)).not.toContain('SECRET'); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['false', 'EPERM', 'ESRCH', 'SECRET-code'])('TERM/KILL %s остаются отдельными от exit', async code => {
    const h = setup();
    h.cli.kill.mockImplementation(() => { if (code === 'false') return false; throw Object.assign(new Error('SECRET-signal'), { code }); });
    h.run.stop(); await vi.advanceTimersByTimeAsync(B.term + B.kill + B.drain);
    const result = await h.run.done;
    expect(result.supervisor).toMatchObject({ stopAccepted: true, cli: { state: 'unconfirmed' }, worker: { state: 'unconfirmed' } });
    expect(result.supervisor.reasons).toEqual(expect.arrayContaining(['signal_failed', 'cli_exit_unconfirmed', 'worker_exit_unconfirmed']));
    expect(result.supervisor.signals.filter(item => item.process === 'cli').map(item => item.status))
      .toEqual([code === 'ESRCH' ? 'not_found' : 'failed', code === 'ESRCH' ? 'not_found' : 'failed']);
    expect(JSON.stringify(result)).not.toContain('SECRET'); expect(vi.getTimerCount()).toBe(0);
  });

  it('поздний ready не перезапускает response deadline', async () => {
    const h = setup(); await vi.advanceTimersByTimeAsync(B.response - 1); h.ready();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.cli.kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(B.term + B.kill + B.drain);
    const result = await h.run.done;
    expect(result.supervisor.elapsedMs).toBe(B.response + B.term + B.kill + B.drain);
    expect(result.supervisor.reasons).toContain('response_deadline'); expect(vi.getTimerCount()).toBe(0);
  });

  it('принятый settings не перезапускает work/outer; зависшие streams не продлевают 18 с', async () => {
    const h = setup(); h.ready(); await vi.advanceTimersByTimeAsync(B.response - 1); h.accepted();
    await vi.advanceTimersByTimeAsync(B.outer - B.response + 1); const result = await h.run.done;
    expect(result.supervisor.elapsedMs).toBe(B.outer); expect(result.supervisor.deadline).toBe(true);
    expect(result.supervisor.reasons).toEqual(expect.arrayContaining(['work_deadline', 'outer_deadline', 'report_missing']));
    expect(h.cli.kill.mock.calls.map(call => call[0])).toEqual(['SIGTERM', 'SIGKILL']);
    expect(h.cli.stdout.destroyed).toBe(true); expect(h.worker.stderr.destroyed).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });

  it('потеря передачи/уборки сохраняется безопасным кодом', async () => {
    const h = setup(); h.cli.stdout.destroy = () => { throw new Error('SECRET-cleanup'); };
    h.worker.emit('disconnect'); await vi.advanceTimersByTimeAsync(B.term + B.kill + B.drain);
    const result = await h.run.done;
    expect(result.supervisor.reasons).toContain('cleanup_failed'); expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it.each([{ type: 'ready', secret: 'SECRET' }, { type: 'report', report: { secret: 'SECRET' } },
    { type: 'signal_request', id: 1, signal: 'SIGKILL', pid: 99999 }])('неизвестный IPC не меняет владение и не попадает в результат', async message => {
    const h = setup(); h.ready(); h.worker.emit('message', message);
    await vi.advanceTimersByTimeAsync(B.term + B.kill + B.drain); const result = await h.run.done;
    expect(result.supervisor.reasons).toContain('ipc_invalid'); expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(h.spawnCli).toHaveBeenCalledTimes(1);
  });

  it('safe projection отбрасывает произвольные поля и исходный detail ошибки', () => {
    const raw = { ...transportReport(), secret: 'SECRET', completion: { ...transportReport().completion,
      issues: [{ code: 'stdin_failed', operation: 'stdin', detail: 'SECRET-message', stack: 'SECRET-stack' }] } };
    const result = projectInspectionReport(raw);
    expect(result?.completion.issues[0]?.code).toBe('stdin_failed'); expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(projectInspectionReport({ ...raw, reasons: ['SECRET-reason'] })).toBeUndefined();
  });

  it('protocolFailure принимает только закрытые checks при protocol_unknown; старый отчёт совместим', () => {
    expect(projectInspectionReport(transportReport())).toEqual(transportReport());
    for (const protocolFailure of INSPECTION_PROTOCOL_FAILURES) {
      const report = { ...transportReport(), outcome: 'failed', reasons: ['protocol_unknown'], protocolFailure };
      expect(projectInspectionReport(report)?.protocolFailure).toBe(protocolFailure);
    }
    expect(projectInspectionReport({ ...transportReport(), reasons: ['protocol_unknown'], protocolFailure: 'SECRET-check' })).toBeUndefined();
    expect(projectInspectionReport({ ...transportReport(), protocolFailure: 'json_invalid' })).toBeUndefined();
  });

  it('неизвестный protocolFailure из IPC приводит к ipc_invalid без утечки', async () => {
    const h = setup(); h.ready();
    h.worker.emit('message', { type: 'report', report: { ...transportReport(), reasons: ['protocol_unknown'], protocolFailure: 'SECRET-check' } });
    await vi.advanceTimersByTimeAsync(B.term + B.kill + B.drain);
    const report = await h.run.done;
    expect(report.supervisor.reasons).toContain('ipc_invalid'); expect(report.transport).toBeUndefined();
    expect(JSON.stringify(report)).not.toContain('SECRET');
  });
});

describe('Внешний надзор: собственные synthetic Node-процессы', () => {
  const budget: InspectionSupervisorBudget = { response: 1500, work: 2000, term: 200, kill: 200, drain: 400, outer: 2800 };
  async function exercise(workerSource: string, scenario = 'hang') {
    const spawnCli = vi.fn(() => {
      const child = own(spawn(process.execPath, ['tests/helpers/claude/settings-inspection-double.mjs', scenario], {
        stdio: ['pipe', 'pipe', 'pipe'], env: {},
      }));
      return child;
    });
    const spawnWorker = vi.fn(() => {
      return own(spawn(process.execPath, ['-e', workerSource], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: {} }));
    });
    const result = await superviseSettingsInspection({ spawnCli, spawnWorker, budget }).done;
    expect(spawnCli).toHaveBeenCalledTimes(1); expect(spawnWorker).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('SECRET');
    return result;
  }

  it('teardown подтверждает выход зависшего своего Node независимо от promise супервизора', async () => {
    const child = own(spawn(process.execPath, ['-e', 'for (;;) {}'], { stdio: 'ignore', env: {} }));
    const started = performance.now(); await releaseOwnProcesses();
    expect(child.signalCode).toBe('SIGKILL'); expect(ownProcesses.size).toBe(0);
    expect(performance.now() - started).toBeLessThan(1500);
  });

  it('import entrypoint в собственном Node не вызывает spawn и не пишет диагностику', async () => {
    const moduleUrl = new URL('../helpers/claude/settings-inspection-cli.ts', import.meta.url).href;
    const source = `import cp from 'node:child_process'; import { syncBuiltinESMExports } from 'node:module';
      cp.spawn = () => { process.exit(91); }; syncBuiltinESMExports(); await import(${JSON.stringify(moduleUrl)});`;
    const child = own(spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'], env: {} }));
    const output: string[] = [];
    child.stdout.on('data', chunk => output.push(String(chunk))); child.stderr.on('data', chunk => output.push(String(chunk)));
    const result = await new Promise(resolveExit => child.once('close', (code, signal) => resolveExit({ code, signal })));
    expect(result).toEqual({ code: 0, signal: null }); expect(output).toEqual([]);
  });

  it('останавливает зависший event loop worker независимо от его таймеров и IPC', async () => {
    const result = await exercise('for (;;) {}');
    expect(result.supervisor).toMatchObject({ cli: { state: 'exited', signal: 'SIGTERM' },
      worker: { state: 'exited', signal: 'SIGTERM' }, deadline: true });
    expect(result.supervisor.reasons).toEqual(expect.arrayContaining(['response_deadline', 'report_missing']));
    expect(result.supervisor.elapsedMs).toBeGreaterThanOrEqual(budget.response);
    // Допуск планировщика ОС проверяется отдельно от виртуальных точных 10/15/18 с выше.
    expect(result.supervisor.elapsedMs).toBeLessThan(budget.outer + 1000);
  });

  it('потеря реального IPC останавливает CLI и worker без ожидания response deadline', async () => {
    const result = await exercise('process.disconnect(); setInterval(() => {}, 1000)');
    expect(result.supervisor.reasons).toContain('channel_lost');
    expect(result.supervisor.cli.state).toBe('exited'); expect(result.supervisor.worker.state).toBe('exited');
    expect(result.supervisor.elapsedMs).toBeLessThan(budget.response);
  });

  it('SIGTERM-ignore своего Node-double требует SIGKILL и подтверждённого exit', async () => {
    const result = await exercise('process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)', 'ignore-term');
    expect(result.supervisor).toMatchObject({ cli: { state: 'exited', signal: 'SIGKILL' }, worker: { state: 'exited', signal: 'SIGKILL' } });
    expect(result.supervisor.signals.map(item => [item.process, item.signal, item.status])).toEqual([
      ['cli', 'SIGTERM', 'sent'], ['worker', 'SIGTERM', 'sent'], ['cli', 'SIGKILL', 'sent'], ['worker', 'SIGKILL', 'sent'],
    ]);
    expect(result.supervisor.elapsedMs).toBeGreaterThanOrEqual(budget.response + budget.term);
    expect(result.supervisor.elapsedMs).toBeLessThan(budget.outer + 1000);
  });

  it.each(['success', 'reject', 'early-exit', 'late-model', 'invalid-json', 'system-other'])('настоящий worker и унаследованные pipe handles: synthetic %s', async scenario => {
    const messages: unknown[] = [], diagnostics: string[] = [];
    const spawnCli = vi.fn(() => {
      const child = own(spawn(process.execPath, ['tests/helpers/claude/settings-inspection-double.mjs', scenario], {
        stdio: ['pipe', 'pipe', 'pipe'], env: {},
      }));
      return child;
    });
    const spawnWorker = vi.fn((cli: ChildProcessWithoutNullStreams) => {
      const worker = own(spawnInspectionWorker(cli, { cwd: process.cwd(), env: {} }));
      worker.on('message', message => messages.push(message));
      worker.stdout?.on('data', bytes => diagnostics.push(String(bytes)));
      worker.stderr?.on('data', bytes => diagnostics.push(String(bytes)));
      return worker;
    });
    const result = await superviseSettingsInspection({ spawnCli, spawnWorker, budget }).done;
    if (scenario === 'success') {
      expect(result.transport).toMatchObject({ outcome: 'observed', initialize: 'accepted', getSettings: 'accepted',
        settings: { executableKeysPresent: ['env'], policySettings: 'absent_unknown' }, stdin: 'finished' });
      expect(result.supervisor.reasons).toEqual([]);
    } else {
      expect(result.transport?.outcome).not.toBe('observed');
      if (scenario === 'reject') expect(result.transport?.reasons).toContain('request_rejected');
      else if (scenario === 'late-model') expect(result.transport?.reasons).toContain('unexpected_event');
      else if (scenario === 'invalid-json' || scenario === 'system-other') {
        expect(result.transport).toMatchObject({ initialize: 'pending', getSettings: 'not_sent', reasons: expect.arrayContaining(['protocol_unknown']),
          protocolFailure: scenario === 'invalid-json' ? 'json_invalid' : 'system_message_unsupported' });
        expect(messages).toContainEqual({ type: 'report', report: result.transport });
        expect(result.supervisor.reasons).toEqual([]);
      }
      else expect(result.supervisor.cli).toMatchObject({ state: 'exited', exitCode: 7 });
    }
    expect(result.supervisor.cli.state).toBe('exited'); expect(result.supervisor.worker.state).toBe('exited');
    expect(spawnCli).toHaveBeenCalledTimes(1); expect(spawnWorker).toHaveBeenCalledTimes(1);
    expect(JSON.stringify({ result, messages, diagnostics })).not.toContain('SECRET');
    expect(diagnostics).toEqual([]);
  });

  it('owned-cwd worker возвращает разрешённые metadata и удаляет только собственный synthetic cwd', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'vs-policy-double-'));
    ownDirectories.add(cwd);
    const result = await superviseSettingsInspection({ budget,
      artifactsBefore: { cwd: { state: 'unavailable' }, remote: { state: 'missing' } },
      spawnCli: () => {
        const child = own(spawn(process.execPath, [resolve('tests/helpers/claude/settings-inspection-double.mjs'), 'success'], {
          cwd, env: {}, stdio: ['pipe', 'pipe', 'pipe'],
        }));
        return child;
      },
      spawnWorker: cli => {
        return own(spawnInspectionWorker(cli, { cwd, env: { HOME: cwd }, ownedCwd: true }));
      },
    }).done;
    expect(result.transport?.outcome).toBe('observed'); expect(result.supervisor.reasons).toEqual([]);
    expect(result.artifacts).toMatchObject({ cwdBefore: { state: 'unavailable' }, remoteBefore: { state: 'missing' },
      cwdAfter: { state: 'present', kind: 'directory' }, remoteAfter: { state: 'missing' }, cleanup: 'removed' });
    expect(existsSync(cwd)).toBe(false); expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('окружение entrypoint сохраняет штатные пути и отклоняет env-token до spawn', () => {
    const source = { HOME: '/synthetic/home', CLAUDE_CONFIG_DIR: '/synthetic/config', PATH: '/synthetic/path',
      NODE_OPTIONS: 'SECRET-injection', UNLISTED: 'SECRET-other' };
    const result = inspectionEnvironment(source);
    expect(result).toMatchObject({ ok: true, env: { HOME: source.HOME, CLAUDE_CONFIG_DIR: source.CLAUDE_CONFIG_DIR, PATH: source.PATH,
      DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } });
    expect(JSON.stringify(result)).not.toContain('SECRET');
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) for (const value of ['', 'SECRET-token'])
      expect(inspectionEnvironment({ ...source, [key]: value })).toEqual({ ok: false, reason: 'env_token_present' });
    for (const value of ['', 'SECRET-kind']) expect(inspectionEnvironment({ ...source, CLAUDE_CODE_ENVIRONMENT_KIND: value }))
      .toEqual({ ok: false, reason: 'environment_kind_present' });
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_ENVIRONMENT_KIND']) {
      const environment = Object.defineProperty({ ...source }, key, { get() { throw new Error('SECRET-must-not-read'); } });
      expect(inspectionEnvironment(environment).ok).toBe(false);
    }
    expect(inspectionEnvironment({ HOME: 'relative' })).toEqual({ ok: false, reason: 'home_invalid' });
    expect(inspectionEnvironment({ HOME: '/synthetic', CLAUDE_CONFIG_DIR: 'relative' })).toEqual({ ok: false, reason: 'config_dir_invalid' });
  });
});

describe('Конечная выдача безопасного отчёта: synthetic output', () => {
  it('выдаёт JSONL и считает доставку только после callback', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'hrtime'] });
    let written = '', complete!: (error?: Error | null) => void;
    const output = new Writable({ write(chunk, _encoding, callback) { written += String(chunk); complete = callback; } });
    const done = writeInspectionResult(output, { cliCompatibility: 'unconfirmed' }, process.hrtime.bigint() + 1_000_000_000n);
    let settled = false; void done.then(() => { settled = true; }); await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false); complete();
    expect(await done).toBe(true); expect(written).toBe('{"cliCompatibility":"unconfirmed"}\n'); expect(vi.getTimerCount()).toBe(0);
  });

  it('зависший callback ограничен остатком исходного deadline; поздняя ошибка не меняет результат', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'hrtime'] });
    const deadline = process.hrtime.bigint() + 18_000_000_000n;
    await vi.advanceTimersByTimeAsync(17_999);
    let complete!: (error?: Error | null) => void;
    const output = new Writable({ write(_chunk, _encoding, callback) { complete = callback; } });
    const done = writeInspectionResult(output, { cliCompatibility: 'unconfirmed' }, deadline);
    await vi.advanceTimersByTimeAsync(1); expect(await done).toBe(false); expect(vi.getTimerCount()).toBe(0);
    complete(new Error('SECRET-late-output')); await vi.advanceTimersByTimeAsync(0);
    expect(await done).toBe(false);
  });

  it('истёкший deadline не создаёт новый период ожидания', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'hrtime'] });
    const output = new Writable({ write() {} });
    expect(await writeInspectionResult(output, {}, process.hrtime.bigint() - 1n)).toBe(false);
    expect(vi.getTimerCount()).toBe(0); output.destroy();
  });

  it('ошибка callback не становится подтверждённой выдачей и не выходит наружу', async () => {
    const output = new Writable({ write(_chunk, _encoding, callback) { callback(new Error('SECRET-output')); } });
    expect(await writeInspectionResult(output, {}, process.hrtime.bigint() + 1_000_000_000n)).toBe(false);
  });

  it.each([undefined, { oversized: 'x'.repeat(32768) }])('не сериализуемый или превышающий лимит результат не записывается', async value => {
    const write = vi.fn(); const output = new Writable({ write });
    expect(await writeInspectionResult(output, value, process.hrtime.bigint() + 1_000_000_000n)).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });
});
