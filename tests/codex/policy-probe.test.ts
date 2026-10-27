import { execFile } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProcessRunner } from '../../src/adapters/process-runner/index.ts';
import type { ProcessRequest, ProcessRun } from '../../src/core/ports/process-runner.ts';
import { baselinePassed, buildR2Requests, parseProbeOutput, R2_BUDGET, runPolicyProbe,
  sandboxPassed } from '../helpers/codex/policy-probe.ts';
import type { ProbeOutput, ProbeReport } from '../helpers/codex/policy-probe.ts';
import { cleanCompletion, deferred, processResult } from '../helpers/codex/process-double.ts';

const allow = { attempted: true, state: 'allowed', code: 'NONE', matched: true } as const;
const deny = { attempted: true, state: 'denied', code: 'EPERM', matched: false } as const;
const baseline: ProbeOutput = { schemaVersion: 1, control: allow, outside: allow, symlink: allow, writeInside: allow, writeOutside: allow };
const sandbox: ProbeOutput = { schemaVersion: 1, control: allow, outside: deny, symlink: deny, writeInside: deny, writeOutside: deny };
const SECRET = 'SYNTHETIC-SECRET-NOT-FOR-EVIDENCE';
async function* bytes(text = '') { if (text) yield Buffer.from(text); }
function stub(text = '', patch: Partial<ProcessRun> = {}): ProcessRun {
  return { stdout: bytes(text), stderr: bytes(), done: Promise.resolve(processResult()),
    interrupt: vi.fn(async () => {}), kill: vi.fn(async () => {}), ...patch };
}
const roots = new Set<string>();
afterEach(() => {
  // Только каталоги собственных doubles; живой cleanup этим не подменяется.
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});
function setup(override?: (request: ProcessRequest, index: number, normal: ProcessRun) => ProcessRun) {
  const requests: ProcessRequest[] = [];
  const start = vi.fn((request: ProcessRequest) => {
    const index = requests.length; requests.push(request); roots.add(dirname(request.cwd));
    let text = '';
    if (index === 0) writeFileSync(join(request.cwd, 'fs-probe'), 'synthetic-binary', { mode: 0o700 });
    if (index === 1) {
      writeFileSync(join(request.cwd, 'NEW.txt'), 'x');
      writeFileSync(join(request.cwd, '../outside/WRITE-TARGET'), 'x');
      text = JSON.stringify(baseline);
    }
    if (index === 2) text = '  --permission-profile <NAME>\n  --include-managed-config\n';
    if (index === 3) text = JSON.stringify(sandbox);
    return override?.(request, index, stub(text)) ?? stub(text);
  });
  const run = (extra: Partial<Parameters<typeof runPolicyProbe>[0]> = {}) => runPolicyProbe({
    runner: { start }, executable: '/synthetic/codex-must-not-start', provenance: 'synthetic',
    env: { PATH: '/synthetic/bin', HOME: SECRET, NODE_OPTIONS: SECRET }, cleanupMs: 10, ...extra,
  });
  return { start, requests, run };
}

describe('R2: независимые наблюдения и запрет следующих запусков', () => {
  it('manifest содержит четыре запуска, ноль моделей и не исключает managed-слои', () => {
    const profile = 'vs-p3-r2-' + 'a'.repeat(32);
    const commands = buildR2Requests('/pinned/codex', '/own/project', profile, { HOME: '/original' });
    expect(commands.map(c => c.executable)).toEqual(['/usr/bin/cc', '/own/project/fs-probe', '/pinned/codex', '/pinned/codex']);
    expect(commands[2]!.args).toEqual(['sandbox', '--help']);
    expect(commands[3]!.args).toEqual([
      '-c', `permissions.${profile}.filesystem={":root"="deny",":minimal"="read",":workspace_roots"={"."="read"}}`,
      '-c', `permissions.${profile}.network.enabled=false`, '-c', 'approval_policy="never"',
      '-c', 'check_for_update_on_startup=false', '-c', 'analytics.enabled=false',
      'sandbox', '--permission-profile', profile, '--include-managed-config', '-C', '/own/project', '--', '/own/project/fs-probe',
    ]);
    expect(commands.every(c => c.stdin === '' && c.env.HOME === '/original' && c.timeoutMs! <= 20_000
      && c.maxQueueBytes === 65_536 && c.stopGraceMs === 200 && c.drainTimeoutMs === 1_000)).toBe(true);
    expect(() => buildR2Requests('/codex', '/own', 'profile.extra', {})).toThrow();
  });
  it('успех doubles остаётся synthetic/not_assessed; evidence не содержит env и сырой вывод', async () => {
    const { start, requests, run } = setup((_, __, normal) => ({ ...normal, stderr: bytes(SECRET) }));
    const saved: ProbeReport[] = [];
    const report = await run({ checkpoint: value => saved.push(value) });
    expect(report.status).toBe('observed');
    expect(report.provenance).toBe('synthetic');
    expect(report.productionAdmission).toBe('not_assessed');
    expect(report.attempts).toEqual({ auxiliary: 2, cli: 2, models: 0 });
    expect(report.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(report.probeSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(report.cleanup).toBe('removed');
    expect(start).toHaveBeenCalledTimes(4);
    expect(existsSync(dirname(requests[0]!.cwd))).toBe(false);
    expect(requests[0]!.env.HOME).toBe(SECRET);
    expect(requests.every(r => r.env.NODE_OPTIONS === undefined)).toBe(true);
    expect(JSON.stringify(saved)).not.toContain(SECRET);
    expect(JSON.stringify(saved)).not.toContain(requests[0]!.cwd);
    expect(saved.at(-1)).toEqual(report);
  });
  it.each(['outside', 'symlink', 'writeInside', 'writeOutside'] as const)('каждый отрицательный syscall %s обязателен', key => {
    expect(sandboxPassed({ ...sandbox, [key]: allow })).toBe(false);
    expect(sandboxPassed({ ...sandbox, [key]: { ...deny, code: 'OTHER' } })).toBe(false);
    expect(parseProbeOutput(JSON.stringify({ ...sandbox, [key]: { ...deny, attempted: false } }))).toBeUndefined();
  });
  it('ENOENT/ошибка, отсутствие stdout, текст модели и неизвестные поля не доказывают запрет', () => {
    expect(baselinePassed(sandbox)).toBe(false);
    expect(sandboxPassed(baseline)).toBe(false);
    expect(sandboxPassed({ ...sandbox, control: deny })).toBe(false);
    for (const text of ['', 'Operation not permitted', '{}', JSON.stringify({ ...sandbox, extra: SECRET }),
      JSON.stringify(sandbox) + ' '.repeat(4096)]) expect(parseProbeOutput(text)).toBeUndefined();
  });
  it('сломанный положительный контроль запрещает оба запуска CLI', async () => {
    const { start, run } = setup((_, index, normal) => index === 1 ? stub(JSON.stringify(sandbox)) : normal);
    const report = await run();
    expect(report.reason).toBe('baseline_failed');
    expect(report.attempts.cli).toBe(0);
    expect(report.cleanup).toBe('removed');
    expect(start).toHaveBeenCalledTimes(2);
  });
  it('необъявленный include-managed-config прекращает набор до sandbox', async () => {
    const { start, run } = setup((_, index, normal) => index === 2 ? stub('--permission-profile <NAME>') : normal);
    expect((await run()).reason).toBe('interface_unconfirmed');
    expect(start).toHaveBeenCalledTimes(3);
  });
  it('замена бинарника после baseline запрещает следующий запуск', async () => {
    const { start, run } = setup((request, index, normal) => {
      if (index === 1) writeFileSync(join(request.cwd, 'fs-probe'), 'changed');
      return normal;
    });
    expect((await run()).reason).toBe('identity_changed');
    expect(start).toHaveBeenCalledTimes(2);
  });
  it('реальная запись маркера не скрывается отрицательным JSON', async () => {
    const { run } = setup((request, index, normal) => {
      if (index === 3) writeFileSync(join(request.cwd, 'NEW.txt'), 'x');
      return normal;
    });
    expect((await run()).reason).toBe('policy_failed');
  });
  it('изменённый контрольный файл прекращает набор', async () => {
    const { start, run } = setup((request, _, normal) => {
      writeFileSync(join(request.cwd, 'CONTROL.txt'), SECRET);
      return normal;
    });
    expect((await run()).reason).toBe('controls_changed');
    expect(start).toHaveBeenCalledOnce();
  });
  it.each([
    cleanCompletion({ stdout: 'forced_closed' }),
    cleanCompletion({ process: { state: 'unconfirmed' } }),
    cleanCompletion({ wait: 'deadline' }),
    cleanCompletion({ signals: [{ signal: 'SIGKILL', target: 'group', status: 'failed', errorCode: 'EPERM' }] }),
  ])('недостоверный lifecycle сохраняет tmp и запрещает следующий процесс', async completion => {
    const { start, run } = setup((_, __, normal) => ({ ...normal, done: Promise.resolve(processResult(completion)) }));
    const report = await run();
    expect(report.reason).toBe('lifecycle');
    expect(report.cleanup).toBe('retained');
    expect(start).toHaveBeenCalledOnce();
  });
  it('rejected done и выброшенная фабрика не превращаются в подтверждённый exit', async () => {
    const one = setup((_, __, normal) => ({ ...normal, done: Promise.reject(new Error(SECRET)) }));
    const report = await one.run();
    expect(report.cleanup).toBe('retained');
    expect(report.reason).toBe('lifecycle');
    expect(one.start).toHaveBeenCalledOnce();
    const two = setup(() => { throw new Error(SECRET); });
    const lost = await two.run();
    expect(lost.reason).toBe('launch_failed');
    expect(lost.processes[0]!.handle).toBe('unconfirmed');
    expect(lost.attempts.auxiliary).toBe(1);
    expect(lost.cleanup).toBe('retained');
    expect(JSON.stringify([report, lost])).not.toContain(SECRET);
  });
  it('проекция exitCode не может скрыть противоположный completion', async () => {
    const { start, run } = setup((_, __, normal) => ({ ...normal, done: Promise.resolve({
      ...processResult(cleanCompletion({ process: { state: 'exited', exitCode: 1, signal: null } })), exitCode: 0,
    }) }));
    expect((await run()).reason).toBe('lifecycle');
    expect(start).toHaveBeenCalledOnce();
  });
  it('ошибка Stop сохраняется и не даёт удалить стенд', async () => {
    const { start, run } = setup((_, __, normal) => ({ ...normal,
      done: Promise.reject(new Error(SECRET)), kill: async () => { throw new Error(SECRET); },
    }));
    const report = await run();
    expect(report.stopFailures).toBe(1);
    expect(report.cleanup).toBe('retained');
    expect(start).toHaveBeenCalledOnce();
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });
  it('Stop после наблюдаемого stdout завершает собственный процесс и запрещает CLI', async () => {
    const controller = new AbortController();
    const result = deferred<ReturnType<typeof processResult>>();
    const kill = vi.fn(async () => { result.resolve(processResult()); });
    const { start, run } = setup(() => stub('', {
      stdout: { async *[Symbol.asyncIterator]() { yield Buffer.from('activity'); controller.abort(); } },
      done: result.promise, kill,
    }));
    const report = await run({ signal: controller.signal });
    expect(report.reason).toBe('cancelled');
    expect(report.processes[0]!.stdoutBytes).toBe(8);
    expect(kill).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    expect(report.cleanup).toBe('removed');
  });
  it('зависший поток при формально хорошем done не подтверждает EOF', async () => {
    const { start, run } = setup((_, __, normal) => ({ ...normal,
      stdout: { async *[Symbol.asyncIterator]() { await new Promise(() => {}); yield Buffer.alloc(0); } },
    }));
    const report = await run({ deadlineMs: 10 });
    expect(report.reason).toBe('deadline');
    expect(report.cleanup).toBe('retained');
    expect(report.processes[0]!.stdoutEnded).toBe(false);
    expect(start).toHaveBeenCalledOnce();
  });
  it('превышение stdout/stderr останавливает процесс без экспорта содержания', async () => {
    const kill = vi.fn(async () => {});
    const { start, run } = setup((_, __, normal) => ({ ...normal, stdout: bytes('x'.repeat(R2_BUDGET.outputBytes)),
      stderr: bytes(SECRET), kill }));
    const report = await run();
    expect(report.reason).toBe('output_limit');
    expect(start).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledOnce();
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });
  it('ошибка записи evidence до запуска не расходует реальных процессов', async () => {
    const { start, run } = setup();
    expect((await run({ checkpoint: () => { throw new Error(SECRET); } })).reason).toBe('evidence_failed');
    expect(start).not.toHaveBeenCalled();
  });
  it('несовпадение pin, предварительный Stop и API key запрещают процессы', async () => {
    const { start, run } = setup();
    expect((await run({ beforeStart: () => false })).reason).toBe('identity_changed');
    expect((await run({ signal: AbortSignal.abort() })).reason).toBe('cancelled');
    expect((await run({ env: { CODEX_API_KEY: SECRET } })).reason).toBe('preparation_failed');
    expect(start).not.toHaveBeenCalled();
  });
  it('настоящие компиляция и пять baseline syscalls; оба Codex-запуска подставлены', async () => {
    const real = createProcessRunner();
    const requests: ProcessRequest[] = [];
    const runner = { start: (request: ProcessRequest): ProcessRun => {
      // Настоящие процессы очищает только надзор после exit/EOF, не afterEach doubles.
      requests.push(request);
      if (requests.length <= 2) return real.start(request);
      expect(request.executable).toBe('/synthetic/codex-must-not-start');
      return stub(requests.length === 3 ? '--permission-profile <NAME>\n--include-managed-config\n' : JSON.stringify(sandbox));
    } };
    const report = await runPolicyProbe({ runner, executable: '/synthetic/codex-must-not-start',
      provenance: 'synthetic', env: process.env });
    expect(report.status, JSON.stringify(report)).toBe('observed');
    expect(report.baseline).toEqual(baseline);
    expect(report.cleanup).toBe('removed');
    expect(requests).toHaveLength(4);
    expect(report.productionAdmission).toBe('not_assessed');
  });
  it('точка входа завершает успех и отказ даже с активным handle; CLI не запускается', async () => {
    const exec = promisify(execFile);
    const entry = resolve('tests/live/codex-policy.probe.ts');
    // Собственный ref'ed timer воспроизводит удержание Node после возврата main.
    // Ни child CLI, ни изменения реального допуска для этой регрессии не нужны.
    const command = ['scripts/with-node.sh', 'node', '--experimental-transform-types',
      '--import', 'data:text/javascript,setInterval(() => {}, 1000)', entry];
    const env = { ...process.env };
    delete env.CODEX_R2_PLAN; delete env.CODEX_BIN;
    const { stdout } = await exec('/bin/sh', command, { env, timeout: 20_000, maxBuffer: 65_536 });
    const manifest = JSON.parse(stdout);
    expect(manifest.armed).toBe(false);
    expect(manifest.commands).toHaveLength(4);
    expect(manifest.budget.models).toBe(0);
    await expect(exec('/bin/sh', [...command, '--run-p3-r2'], { env, timeout: 20_000, maxBuffer: 65_536 }))
      .rejects.toMatchObject({ code: 1, killed: false });
  });
});
