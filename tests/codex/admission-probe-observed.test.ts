import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import fixture from '../fixtures/codex/observed-0.163.0-admission-r3.json' with { type: 'json' };
import manifest from '../fixtures/codex/r3-identity-manifest-2026-10-27-r01.json' with { type: 'json' };
import { inspectR3Evidence } from '../helpers/codex/admission-probe-evidence.ts';

describe('R3: реальная остановка 2026-10-27, без повторного запуска CLI', () => {
  it('сверяет результат с manifest, подготовленным до запуска', () => {
    const bytes = readFileSync(new URL('../fixtures/codex/r3-identity-manifest-2026-10-27-r01.json', import.meta.url));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(fixture.sourceManifestSha256);
    expect(fixture.sourceManifestSha256).toBe('ee84721a5dd9be1054586af7961c520cd0330e525e846024d33c3b157670b2b4');
    expect(fixture.sourceEvidenceSha256).toBe('c3ae6bafad7fe1595414ec00ae74ff3dc2da11a05c26096150dc143eb6b2174f');
    expect(inspectR3Evidence(fixture.evidence, manifest.identity).review).toEqual(fixture.review);
    expect(fixture.review).toMatchObject({ provenance: 'live', identity: 'matched', consistent: true,
      accounting: true, lifecycle: true, cleanup: true, positive: false, first: false, resume: false,
      productionAdmission: 'not_assessed', p3: 'unconfirmed' });
  });
  it('сохраняет неуспешный positive, расход 3+1 и завершение прямых процессов', () => {
    expect(fixture.evidence.report).toMatchObject({ status: 'stopped', reason: 'lifecycle',
      attempts: { auxiliary: 3, models: 1, cliNonModel: 0 }, cleanup: 'removed', stopFailures: 0 });
    expect(fixture.evidence.report.processes.map(p => p.step)).toEqual(['git-init', 'compile', 'baseline', 'positive']);
    const positive = fixture.evidence.report.processes[3]!;
    expect(positive).toMatchObject({ stdoutBytes: 0, stderrBytes: 199, completion: {
      process: { state: 'exited', exitCode: 1, signal: null }, stdout: 'ended', stderr: 'ended', wait: 'settled', issues: [],
    } });
    // Исходный запуск не сохранил stderr; более поздняя диагностика не дописывается в него.
    expect(positive).not.toHaveProperty('stderrFindings');
  });
  it('baseline не становится подтверждением политики модели', () => {
    for (const key of ['control', 'outside', 'symlink', 'writeInside', 'writeOutside'] as const) {
      expect(fixture.evidence.report.baseline[key]).toEqual({ attempted: true, state: 'allowed', code: 'NONE', matched: true });
    }
    const changed = structuredClone(fixture.evidence);
    changed.report.status = 'observed';
    expect(inspectR3Evidence(changed, manifest.identity).review.consistent).toBe(false);
  });
  it('экспорт не содержит путей рабочей области, сырого stderr или истории', () => {
    expect(JSON.stringify(fixture)).not.toMatch(/\/Users\/|\/(?:private\/)?(?:var\/folders|tmp)\/|in-process app-server|thread_id|retainedWorkspace/);
  });
});
