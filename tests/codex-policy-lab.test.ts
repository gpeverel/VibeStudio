import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { LAB_BUDGET, buildLabSteps, runPolicyLab } from '../scripts/codex-policy-lab.ts';
import type { LabContext, LabOptions, LabReport } from '../scripts/codex-policy-lab.ts';
import { createProcessRunner } from '../src/adapters/process-runner/index.ts';
import { CodexStand } from './helpers/codex/stand.ts';

// Весь набор synthetic: установленный Codex, его auth и сеть не используются.
const run = promisify(execFile);
const CTX: LabContext = {
  repo: '/lab/repo', outside: '/lab/outside', markers: '/lab/markers', decoys: '/lab/decoys', node: '/lab/node',
  tokens: { control: 'CONTROL-x', outside: 'OUTSIDE-x', agents: 'AGENTS-x' },
};
const stands: CodexStand[] = [];
afterEach(() => { for (const s of stands.splice(0)) s.cleanup(); });
const stand = (): CodexStand => { const s = new CodexStand(); stands.push(s); return s; };
// Запуск Node-двойника на этой машине занимает ≈0,4 с, поэтому лимиты не меньше нескольких секунд.
const SMALL = { processMs: 5_000, graceMs: 50, drainMs: 100, streamBytes: 65_536 };
const EXEC_HELP = 'Options:\n  --strict-config\n  --dangerously-bypass-hook-trust\n  --ignore-user-config\n  --ignore-rules\n';
const HANG = { processMs: 1_000, graceMs: 50, drainMs: 100, streamBytes: 65_536 };

function options(s: CodexStand, scenario: Parameters<CodexStand['fake']>[0], extra: Partial<LabOptions> = {}): LabOptions {
  const executable = s.fake(scenario);
  return {
    runner: createProcessRunner(), executable, identityFiles: [{ role: 'wrapper', path: executable }], provenance: 'synthetic',
    env: { HOME: s.dir, PATH: '/usr/bin:/bin', CODEX_API_KEY: 'SECRET-key', NODE_OPTIONS: '--require SECRET', EXTRA: 'SECRET-value' },
    limits: { r0: SMALL, r1: SMALL }, ...extra,
  };
}
const statuses = (report: LabReport): Record<string, string> => Object.fromEntries(report.steps.map(step => [step.id, step.status]));

describe('лабораторный стенд R: манифест', () => {
  const steps = buildLabSteps(CTX);

  it('укладывается в согласованные бюджеты процессов', () => {
    expect(steps.filter(step => step.kind === 'r0')).toHaveLength(7);
    expect(steps.filter(step => step.kind === 'r0').length).toBeLessThanOrEqual(LAB_BUDGET.r0Max);
    expect(steps.filter(step => step.kind === 'r1')).toHaveLength(LAB_BUDGET.r1Max);
    expect(new Set(steps.map(step => step.id)).size).toBe(steps.length);
    for (const step of steps) expect(Buffer.byteLength(step.stdin)).toBeLessThanOrEqual(8 * 1024);
    for (const step of steps.filter(item => item.kind === 'r1')) {
      expect(step.limits.processMs).toBe(90_000);
      expect(step.limits.graceMs).toBe(2_000);
      expect(step.limits.drainMs).toBe(2_000);
    }
  });

  it('не содержит login/logout, установки, обновления и изменения политики подтверждений', () => {
    const joined = steps.flatMap(step => step.args).join('\n');
    expect(joined).not.toMatch(/\b(login|logout|update|install|doctor)\b/);
    expect(joined).not.toContain('danger-full-access');
    expect(joined).not.toContain('workspace-write');
    for (const step of steps.filter(item => item.kind === 'r1')) {
      expect(step.args).toEqual(expect.arrayContaining(['--ignore-user-config', '--ignore-rules', '--ephemeral', '--json']));
      expect(step.args).toContain('approval_policy="never"');
      expect(step.args.at(-1)).toBe('-');
    }
  });

  it('обход доверия хуков и явное доверие проекту допустимы только в положительном контроле', () => {
    const bypass = steps.filter(step => step.args.includes('--dangerously-bypass-hook-trust'));
    expect(bypass.map(step => step.id)).toEqual(['R1p']);
    const trusted = steps.filter(step => step.args.some(arg => arg.includes('trust_level')));
    expect(trusted.map(step => step.id)).toEqual(['R1p']);
    expect(steps.find(step => step.id === 'R1p')!.args.join(' ')).not.toContain('features.hooks=false');
  });

  it('вариант a: профиль без sandbox_mode/--sandbox; контроль с legacy sandbox отдельно', () => {
    const s = steps.find(step => step.id === 'R1s')!;
    expect(s.args).not.toContain('--sandbox');
    expect(s.args.join(' ')).not.toContain('sandbox_mode');
    expect(s.args).toContain('default_permissions="vs-read"');
    expect(s.requires).toBe('R0.3');
    const c = steps.find(step => step.id === 'R1c')!;
    expect(c.args).toEqual(expect.arrayContaining(['--sandbox', 'read-only']));
    expect(c.args.join(' ')).not.toContain('default_permissions');
  });
});

describe('лабораторный стенд R: исполнение на подстановке', () => {
  it('без флага сценарий печатает сухой манифест и не запускает CLI', async () => {
    // Среда передачи может запускать Vitest другим Node (флаг transform-types там отсутствует); CLI-стенд использует версию проекта.
    const script = fileURLToPath(new URL('../scripts/codex-policy-lab.ts', import.meta.url));
    const withNode = fileURLToPath(new URL('../scripts/with-node.sh', import.meta.url));
    const { stdout } = await run('/bin/sh', [withNode, 'node', '--experimental-transform-types', script], { timeout: 30_000 });
    expect(JSON.parse(stdout)).toMatchObject({ scenario: 'P3-R', dryRun: true });
  });

  it('полный проход: 8+3 процесса, allowlist env, очистка лаборатории', async () => {
    const s = stand();
    const report = await runPolicyLab(options(s, { steps: [{ out: '{"type":"thread.started"}\n' }], probes: { execHelp: { stdout: EXEC_HELP } } }));
    expect(report.status).toBe('completed');
    expect(report.attempts).toEqual({ r0: 7, r1: 3 });
    expect(report.cleanup).toBe('removed');
    expect(report.workspace && existsSync(report.workspace)).toBe(false);
    const records = s.records();
    expect(records).toHaveLength(10);
    const model = records.filter(record => record.probe === 'run' && record.argv[0] === 'exec');
    expect(model).toHaveLength(3);
    for (const record of model) expect(record.argv).toContain('--strict-config');
    for (const record of records) {
      expect(Object.keys(record.env)).not.toContain('NODE_OPTIONS');
      expect(JSON.stringify(record.env)).not.toContain('SECRET');
    }
    expect(JSON.stringify(report)).not.toContain('SECRET');
    expect(report.steps.filter(step => step.kind === 'r1').every(step => step.facts?.r1)).toBe(true);
  });

  it('без объявленных флагов exec положительный контроль пропускается, --strict-config не передаётся', async () => {
    const s = stand();
    const report = await runPolicyLab(options(s, { steps: [{ out: '{}\n' }] }));
    expect(statuses(report).R1p).toBe('skipped');
    expect(report.attempts).toEqual({ r0: 7, r1: 2 });
    for (const record of s.records().filter(item => item.probe === 'run' && item.argv[0] === 'exec')) {
      expect(record.argv).not.toContain('--strict-config');
      expect(record.argv).not.toContain('--dangerously-bypass-hook-trust');
    }
  });

  it('ответ CLI с ненулевым кодом — результат: зависимые шаги пропускаются, независимые идут', async () => {
    const s = stand();
    const report = await runPolicyLab(options(s, { steps: [{ err: 'unknown\n' }], exit: 2 }));
    // Двойник отвечает на --help успешно, поэтому R0.4/R0.7 проходят и открывают R0.5, R0.6; флагов hook-trust у него нет.
    expect(statuses(report)).toMatchObject({
      'R0.1': 'nonzero', 'R0.2': 'skipped', 'R0.3': 'skipped', 'R0.4': 'ok', 'R0.5': 'nonzero', 'R0.6': 'nonzero',
      'R0.7': 'ok', R1p: 'skipped', R1s: 'skipped', R1c: 'nonzero',
    });
    expect(report.attempts).toEqual({ r0: 5, r1: 1 });
    expect(report.status).toBe('completed');
    expect(report.steps[0]!.facts).toMatchObject({ stderrFirstLine: 'unknown' });
  });

  it('несовпадение SHA-256 останавливает сценарий до создания лаборатории и запуска процессов', async () => {
    const s = stand();
    const report = await runPolicyLab(options(s, {}, { expectedSha256: { wrapper: '0'.repeat(64) } }));
    expect(report).toMatchObject({ status: 'stopped', reason: 'identity_changed', cleanup: 'not_created', attempts: { r0: 0, r1: 0 } });
    expect(s.records()).toHaveLength(0);
  });

  it('зависший процесс прекращает сценарий: следующий spawn запрещён, exit подтверждён', async () => {
    const s = stand();
    const report = await runPolicyLab(options(s, { steps: [{ hang: true }] }, { limits: { r0: HANG, r1: HANG } }));
    expect(report).toMatchObject({ status: 'stopped', reason: 'timeout' });
    expect(report.attempts).toEqual({ r0: 1, r1: 0 });
    expect(report.steps[0]!.status).toBe('infra_failed');
    expect(statuses(report)['R0.2']).toBe('not_run');
  });

  it('вывод сверх лимита прекращает сценарий как output_limit', async () => {
    const s = stand();
    const report = await runPolicyLab(options(s, { steps: [{ out: 'x'.repeat(200_000) }] }, {
      limits: { r0: { ...SMALL, streamBytes: 1_024 }, r1: SMALL },
    }));
    expect(report).toMatchObject({ status: 'stopped', reason: 'output_limit' });
    expect(report.attempts.r0).toBe(1);
  });
});
