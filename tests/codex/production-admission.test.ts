import { realpathSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { buildCodexArgs } from '../../src/adapters/codex/args.ts';
import type { CodexAdmissionContext } from '../../src/adapters/codex/contracts.ts';
import { createCodexAdapter } from '../../src/adapters/codex/index.ts';
import { checkCodexAdmission, createCodexProductionAdmission } from '../../src/adapters/codex/profile.ts';
import type { AgentEvent } from '../../src/core/ports/agent.ts';
import { detection, firstRequest, resumeRequest, sandboxFirstRequest, sandboxResumeRequest,
  SYNTHETIC_ADMISSION, SYNTHETIC_SANDBOX_ADMISSION } from '../helpers/codex/requests.ts';

function context(resume = false): CodexAdmissionContext {
  const request = resume ? resumeRequest('/synthetic/workspace') : firstRequest('/synthetic/workspace');
  const built = buildCodexArgs(request);
  return { request, detection: detection('/synthetic/codex'), args: built.args, env: built.env };
}
const admission = createCodexProductionAdmission();
describe('Codex production admission: независимая матрица отказов без CLI', () => {
  it.each([false, true])('изученный встроенный маршрут имеет точный предел, не ready: resume=%s', async resume => {
    const result = await admission(context(resume));
    expect(result).toMatchObject({ status: 'unsupported', reason: 'cli_unsupported' });
    expect(result.requirements.find(r => r.requirement === 'reads_closed')).toMatchObject({
      status: 'unsupported', code: 'closed_read_mechanism_unavailable',
      sourceReview: { scope: 'builtin_exec', binaryCorrespondence: 'unconfirmed',
        revision: '83086188ae0614bd882818ff1aa23f3194962012' },
    });
    expect(result.requirements.filter(r => r.requirement !== 'reads_closed').map(r => r.status))
      .toEqual(['unconfirmed', 'unconfirmed', 'unconfirmed']);
    expect(result.requirements.every(r => r.sources.length > 0)).toBe(true);
  });

  it.each(['0.162.0', '0.164.0', null])('чужая/неизвестная версия %s не наследует доказанный предел 0.163.0', async version => {
    const value = context();
    const result = await admission({ ...value, detection: { ...value.detection, version } });
    expect(result).toMatchObject({ status: 'blocked', reason: 'requirement_unconfirmed' });
    expect(result.requirements.every(r => r.status === 'unconfirmed')).toBe(true);
  });

  it.each(['unauthenticated', 'unknown'] as const)('нет штатной auth (%s) — самостоятельный blocked', async auth => {
    const value = context();
    expect(await admission({ ...value, detection: { ...value.detection, auth } }))
      .toMatchObject({ status: 'blocked', reason: 'requirement_unconfirmed' });
  });

  it('отсутствующая обязательная возможность отличается от неизвестной', async () => {
    const value = context();
    expect(await admission({ ...value, detection: { ...value.detection,
      capabilities: { ...value.detection.capabilities, configOverrides: false } } }))
      .toMatchObject({ status: 'unsupported', reason: 'cli_unsupported' });
    const missing = structuredClone(value);
    delete (missing.detection.capabilities as Partial<typeof missing.detection.capabilities>).configOverrides;
    expect(await admission(missing)).toMatchObject({ status: 'blocked', reason: 'requirement_unconfirmed' });
  });

  it.each([
    (v: CodexAdmissionContext) => ({ ...v, args: [...v.args, '--full-auto'] }),
    (v: CodexAdmissionContext) => ({ ...v, args: [...v.args.slice(0, -1), '-c', 'features.shell_tool=true', '-'] }),
    (v: CodexAdmissionContext) => ({ ...v, args: [...v.args.slice(0, -1), '-c', 'features.shell_tool=false', '-'] }),
    (v: CodexAdmissionContext) => ({ ...v, args: v.args.filter(a => a !== 'features.hooks=false') }),
    (v: CodexAdmissionContext) => ({ ...v, env: { ...v.env, CODEX_API_KEY: '' } }),
    (v: CodexAdmissionContext) => ({ ...v, env: { ...v.env, NODE_OPTIONS: 'SYNTHETIC-SECRET' } }),
    (v: CodexAdmissionContext) => ({ ...v, env: { ...v.env, HOME: '/foreign/home' } }),
    (v: CodexAdmissionContext) => ({ ...v, env: { ...v.env, PATH: '.' } }),
  ])('искажённый argv/env имеет configuration_conflict без утечки значений', async change => {
    const result = await admission(change(context()));
    expect(result).toMatchObject({ status: 'blocked', reason: 'configuration_conflict' });
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC-SECRET');
    expect(JSON.stringify(result)).not.toContain('/foreign/home');
  });

  it('synthetic-поля на входе не могут подтвердить production ограничения', async () => {
    const value = { ...context(), confirmed: ['shell_forbidden', 'reads_closed'],
      evidence: { provenance: 'live', status: 'passed' }, ready: true };
    expect(await admission(value)).toMatchObject({ status: 'unsupported', reason: 'cli_unsupported' });
  });

  it('ошибочный runtime-контекст даёт безопасный assessment_failed', async () => {
    expect(await admission(null as unknown as CodexAdmissionContext))
      .toMatchObject({ status: 'blocked', reason: 'assessment_failed' });
  });
});

// Для каждого профиля отдельно проверяется потеря любого обязательного элемента.
// Это повреждённые ответы доверенного оценщика, не свидетельства о реальной CLI.
describe.each([
  { kind: 'codex-read-only-v1' as const, ready: SYNTHETIC_ADMISSION,
    first: firstRequest, resume: resumeRequest },
  { kind: 'codex-sandbox-read-v1' as const, ready: SYNTHETIC_SANDBOX_ADMISSION,
    first: sandboxFirstRequest, resume: sandboxResumeRequest },
])('Codex $kind: полнота runtime-допуска', ({ kind, ready, first, resume }) => {
  if (ready.status !== 'ready') throw new Error('Ожидался synthetic ready');

  it('полные наборы допускаются независимо от порядка', () => {
    expect(checkCodexAdmission({ ...ready,
      confirmed: [...ready.confirmed].reverse(), limitations: [...ready.limitations].reverse(),
    }, kind)).toMatchObject({ reason: 'ready' });
  });

  for (const field of ['confirmed', 'limitations'] as const) {
    it.each(ready[field].map((missing, index) => ({ missing, index })))(
      `${field}: пустая позиция вместо $missing не подтверждает полный набор`, ({ index }) => {
        const values = [...ready[field]];
        delete values[index];
        expect(values).toHaveLength(ready[field].length);
        expect(Object.hasOwn(values, index)).toBe(false);
        expect(checkCodexAdmission({ ...ready, [field]: values }, kind)).toMatchObject({
          error: 'practical_admission_blocked',
          reason: field === 'confirmed' ? 'requirement_unconfirmed' : 'assessment_failed',
        });
      });

    it.each([undefined, null, 'unknown', ready[field][1]])(
      `${field}: подстановка %s вместо обязательного элемента отклоняется`, replacement => {
        const values: unknown[] = [...ready[field]];
        values[0] = replacement;
        expect(checkCodexAdmission({ ...ready, [field]: values }, kind).error)
          .toBe('practical_admission_blocked');
      });

    it.each([false, true])(`${field}: неполный ready не запускает процесс; resume=%s`, async continuing => {
      const values = [...ready[field]];
      delete values[0];
      // Node читается только для stat-проверки executable. Runner никогда не создаёт процесс.
      const start = vi.fn(() => { throw new Error('Запуск не должен быть достигнут'); });
      const assess = vi.fn(async () => ({ ...ready, [field]: values }));
      const request = (continuing ? resume : first)('/synthetic/workspace');
      const adapter = createCodexAdapter({
        env: request.env, runner: { start }, assessAdmission: assess,
        detect: async () => detection(realpathSync(process.execPath)),
        verifyThread: async () => true,
      });
      const run = await adapter.start(request);
      const events: AgentEvent[] = [];
      for await (const event of run.events) events.push(event);
      const result = await run.done;
      expect(assess).toHaveBeenCalledOnce();
      expect(start).not.toHaveBeenCalled();
      expect(result).toMatchObject({ kind: 'error', reason: 'practical_admission_blocked' });
      expect(events.filter(event => event.type === 'run_finished')).toHaveLength(1);
      expect(events.some(event => event.type === 'run_started')).toBe(false);
    });
  }

  it.each([false, true])('пустая позиция argv не считается фиксированной политикой; resume=%s', async continuing => {
    const request = (continuing ? resume : first)('/synthetic/workspace');
    const built = buildCodexArgs(request);
    const args = [...built.args];
    const index = args.indexOf('approval_policy="never"');
    expect(index).toBeGreaterThan(0);
    delete args[index];
    expect(await admission({ request, detection: detection('/synthetic/codex'), args, env: built.env }))
      .toMatchObject({ status: 'blocked', reason: 'configuration_conflict' });
  });
});
