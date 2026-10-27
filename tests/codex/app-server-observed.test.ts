import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { firstChecks, resumeChecks } from '../helpers/codex/live-plan.ts';
import { reviewRpcPolicy } from '../helpers/codex/rpc-policy-evidence.ts';
import { inspectOwnRpcRollout } from '../helpers/codex/rpc-rollout-evidence.ts';
import type { Observation } from '../helpers/codex/live-harness.ts';

const read = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/codex/observed-0.163.0-app-server-${name}.json`, import.meta.url), 'utf8'));
const accepted = read('r02'), failed = read('r01'), config = read('config'), research = read('research');
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const observation = (key: string): Observation => ({ result: { kind: 'success', text: accepted.messages[key].final[0], stopAccepted: false,
  completion: accepted.report.checks.find((c: { label: string; completion?: unknown }) => c.label === key && c.completion).completion },
  text: '', threadIds: [accepted.messages[key].threadId], toolNames: [], deniedTools: [], stopAccepted: false });

describe('сохранённая живая приёмка Codex app-server 0.163.0', () => {
  it('сохраняет неудачные исследования и первый набор отдельно от успеха', () => {
    expect(research.attempts.map((a: { results: { context: string }[] }) => a.results.map(r => r.context))).toEqual([
      ['passed', 'failed'], ['unconfirmed'], ['passed', 'passed']]);
    expect(failed.report).toMatchObject({ status: 'failed', attempts: { models: 3, diagnostics: 9, auxiliary: 3 }, cleanup: 'removed' });
    expect(accepted.report).toMatchObject({ status: 'passed', p3: 'accepted_rpc_profile', attempts: { models: 4, diagnostics: 12, auxiliary: 3 }, cleanup: 'removed' });
  });
  it('независимо восстанавливает точные проверки первого хода и resume', () => {
    const lines = accepted.messages.M1.final[0].trim().split('\n');
    const marker = lines[1].slice('ЧТЕНИЕ: '.length), memory = lines[2].slice('ПАМЯТЬ: '.length);
    expect(Object.values(firstChecks(observation('M1'), marker, memory)).every(c => c === 'passed')).toBe(true);
    expect(Object.values(resumeChecks(observation('M2'), accepted.messages.M1.threadId, memory, true)).every(c => c === 'passed')).toBe(true);
  });
  it('независимо сверяет реальный вывод M4, оба policy snapshots и inventory', () => {
    const m = accepted.m4;
    const runtime = inspectOwnRpcRollout(m.rolloutProjection.map((r: unknown) => JSON.stringify(r)).join('\n'), m.threadId, m.turnId, m.cwd, m.home, '');
    const marker = accepted.messages.M1.final[0].trim().split('\n')[1].slice('ЧТЕНИЕ: '.length);
    expect(Object.values(reviewRpcPolicy(m.commandRows, m.threadId, marker, m.originalReview.policy.controls, runtime)).every(value => value === true)).toBe(true);
    expect(runtime).toEqual(m.originalReview.runtime);
  });
  it('подтверждает один terminal, три отказа без процессов и Stop после активности', () => {
    const checks = accepted.report.checks.filter((c: { completion?: unknown }) => c.completion);
    expect(checks).toHaveLength(7);
    for (const c of checks) { expect(c.terminalCount).toBe(1); expect(c.completion.issues).toEqual([]); }
    for (const name of ['M3-missing', 'M3-foreign', 'M3-binding']) expect(checks.find((c: { label: string }) => c.label === name)).toMatchObject({ reason: 'invalid_request', completion: { process: { state: 'not_started' } } });
    expect(checks.find((c: { label: string }) => c.label === 'M5')).toMatchObject({ kind: 'interrupted', stopAccepted: true, completion: { process: { state: 'exited', exitCode: 0 }, stdout: 'ended', stderr: 'ended' } });
  });
  it('сохраняет идентичность проверенного production-кода и отдельно усиленного preflight', () => {
    for (const [path, sha] of Object.entries(accepted.sourceManifest)) if (path.startsWith('src/')) {
      expect(hash(readFileSync(path)), path).toBe(path === 'src/adapters/codex/app-server-policy.ts' ? config.policySourceSha256 : sha);
    }
    expect(hash(JSON.stringify(accepted.sourceManifest))).toBe(accepted.report.sourceManifestSha256);
    expect(config).toMatchObject({ passed: true, cli: 1, models: 0, methods: ['initialize', 'initialized', 'config/read'], cleanup: 'removed' });
    expect(accepted.report.processes).toHaveLength(16);
    for (const p of accepted.report.processes) expect(p.completion).toMatchObject({ process: { state: 'exited', exitCode: 0 }, stdout: 'ended', stderr: 'ended', issues: [] });
  });
});
