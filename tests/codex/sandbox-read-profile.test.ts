import { realpathSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildCodexArgs } from '../../src/adapters/codex/args.ts';
import type { CodexAdmission, CodexAdmissionContext, CodexRunRequest } from '../../src/adapters/codex/contracts.ts';
import { createCodexAdapter } from '../../src/adapters/codex/index.ts';
import { createCodexProductionAdmission, validateCodexProfile } from '../../src/adapters/codex/profile.ts';
import type { AgentEvent } from '../../src/core/ports/agent.ts';
import type { ProcessRequest } from '../../src/core/ports/process-runner.ts';
import { expectedCodexLaunches } from '../helpers/codex/live-plan.ts';
import { processResult } from '../helpers/codex/process-double.ts';
import { detection, firstRequest, sandboxFirstRequest, sandboxProfile, sandboxResumeRequest,
  SYNTHETIC_ADMISSION, SYNTHETIC_SANDBOX_ADMISSION, THREAD } from '../helpers/codex/requests.ts';

const CWD = '/synthetic/workspace with spaces';
const requirements = ['shell_sandboxed', 'reads_scoped', 'writes_forbidden', 'project_extensions_disabled', 'user_extensions_disabled'];
const admission = createCodexProductionAdmission();
function context(resume = false): CodexAdmissionContext {
  const request = resume ? sandboxResumeRequest(CWD) : sandboxFirstRequest(CWD);
  const built = buildCodexArgs(request);
  return { request, detection: detection('/synthetic/codex'), args: built.args, env: built.env };
}
async function* bytes(value: string) { if (value) yield Buffer.from(value); }

/** Ни CLI, ни fake executable: настоящий адаптер получает потоки и completion doubles.
 * realpath Node используется только для проверки stat/executable, процесс не стартует. */
async function route(request: CodexRunRequest, ready: CodexAdmission, tool = 'command_execution') {
  const starts: ProcessRequest[] = [];
  const events: AgentEvent[] = [];
  const stdout = [
    { type: 'thread.started', thread_id: THREAD },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'tool', type: tool, status: 'completed', exit_code: 0 } },
    { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } },
  ].map(value => JSON.stringify(value)).join('\n') + '\n';
  const adapter = createCodexAdapter({
    env: request.env, detect: async () => detection(realpathSync(process.execPath)), assessAdmission: async () => ready,
    runner: { start(value) {
      starts.push(value);
      return { stdout: bytes(stdout), stderr: bytes(''), done: Promise.resolve(processResult()),
        interrupt: async () => {}, kill: async () => {} };
    } },
  });
  const run = await adapter.start(request);
  for await (const event of run.events) events.push(event);
  const result = await run.done;
  const terminals = events.filter(event => event.type === 'run_finished');
  expect(terminals).toHaveLength(1);
  expect(terminals[0]!.result).toBe(result);
  return { result, events, starts };
}

describe('Codex sandbox-read: отдельный контракт и независимый отказ production', () => {
  it.each([false, true])('канонический first/resume manifest без legacy override; resume=%s', resume => {
    const value = context(resume);
    expect(validateCodexProfile(value.request.profile, CWD)).toEqual([]);
    expect(value.args).toEqual(expectedCodexLaunches('/synthetic/codex', value.request)[4]!.args);
    expect(value.args.filter(arg => arg.startsWith('default_permissions='))).toEqual(['default_permissions="vibestudio-read-v1"']);
    expect(value.args).toContain('permissions.vibestudio-read-v1.filesystem={":root"="deny",":minimal"="read",":workspace_roots"={"."="read"}}');
    for (const forbidden of ['--sandbox', 'sandbox_mode="read-only"', '--full-auto', '--dangerously-bypass-approvals-and-sandbox']) {
      expect(value.args).not.toContain(forbidden);
    }
    expect(value.args).toContain('project_doc_max_bytes=0');
    expect(value.args).toContain('features.plugins=false');
    expect(value.args).toContain('features.shell_tool=true');
  });

  it.each([false, true])('полный интерфейс оставляет пять конкретных gaps, без ready; resume=%s', async resume => {
    const result = await admission(context(resume));
    expect(result).toMatchObject({ status: 'blocked', reason: 'requirement_unconfirmed' });
    expect(result.requirements.map(gap => gap.requirement)).toEqual(requirements);
    expect(result.requirements.map(gap => gap.code)).toEqual([
      resume ? 'resume_permissions_unconfirmed' : 'sandbox_effective_policy_unconfirmed',
      'sandbox_read_scope_unconfirmed', 'non_shell_write_policy_unconfirmed',
      'project_extension_controls_unconfirmed', 'user_extension_controls_unconfirmed',
    ]);
    expect(result.requirements.every(gap => gap.status === 'unconfirmed' && gap.sources.length > 0)).toBe(true);
  });

  it.each(['strictConfig', 'resumeStrictConfig'] as const)('отсутствующее объявление %s отличается от неизвестного', async key => {
    const value = context(key === 'resumeStrictConfig');
    const absent = { ...value, detection: { ...value.detection, capabilities: { ...value.detection.capabilities, [key]: false } } };
    expect(await admission(absent)).toMatchObject({ status: 'unsupported', reason: 'cli_unsupported' });
    const unknown = structuredClone(value);
    delete (unknown.detection.capabilities as Partial<typeof unknown.detection.capabilities>)[key];
    expect(await admission(unknown)).toMatchObject({ status: 'blocked', reason: 'requirement_unconfirmed' });
  });

  it.each(requirements)('требование %s нельзя удалить из нового профиля', requirement => {
    const profile = sandboxProfile(CWD);
    expect(validateCodexProfile({ ...profile, requires: profile.requires.filter(value => value !== requirement) }, CWD).length)
      .toBeGreaterThan(0);
  });

  it.each([
    { sandbox: 'read-only' }, { sandbox: 'workspace-write' }, { approvalPolicy: 'on-request' },
    { workspaceRoot: '/foreign' }, { tools: ['Bash'] }, { requires: ['shell_forbidden', 'reads_closed'] },
  ])('новый профиль не принимает смешанные и ослабленные поля: %j', patch => {
    expect(validateCodexProfile({ ...sandboxProfile(CWD), ...patch }, CWD).length).toBeGreaterThan(0);
  });

  it.each([
    ['--sandbox', 'read-only'], ['-c', 'sandbox_mode="read-only"'],
    ['-c', 'features.shell_tool=false'], ['-c', 'features.hooks=true'],
    ['-c', 'default_permissions="other"'], ['-c', 'default_permissions="vibestudio-read-v1"'],
    ['-c', 'project_doc_max_bytes=4096'], ['--dangerously-bypass-hook-trust'],
  ].map(extra => ({ extra })))('лишние overrides не проходят production: $extra', async ({ extra }) => {
    const value = context();
    expect(await admission({ ...value, args: [...value.args.slice(0, -1), ...extra, '-'] }))
      .toMatchObject({ status: 'blocked', reason: 'configuration_conflict' });
  });

  it.each(['CODEX_API_KEY', 'NODE_OPTIONS', 'APP_SECRET'])('лишнее окружение %s не разрешается новым профилем', async name => {
    const value = context();
    const result = await admission({ ...value, env: { ...value.env, [name]: 'SYNTHETIC-SECRET' } });
    expect(result).toMatchObject({ status: 'blocked', reason: 'configuration_conflict' });
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC-SECRET');
  });

  it('внешние claims об R2/synthetic admission не превращаются в production ready', async () => {
    const value = { ...context(), evidence: { scenario: 'P3-R2', provenance: 'live', status: 'observed' },
      confirmed: requirements, ready: true };
    expect(await admission(value)).toMatchObject({ status: 'blocked', reason: 'requirement_unconfirmed' });
  });

  it('разрешение shell ограничено новым профилем и не ослабляет старый', async () => {
    const named = await route(sandboxFirstRequest(CWD), SYNTHETIC_SANDBOX_ADMISSION);
    expect(named.result.kind).toBe('success');
    expect(named.events.some(event => event.type === 'tool_started' && event.tool === 'command_execution')).toBe(true);
    const legacy = await route(firstRequest(CWD), SYNTHETIC_ADMISSION);
    expect(legacy.result).toMatchObject({ kind: 'error', reason: 'runtime_inventory_mismatch' });
  });

  it.each(['file_change', 'mcp_tool_call', 'collab_tool_call', 'web_search'])(
    'новый synthetic допуск не разрешает %s', async tool => {
      expect((await route(sandboxFirstRequest(CWD), SYNTHETIC_SANDBOX_ADMISSION, tool)).result)
        .toMatchObject({ kind: 'error', reason: 'runtime_inventory_mismatch' });
    });

  it('неизвестный dynamic_tool_call отклоняется новым профилем, legacy сохраняет диагностическое игнорирование', async () => {
    const named = await route(sandboxFirstRequest(CWD), SYNTHETIC_SANDBOX_ADMISSION, 'dynamic_tool_call');
    expect(named.result).toMatchObject({ kind: 'error', reason: 'runtime_inventory_unknown' });
    expect(named.events.some(event => event.type === 'tool_started')).toBe(false);
    const legacy = await route(firstRequest(CWD), SYNTHETIC_ADMISSION, 'dynamic_tool_call');
    expect(legacy.result.kind).toBe('success');
    expect(legacy.events.some(event => event.type === 'tool_started')).toBe(false);
  });

  it('ready старого профиля не удовлетворяет новый и наоборот', async () => {
    for (const [request, ready] of [
      [sandboxFirstRequest(CWD), SYNTHETIC_ADMISSION],
      [firstRequest(CWD), SYNTHETIC_SANDBOX_ADMISSION],
    ] as const) {
      const result = await route(request, ready);
      expect(result.result).toMatchObject({ kind: 'error', reason: 'practical_admission_blocked' });
      expect(result.starts).toHaveLength(0);
    }
  });

  it('неизвестная история нового профиля отклоняется без скрытого первого хода', async () => {
    const value = await route(sandboxResumeRequest(CWD), SYNTHETIC_SANDBOX_ADMISSION);
    expect(value.result).toMatchObject({ kind: 'error', reason: 'invalid_request' });
    expect(value.starts).toHaveLength(0);
    expect(value.events.some(event => event.type === 'run_started')).toBe(false);
  });
});
