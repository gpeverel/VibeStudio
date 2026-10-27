import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { exportCodexR2Evidence, reviewCodexR2Evidence } from '../helpers/codex/policy-probe-evidence.ts';
import type { R2EvidenceIdentity } from '../helpers/codex/policy-probe-evidence.ts';
import { cleanCompletion } from '../helpers/codex/process-double.ts';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const roles = ['entry', 'supervisor', 'completion_export', 'runner', 'queue', 'environment'] as const;
const programs = ['wrapper', 'native', 'node'] as const;
const expected: R2EvidenceIdentity = {
  sourceSha256: digest('synthetic C source'),
  executable: { wrapper: digest('wrapper'), native: digest('native'), node: digest('node') },
  implementation: { entry: digest('entry'), supervisor: digest('supervisor'), completion_export: digest('completion_export'),
    runner: digest('runner'), queue: digest('queue'), environment: digest('environment') },
};
function synthetic() {
  const allow = { attempted: true, state: 'allowed', code: 'NONE', matched: true };
  const deny = { attempted: true, state: 'denied', code: 'EACCES', matched: false };
  return {
    schemaVersion: 1, startedAt: '2026-10-20T12:00:00.000Z', recordedAt: '2026-10-20T12:00:01.000Z',
    expectedVersion: '0.163.0', sourceSha256: expected.sourceSha256,
    executable: programs.map(role => ({ role, sha256: expected.executable[role] })),
    implementation: roles.map(role => ({ role, sha256: expected.implementation[role] })),
    budget: { cli: 2, auxiliary: 2, models: 0, totalMs: 60_000, compileMs: 20_000, processMs: 10_000,
      cleanupMs: 5_000, stopMs: 2_000, graceMs: 200, drainMs: 1_000, outputBytes: 65_536 },
    report: {
      scenario: 'P3-R2', provenance: 'synthetic', productionAdmission: 'not_assessed',
      status: 'observed', reason: undefined as string | undefined,
      attempts: { cli: 2, auxiliary: 2, models: 0 }, sourceSha256: expected.sourceSha256, probeSha256: digest('synthetic probe'),
      baseline: { schemaVersion: 1, control: { ...allow }, outside: { ...allow }, symlink: { ...allow },
        writeInside: { ...allow }, writeOutside: { ...allow } },
      sandbox: { schemaVersion: 1, control: { ...allow }, outside: { ...deny }, symlink: { ...deny },
        writeInside: { ...deny }, writeOutside: { ...deny } },
      processes: ['compile', 'baseline', 'sandbox-help', 'sandbox'].map(step => ({
        step, argvSha256: digest(step), envNames: ['HOME', 'PATH'], handle: 'returned',
        stdoutBytes: 128, stderrBytes: 0, stdoutEnded: true, stderrEnded: true,
        completion: cleanCompletion(),
      })),
      cleanup: 'removed', stopFailures: 0,
    },
    p3: 'unconfirmed', execPolicy: 'not_assessed', extensions: 'not_assessed',
    limitations: ['sandbox_command_only', 'runtime_reads_not_audited', 'configuration_layers_not_audited',
      'network_effects_not_attested', 'detached_children_not_guaranteed'],
  };
}
const review = (value: unknown) => reviewCodexR2Evidence(value, expected);

describe('R2: независимая инспекция закрытого экспорта, без CLI', () => {
  it('полный synthetic остаётся synthetic; область вывода ограничена пятью операциями sandbox', () => {
    expect(review(synthetic())).toEqual({
      provenance: 'synthetic', basis: 'exported_summary', identity: 'matched',
      attemptAccounting: 'confirmed_in_export', lifecycle: 'confirmed_in_export', cleanup: 'confirmed_in_export',
      baseline: 'confirmed_in_export', sandboxOperations: 'confirmed_in_export',
      filesystemEffects: 'reported_by_supervisor', productionAdmission: 'not_assessed',
      execPolicy: 'not_assessed', extensions: 'not_assessed', p3: 'unconfirmed',
    });
  });
  it.each(['outside', 'symlink', 'writeInside', 'writeOutside'] as const)(
    'требует попытку, конкретный errno и отсутствие результата для %s', key => {
      for (const patch of [{ attempted: false }, { code: 'OTHER' }, { matched: true }, { state: 'error' }]) {
        const value = synthetic();
        Object.assign(value.report.sandbox[key], patch);
        expect(review(value).sandboxOperations).toBe('unconfirmed');
      }
    });
  it('сломанный положительный контроль не компенсируется хорошим sandbox', () => {
    const value = synthetic();
    value.report.baseline.writeOutside.matched = false;
    expect(review(value)).toMatchObject({ baseline: 'unconfirmed', sandboxOperations: 'unconfirmed' });
  });
  it.each(['entry', 'source', 'native', 'duplicate-role'] as const)('сверяет независимую идентичность: %s', change => {
    const value = synthetic();
    if (change === 'entry') value.implementation[0]!.sha256 = digest('changed entry');
    if (change === 'source') value.report.sourceSha256 = digest('changed source');
    if (change === 'native') value.executable[1]!.sha256 = digest('changed native');
    if (change === 'duplicate-role') value.implementation[1] = value.implementation[0]!;
    expect(review(value)).toMatchObject({ identity: 'mismatch', sandboxOperations: 'unconfirmed' });
    expect(exportCodexR2Evidence(JSON.stringify(value), expected)).toBeUndefined();
  });
  it.each(['duplicate-step', 'budget', 'missing-process', 'clock', 'duplicate-env'] as const)(
    'не принимает противоречивый журнал: %s', change => {
      const value = synthetic();
      if (change === 'duplicate-step') value.report.processes[1]!.step = 'compile';
      if (change === 'budget') value.report.attempts.cli = 1;
      if (change === 'missing-process') value.report.processes.pop();
      if (change === 'clock') value.recordedAt = '2026-10-19T12:00:00.000Z';
      if (change === 'duplicate-env') value.report.processes[0]!.envNames.push('HOME');
      expect(review(value)).toMatchObject({ attemptAccounting: 'unconfirmed', sandboxOperations: 'unconfirmed' });
    });
  it.each(['exit', 'stdout', 'stderr', 'wait', 'handle', 'signal', 'cleanup', 'stop', 'issue', 'nonzero'] as const)(
    'observed не скрывает ошибку или неподтверждённое завершение: %s', change => {
      const value = synthetic();
      const process = value.report.processes[3]!;
      if (change === 'exit') process.completion = cleanCompletion({ process: { state: 'unconfirmed' } });
      if (change === 'stdout') process.stdoutEnded = false;
      if (change === 'stderr') process.completion = cleanCompletion({ stderr: 'forced_closed' });
      if (change === 'wait') process.completion = cleanCompletion({ wait: 'deadline' });
      if (change === 'handle') process.handle = 'unconfirmed';
      if (change === 'signal') process.completion = cleanCompletion({
        signals: [{ signal: 'SIGKILL', target: 'group', status: 'failed' }],
      });
      if (change === 'cleanup') value.report.cleanup = 'retained';
      if (change === 'stop') value.report.stopFailures = 1;
      if (change === 'issue') process.completion = cleanCompletion({ issues: [{ code: 'timeout', detail: 'synthetic-timeout' }] });
      if (change === 'nonzero') process.completion = cleanCompletion({ process: { state: 'exited', exitCode: 1, signal: null } });
      expect(review(value).sandboxOperations).toBe('unconfirmed');
    });
  it('сохраняет завершённый неуспешный запуск, не выдаёт его за наблюдение политики', () => {
    const value = synthetic();
    value.report.status = 'stopped'; value.report.reason = 'lifecycle';
    value.report.processes[3]!.completion = cleanCompletion({ process: { state: 'exited', exitCode: 1, signal: null } });
    expect(review(value)).toMatchObject({
      lifecycle: 'confirmed_in_export', cleanup: 'confirmed_in_export', sandboxOperations: 'unconfirmed',
    });
    expect(exportCodexR2Evidence(JSON.stringify(value), expected)?.evidence.report.status).toBe('stopped');
  });
  it.each(['signal_failed', 'stream_failed', 'exit_unconfirmed', 'process_result_failed'] as const)(
    '%s в issues не позволяет подтвердить cleanup при пустом signals и stopFailures=0', code => {
      const value = synthetic();
      value.report.processes[3]!.completion = cleanCompletion({ issues: [{ code, detail: 'synthetic issue' }] });
      const result = review(value);
      expect(result).toMatchObject({
        lifecycle: 'unconfirmed', cleanup: 'unconfirmed', sandboxOperations: 'unconfirmed',
      });
      expect(exportCodexR2Evidence(JSON.stringify(value), expected)?.review).toEqual(result);
    });
  it('timeout не отменяет подтверждённый выход и cleanup, но не подтверждает политику', () => {
    const value = synthetic();
    value.report.status = 'stopped'; value.report.reason = 'deadline';
    value.report.processes[3]!.completion = cleanCompletion({ issues: [{ code: 'timeout', detail: 'synthetic timeout' }] });
    expect(review(value)).toMatchObject({
      lifecycle: 'confirmed_in_export', cleanup: 'confirmed_in_export', sandboxOperations: 'unconfirmed',
    });
  });
  it('не доверяет итоговому status при отсутствии наблюдений', () => {
    const value = synthetic();
    value.report.processes = []; value.report.attempts = { cli: 0, auxiliary: 0, models: 0 };
    value.report.cleanup = 'not_created';
    expect(review(value)).toMatchObject({ lifecycle: 'not_started', sandboxOperations: 'unconfirmed' });
  });
  it('экспорт сохраняет SHA исходных bytes и provenance, удаляет пути и произвольные строки', () => {
    const value = synthetic();
    const text = JSON.stringify({ ...value, secret: 'SYNTHETIC-SECRET',
      report: { ...value.report, retainedWorkspace: '/SYNTHETIC-SECRET', stdout: 'SYNTHETIC-SECRET' } });
    const result = exportCodexR2Evidence(text, expected)!;
    expect(result.sourceEvidenceSha256).toBe(digest(text));
    expect(result.evidence.report.provenance).toBe('synthetic');
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC-SECRET');
    expect(result.review.productionAdmission).toBe('not_assessed');
  });
  it('отклоняет иной бюджет, небезопасные поля закрытой схемы и повреждённый JSON', () => {
    for (const input of [null, {}, { ...synthetic(), budget: { models: 1 } },
      { ...synthetic(), expectedVersion: '/SYNTHETIC-SECRET' }]) {
      expect(review(input).provenance).toBe('invalid');
      expect(exportCodexR2Evidence(JSON.stringify(input), expected)).toBeUndefined();
    }
    expect(exportCodexR2Evidence('{', expected)).toBeUndefined();
    expect(exportCodexR2Evidence(' '.repeat(65_537), expected)).toBeUndefined();
  });
});
