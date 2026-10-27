import { describe, expect, it } from 'vitest';
import type { ProcessCompletion } from '../../src/core/ports/agent.ts';
import { M4CommandCapture } from '../helpers/codex/m4-command-evidence.ts';
import { reviewCodexM4Evidence } from '../helpers/codex/m4-evidence.ts';
import type { OwnRolloutReview } from '../helpers/codex/own-rollout-evidence.ts';
import { inspectR3Evidence } from '../helpers/codex/admission-probe-evidence.ts';
import r3 from '../fixtures/codex/observed-0.163.0-admission-r3-full-access.json';
import r3Manifest from '../fixtures/codex/r3-identity-manifest-2026-10-27-r02.json';
import r4First from '../fixtures/codex/observed-0.163.0-r4-r01.json';
import r4 from '../fixtures/codex/observed-0.163.0-r4-r02.json';
import m1 from '../fixtures/codex/observed-0.163.0-m-r01.json';
import m2 from '../fixtures/codex/observed-0.163.0-m-r02.json';
import m3 from '../fixtures/codex/observed-0.163.0-m-r03.json';
import m4 from '../fixtures/codex/observed-0.163.0-m-r04.json';
import m5 from '../fixtures/codex/observed-0.163.0-m-r05.json';
import fixture from '../fixtures/codex/observed-0.163.0-m4-review.json';

async function replay(stdout = fixture.stdout) {
  async function* stream(text: string) { if (text) yield Buffer.from(text); }
  const completion = fixture.input.observation.result.completion as unknown as ProcessCompletion;
  const capture = new M4CommandCapture({ stdout: stream(stdout), stderr: stream(fixture.stderr),
    done: Promise.resolve({ exitCode: 0, signal: null, completion }), interrupt: async () => {}, kill: async () => {} }, fixture.input.marker);
  await Promise.all([(async () => { for await (const chunk of capture.run.stdout) void chunk; })(),
    (async () => { for await (const chunk of capture.run.stderr) void chunk; })(), capture.run.done]);
  return capture;
}

describe('P3: сохранённые живые результаты, без новых процессов CLI', () => {
  it('сохраняет успешный положительный контроль R3 и действительную утечку навыка', () => {
    expect(inspectR3Evidence(r3.evidence, r3Manifest.identity).review).toEqual(r3.review);
    expect(r3.review).toMatchObject({ positive: true, first: false, resume: false, consistent: true });
    expect(r3.evidence.report).toMatchObject({ reason: 'policy_failed', attempts: { models: 2 }, cleanup: 'removed' });
    expect(r3.evidence.report.processes.at(-1)?.observation?.skill).toBe(true);
  });
  it('R4 подтверждает файловую политику first/resume, но не смену инструкции', () => {
    expect(r4.evidence).toMatchObject({ status: 'observed', productionAdmission: 'not_assessed', cleanup: 'removed' });
    const observations = r4.evidence.processes.filter(p => p.step.endsWith('-observation'));
    expect(observations).toHaveLength(2);
    for (const observation of observations) {
      expect(observation).toMatchObject({ controls: true, effects: [], inventoryUnchanged: true,
        review: { protocol: 'confirmed', read: 'passed', skill: false, mcp: false, unexpectedTool: false, patch: 'unconfirmed' } });
      expect(observation.review?.probe?.outside.state).toBe('denied');
      expect(observation.review?.probe?.writeInside.state).toBe('denied');
    }
    expect(r4.denials.map(d => d.patchDenied)).toEqual([true, true]);
  });
  it('не скрывает исходный M2: память сохранилась, инструкция осталась старой', () => {
    expect(m2.evidence.reports[0]).toMatchObject({ label: 'M1', outcome: 'passed' });
    expect(m2.evidence.reports[1]).toMatchObject({ label: 'M2', outcome: 'failed', checks: {
      thread: 'passed', memory: 'passed', history: 'passed', instruction: 'failed' } });
    expect(m2.evidence.p3).toBe('unconfirmed');
  });
  it('ошибки ссылок не запускают процессы, Stop имеет один подтверждённый terminal', () => {
    for (const report of m4.evidence.reports.filter(r => r.label.startsWith('M3-'))) {
      expect(report).toMatchObject({ outcome: 'passed', models: 0, diagnostics: 0, terminalCount: 1 });
    }
    expect(m5.evidence.scope).toBe('stop-only');
    expect(m5.evidence.reports).toHaveLength(1);
    expect(m5.evidence.reports[0]).toMatchObject({ label: 'M5', outcome: 'passed', terminalCount: 1, stopAccepted: true,
      resultKind: 'interrupted', checks: { stop: 'passed' } });
  });
  it('повторно проверяет M4 по сохранённому JSONL и completion, не меняя исходный отказ стенда', async () => {
    const capture = await replay();
    expect(reviewCodexM4Evidence(fixture.input, capture, fixture.runtime as OwnRolloutReview)).toEqual(fixture.review);
    expect(fixture.review.gaps).toEqual([]);
    expect(Object.values(fixture.review.checks)).toEqual(['passed', 'passed', 'passed', 'passed']);
    expect(m4.evidence.reports.at(-1)?.outcome).toBe('unconfirmed');
    expect(fixture.p3).toBe('unconfirmed');
  });
  it('известное предупреждение не разрешает неизвестную ошибку в преамбуле', async () => {
    const rows = fixture.stdout.trim().split('\n').map(line => JSON.parse(line) as { item?: { message?: string } });
    rows[1]!.item!.message = 'Неизвестная ошибка политики';
    const capture = await replay(rows.map(row => JSON.stringify(row)).join('\n'));
    expect(capture.review(fixture.input.marker, fixture.input.observation.threadIds[0]).reason).toBe('invalid_jsonl');
  });
  it('возврат генерации изображений не проходит проверку runtime inventory', async () => {
    const capture = await replay();
    const runtime = { ...fixture.runtime, toolNames: [...fixture.runtime.toolNames, 'image_gen__imagegen'] } as OwnRolloutReview;
    expect(reviewCodexM4Evidence(fixture.input, capture, runtime).checks.extensionPolicy).toBe('unconfirmed');
    expect(m3.evidence.m4Runtime?.toolNames).toContain('image_gen__imagegen');
    expect(fixture.runtime.toolNames).not.toContain('image_gen__imagegen');
  });
  it('учитывает все попытки и сохраняет подтверждённую уборку', () => {
    const models = r3.evidence.report.attempts.models + r4First.evidence.attempts.models + r4.evidence.attempts.models
      + [m1, m2, m3, m4, m5].reduce((sum, value) => sum + value.evidence.reports.reduce((n, r) => n + r.models, 0), 0);
    expect(models).toBe(13);
    for (const value of [m1, m2, m3, m4, m5]) {
      expect(value.evidence.rootCleanup).toBe('removed');
      expect(value.evidence.cleanup.safeToRemove).toBe(true);
      expect(value.evidence.p3).toBe('unconfirmed');
    }
  });
});
