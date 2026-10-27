import { closeSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProcessRequest, ProcessRun } from '../../src/core/ports/process-runner.ts';
import { claimR3Attempt, runAdmissionProbe } from '../helpers/codex/admission-probe.ts';
import type { R3Report } from '../helpers/codex/admission-probe.ts';
import { ownDecoys, ownHook, R3_BUDGET, R3_STEPS, r3Request, researchRequest } from '../helpers/codex/admission-probe-scenario.ts';
import { buildCodexArgs } from '../../src/adapters/codex/args.ts';
import { cleanCompletion, processResult } from '../helpers/codex/process-double.ts';
import { createR3McpHandler } from '../helpers/codex/r3-mcp.mjs';

const THREAD = '019a0000-0000-7000-8000-000000000001';
const SECRET = 'SYNTHETIC-SECRET-MUST-NOT-EXPORT';
const allow = { attempted: true, state: 'allowed', code: 'NONE', matched: true };
const deny = { attempted: true, state: 'denied', code: 'EPERM', matched: false };
const baseline = { schemaVersion: 1, control: allow, outside: allow, symlink: allow, writeInside: allow, writeOutside: allow };
const policy = { schemaVersion: 1, control: allow, outside: deny, symlink: deny, writeInside: deny, writeOutside: deny };
async function* bytes(text = '') { if (text) yield Buffer.from(text); }
const stub = (text = '', patch: Partial<ProcessRun> = {}): ProcessRun => ({ stdout: bytes(text), stderr: bytes(SECRET),
  done: Promise.resolve(processResult()), kill: vi.fn(async () => {}), interrupt: vi.fn(async () => {}), ...patch });
const event = (item: object) => ({ type: 'item.completed', item });
const jsonl = (items: object[], thread = THREAD): string => [
  { type: 'thread.started', thread_id: thread }, { type: 'turn.started' }, ...items.map(event), { type: 'turn.completed', usage: {} },
].map(value => JSON.stringify(value)).join('\n') + '\n';
const command = (id: string, command: string, aggregated_output: string) => ({ id, type: 'command_execution', command, aggregated_output, status: 'completed', exit_code: 0 });
const policyItems = () => [command('read', '/bin/cat -- CONTROL.txt', 'vs-control\n'), command('probe', './fs-probe', JSON.stringify(policy)),
  { id: 'patch', type: 'file_change', changes: [{ path: 'ALT-WRITE.txt', kind: 'add' }], status: 'failed' }];
const roots = new Set<string>();
afterEach(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); roots.clear(); });
function setup(override?: (req: ProcessRequest, index: number, normal: ProcessRun) => ProcessRun) {
  const requests: ProcessRequest[] = [];
  const start = vi.fn((req: ProcessRequest) => {
    const i = requests.length; requests.push(req); roots.add(dirname(req.cwd));
    let text = '';
    if (i === 1) writeFileSync(join(req.cwd, 'fs-probe'), 'synthetic-binary', { mode: 0o700 });
    if (i === 2) {
      writeFileSync(join(req.cwd, 'NEW.txt'), 'x'); writeFileSync(join(req.cwd, '../outside/WRITE-TARGET'), 'x');
      text = JSON.stringify(baseline);
    }
    if (i === 3) {
      const skill = readFileSync(join(req.cwd, '.agents/skills/vs-r3-skill/SKILL.md'), 'utf8');
      const token = /R3_SKILL_([a-f0-9]{32})/.exec(skill)![1]!;
      writeFileSync(join(req.cwd, 'HOOK.marker'), token); writeFileSync(join(req.cwd, 'MCP.marker'), token);
      text = jsonl([{ id: 'mcp', type: 'mcp_tool_call', server: 'vs_r3', tool: 'ping', status: 'completed', error: null,
        result: { content: [{ type: 'text', text: 'R3_MCP_' + token }] } },
      { id: 'skill', type: 'agent_message', text: 'R3_SKILL_' + token }]);
    }
    if (i > 3) text = jsonl(policyItems());
    return override?.(req, i, stub(text)) ?? stub(text);
  });
  const run = (patch: Partial<Parameters<typeof runAdmissionProbe>[0]> = {}) => runAdmissionProbe({ runner: { start },
    executable: '/synthetic/codex-never-start', node: '/synthetic/node', provenance: 'synthetic',
    env: { HOME: SECRET, PATH: '/synthetic/bin', NODE_OPTIONS: SECRET }, cleanupMs: 10, ...patch });
  return { run, start, requests };
}

describe('R3: конечный набор, отдельный от production и R2', () => {
  it('повторный вход закрыт даже после сбоя до первого дочернего процесса', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'vs-r3-lock-test-'))); roots.add(root);
    const claim = claimR3Attempt(root); closeSync(claim.fd);
    const path = join(root, 'p3-r3-attempt.json');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ state: 'preflight', attempts: { models: 0, auxiliary: 0 } });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(() => claimR3Attempt(root)).toThrow();
    expect(JSON.parse(readFileSync(path, 'utf8')).startedAt).toBe(claim.startedAt);
  });
  it('оба research argv побайтово соответствуют production и не включают диагностику', () => {
    for (const step of ['first', 'resume'] as const) {
      const thread = step === 'resume' ? THREAD : undefined;
      const request = r3Request(step, '/codex', '/node', '/project', {}, thread);
      expect(request.args).toEqual(buildCodexArgs(researchRequest('/project', {}, thread)).args);
      expect(request.args).not.toContain('--sandbox'); expect(request.args).not.toContain('--last');
      expect(request.args).toContain('--strict-config'); expect(request.timeoutMs).toBe(90_000);
    }
    expect(() => r3Request('resume', '/codex', '/node', '/project', {})).toThrow();
    expect(R3_STEPS).toEqual(['git-init', 'compile', 'baseline', 'positive', 'first', 'resume']);
    expect(R3_BUDGET).toMatchObject({ models: 3, auxiliary: 3, cliNonModel: 0, totalMs: 320_000, cleanupMs: 5_000 });
  });
  it('положительный hook получает только собственное доверие без глобального bypass', () => {
    const project = "/tmp/own ' quoted";
    const hook = ownHook(project, '/node');
    expect(hook.key).toBe(project + '/.codex/hooks.json:user_prompt_submit:0:0');
    expect(hook.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(ownHook(project, '/other-node').hash).not.toBe(hook.hash);
    const req = r3Request('positive', '/codex', '/node', project, {});
    expect(req.args).toContain('features.hooks=true'); expect(req.args).not.toContain('features.hooks=false');
    expect(req.args).not.toContain('--dangerously-bypass-hook-trust');
    expect(req.args.filter(a => a.startsWith('hooks.state.'))).toHaveLength(1);
    const files = ownDecoys(project, '/node', 'a'.repeat(32));
    expect(files['.codex/hooks.json']).toContain('UserPromptSubmit');
    expect(req.stdin).not.toContain('R3_SKILL_' + 'a'.repeat(32));
  });
  it('шесть подтверждённых doubles, безопасный отчёт и своя история', async () => {
    const { run, requests } = setup(); const saved: R3Report[] = [];
    const result = await run({ checkpoint: r => saved.push(r) });
    expect(result.status).toBe('observed'); expect(result.cleanup).toBe('removed');
    expect(result.attempts).toEqual({ auxiliary: 3, models: 3, cliNonModel: 0 });
    expect(result.provenance).toBe('synthetic'); expect(result.productionAdmission).toBe('not_assessed');
    expect(result.processes[4]?.threadBinding).toBe('first_owned'); expect(result.processes[5]?.threadBinding).toBe('resume_matched');
    expect(requests[5]!.args.slice(-2)).toEqual([THREAD, '-']);
    expect(requests.every(r => r.env.HOME === SECRET && r.env.NODE_OPTIONS === undefined)).toBe(true);
    expect(JSON.stringify(saved)).not.toContain(SECRET); expect(JSON.stringify(saved)).not.toContain(THREAD);
    expect(JSON.stringify(saved)).not.toContain(requests[0]!.cwd); expect(existsSync(dirname(requests[0]!.cwd))).toBe(false);
    expect(saved.at(-1)).toEqual(result);
  });
  it('провал baseline запрещает все модели', async () => {
    const s = setup((_, i, normal) => i === 2 ? stub(JSON.stringify(policy)) : normal);
    expect(await s.run()).toMatchObject({ reason: 'baseline_failed', attempts: { auxiliary: 3, models: 0 }, cleanup: 'removed' });
  });
  it.each(['hook', 'mcp', 'skill'])('нет реального положительного контроля %s — first/resume запрещены', async missing => {
    const s = setup((req, i, normal) => {
      if (i !== 3) return normal;
      if (missing === 'skill') return stub(jsonl([]));
      rmSync(join(req.cwd, missing === 'hook' ? 'HOOK.marker' : 'MCP.marker'));
      return normal;
    });
    expect(await s.run()).toMatchObject({ reason: 'positive_unconfirmed', attempts: { models: 1 }, cleanup: 'removed' });
    expect(s.start).toHaveBeenCalledTimes(4);
  });
  it.each(['NEW.txt', '../outside/WRITE-TARGET', 'ALT-WRITE.txt', 'HOOK.marker', 'MCP.marker'])('наблюдаемый запрещённый эффект %s останавливает resume', async path => {
    const s = setup((req, i, normal) => { if (i === 4) writeFileSync(join(req.cwd, path), 'x'); return normal; });
    expect(await s.run()).toMatchObject({ reason: 'policy_failed', attempts: { models: 2 }, cleanup: 'removed' });
  });
  it.each([0, 1, 2])('пропущенный результат операции %s нельзя заменить успешным exit', async missing => {
    const s = setup((_, i, normal) => i === 4 ? stub(jsonl(policyItems().filter((_, n) => n !== missing))) : normal);
    expect(await s.run()).toMatchObject({ reason: 'policy_unconfirmed', attempts: { models: 2 } });
  });
  it.each(['outside', 'symlink', 'writeInside', 'writeOutside'])('сообщённый успех запрещённой операции %s — отрицательный результат', async operation => {
    const s = setup((_, i, normal) => {
      if (i !== 4) return normal;
      const items = policyItems(); items[1] = command('probe', './fs-probe', JSON.stringify({ ...policy, [operation]: allow }));
      return stub(jsonl(items));
    });
    expect(await s.run()).toMatchObject({ status: 'stopped', reason: 'policy_failed', attempts: { models: 2 } });
  });
  it.each(['signal_failed', 'stream_failed', 'exit_unconfirmed', 'process_result_failed'] as const)('противоречивый completion %s не подтверждает cleanup', async code => {
    const s = setup((_, i, normal) => i === 0 ? { ...normal, done: Promise.resolve(processResult(cleanCompletion({ issues: [{ code, detail: SECRET }] }))) } : normal);
    expect(await s.run()).toMatchObject({ reason: 'lifecycle', cleanup: 'retained', attempts: { auxiliary: 1, models: 0 } });
  });
  it('nonzero с подтверждённым exit/EOF допускает только cleanup', async () => {
    const s = setup((_, i, normal) => i === 0 ? { ...normal,
      done: Promise.resolve(processResult(cleanCompletion({ process: { state: 'exited', exitCode: 2, signal: null } }))) } : normal);
    expect(await s.run()).toMatchObject({ reason: 'lifecycle', cleanup: 'removed' });
  });
  it('pending done ограничен надзором и cleanup; Stop вызван', async () => {
    const kill = vi.fn(async () => {});
    const s = setup((_, i, normal) => i === 0 ? { ...normal, kill, done: new Promise(() => {}) } : normal);
    expect(await s.run({ deadlineMs: 15, cleanupMs: 5 })).toMatchObject({ reason: 'deadline', cleanup: 'retained' });
    expect(kill).toHaveBeenCalledTimes(1); expect(s.start).toHaveBeenCalledTimes(1);
  });
  it('Stop прекращает остаток и не выдумывает завершение потомка', async () => {
    const controller = new AbortController();
    const s = setup((_, i, normal) => { if (i === 0) controller.abort(); return normal; });
    expect(await s.run({ signal: controller.signal })).toMatchObject({ status: 'stopped', reason: 'cancelled', attempts: { models: 0 } });
    expect(s.start).toHaveBeenCalledTimes(1);
  });
  it('изменение identity до positive не расходует модель', async () => {
    const s = setup(); let checks = 0;
    expect(await s.run({ beforeStart: () => ++checks < 4 })).toMatchObject({ reason: 'identity_changed', attempts: { models: 0 } });
  });
  it('изменение бинарника внутри последнего шага не становится успехом', async () => {
    const s = setup((req, i, normal) => { if (i === 5) writeFileSync(join(req.cwd, 'fs-probe'), 'changed'); return normal; });
    expect(await s.run()).toMatchObject({ status: 'stopped', reason: 'identity_changed', attempts: { models: 3 } });
  });
  it('исключение старта не позволяет удалять лабораторию с неизвестным потомком', async () => {
    const s = setup(() => { throw new Error(SECRET); });
    expect(await s.run()).toMatchObject({ reason: 'launch_failed', cleanup: 'retained' });
  });
  it('ошибка checkpoint запрещает запуск', async () => {
    const s = setup();
    expect(await s.run({ checkpoint: () => { throw new Error(SECRET); } })).toMatchObject({ reason: 'evidence_failed', attempts: { models: 0, auxiliary: 0 } });
    expect(s.start).not.toHaveBeenCalled();
  });
  it('stdout limit прерывает модель и не подтверждает EOF', async () => {
    const s = setup((_, i, normal) => i === 3 ? stub('x'.repeat(65_537)) : normal);
    expect(await s.run()).toMatchObject({ reason: 'output_limit', cleanup: 'retained', attempts: { models: 1 } });
  });
  it('resume другой истории отклоняется без повторов', async () => {
    const s = setup((_, i, normal) => i === 5 ? stub(jsonl(policyItems(), THREAD.replace(/1$/, '2'))) : normal);
    expect(await s.run()).toMatchObject({ reason: 'policy_unconfirmed', attempts: { models: 3 } });
  });
  it('нельзя расширить бюджет опциями или передать новый API key', async () => {
    const s = setup(); await expect(s.run({ deadlineMs: 320_001 })).rejects.toThrow();
    expect(await s.run({ env: { CODEX_API_KEY: SECRET } })).toMatchObject({ reason: 'preparation_failed', cleanup: 'not_created' });
    expect(s.start).not.toHaveBeenCalled();
  });
});

describe('R3 MCP: настоящий обмен stdio без запуска CLI', () => {
  it('initialize → initialized → tools/list → tools/call, маркер только при вызове инструмента', () => {
    const called = vi.fn(); const handle = createR3McpHandler('a'.repeat(32), called);
    expect(handle({ jsonrpc: '2.0', id: 0, method: 'tools/call', params: { name: 'ping' } })).toHaveProperty('error');
    expect(handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })).toMatchObject({ result: { protocolVersion: '2025-03-26', capabilities: { tools: {} } } });
    expect(handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeUndefined();
    expect(handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).toMatchObject({ result: { tools: [{ name: 'ping' }] } });
    expect(called).not.toHaveBeenCalled();
    expect(handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ping', arguments: {} } }))
      .toMatchObject({ result: { content: [{ text: 'R3_MCP_' + 'a'.repeat(32) }] } });
    expect(called).toHaveBeenCalledTimes(1);
    expect(handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'other' } })).toHaveProperty('error');
    expect(called).toHaveBeenCalledTimes(1);
  });
});
