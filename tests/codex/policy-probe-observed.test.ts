import { describe, expect, it } from 'vitest';
import fixture from '../fixtures/codex/observed-0.163.0-policy-r2.json' with { type: 'json' };
import manifest from '../fixtures/codex/r2-identity-manifest.json' with { type: 'json' };
import { exportCodexR2Evidence, reviewCodexR2Evidence } from '../helpers/codex/policy-probe-evidence.ts';
import type { R2EvidenceIdentity } from '../helpers/codex/policy-probe-evidence.ts';

// SHA исходных bytes сверён C с файлом B 2026-10-25 и журналом compatibility §17.
// CI читает только обезличенную fixture; он не повторяет CLI/syscalls и не открывает tmp B.
const sourceEvidenceSha256 = '1916a7b769b152d6af08ede3fe315baaa5743f4b62c0e40dabaf36615e6426d1';
const expected: R2EvidenceIdentity = manifest.identity;
const evidence = fixture.evidence;

describe('R2: реальное evidence B от 2026-10-24, без нового запуска CLI', () => {
  it('связывает экспорт с исходным файлом и независимым manifest, сохраняя границы вывода', () => {
    expect(fixture.sourceEvidenceSha256).toBe(sourceEvidenceSha256);
    expect(evidence.startedAt).toBe('2026-10-24T14:48:21.346Z');
    expect(evidence.recordedAt).toBe('2026-10-24T14:48:24.159Z');
    const review = reviewCodexR2Evidence(evidence, expected);
    expect(review).toEqual({
      provenance: 'live', basis: 'exported_summary', identity: 'matched',
      attemptAccounting: 'confirmed_in_export', lifecycle: 'confirmed_in_export',
      cleanup: 'confirmed_in_export', baseline: 'confirmed_in_export',
      sandboxOperations: 'confirmed_in_export', filesystemEffects: 'reported_by_supervisor',
      productionAdmission: 'not_assessed', execPolicy: 'not_assessed', extensions: 'not_assessed', p3: 'unconfirmed',
    });
    expect(fixture.review).toEqual(review);
  });

  it('сохраняет расход 2+2/0, подтверждённые exit/EOF и cleanup четырёх управляемых запусков', () => {
    expect(evidence.report).toMatchObject({
      scenario: 'P3-R2', provenance: 'live', status: 'observed',
      attempts: { cli: 2, auxiliary: 2, models: 0 }, cleanup: 'removed', stopFailures: 0,
    });
    expect(evidence.report.processes.map(process => process.step))
      .toEqual(['compile', 'baseline', 'sandbox-help', 'sandbox']);
    for (const process of evidence.report.processes) {
      expect(process).toMatchObject({
        handle: 'returned', stdoutEnded: true, stderrEnded: true,
        completion: {
          process: { state: 'exited', exitCode: 0, signal: null },
          stdout: 'ended', stderr: 'ended', wait: 'settled', issues: [],
          signals: [{ signal: 'SIGKILL', target: 'group', status: 'not_found' }],
          descendants: 'not_guaranteed',
        },
      });
      expect(process.stdoutBytes + process.stderrBytes).toBeLessThanOrEqual(65_536);
    }
  });

  it('наблюдает все пять операций baseline и конкретные EPERM четырёх операций sandbox', () => {
    const allowed = { attempted: true, state: 'allowed', code: 'NONE', matched: true };
    const denied = { attempted: true, state: 'denied', code: 'EPERM', matched: false };
    for (const operation of ['control', 'outside', 'symlink', 'writeInside', 'writeOutside'] as const) {
      expect(evidence.report.baseline[operation]).toEqual(allowed);
      expect(evidence.report.sandbox[operation]).toEqual(operation === 'control' ? allowed : denied);
    }
  });

  it('экспорт содержит только закрытую безопасную проекцию, без исходных путей и потоков', () => {
    const reexported = exportCodexR2Evidence(JSON.stringify(evidence), expected);
    expect(reexported).toBeDefined();
    expect(reexported!.evidence).toEqual(evidence);
    expect(reexported!.review).toEqual(fixture.review);
    expect(Object.keys(fixture)).toEqual(['schemaVersion', 'sourceEvidenceSha256', 'evidence', 'review']);
    expect(JSON.stringify(fixture)).not.toMatch(/\/Users\/|\/(?:private\/)?(?:var\/folders|tmp)\//);
    // SHA повторно сериализованной сводки не выдаётся за SHA исходного файла B.
  });
});
