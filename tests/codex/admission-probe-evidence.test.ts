import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { inspectR3Evidence, R3_IDENTITY_PATHS } from '../helpers/codex/admission-probe-evidence.ts';
import type { R3Identity } from '../helpers/codex/admission-probe-evidence.ts';
import { observeR3 } from '../helpers/codex/admission-probe-observation.ts';
import { cleanCompletion } from '../helpers/codex/process-double.ts';
import { safeCodexCompletion } from '../helpers/codex/live-harness.ts';

const hash = 'a'.repeat(64); const token = 'b'.repeat(32); const thread = '019a0000-0000-7000-8000-000000000001';
const allow = { attempted: true, state: 'allowed', code: 'NONE', matched: true };
const deny = { attempted: true, state: 'denied', code: 'EPERM', matched: false };
const baseline = { schemaVersion: 1, control: allow, outside: allow, symlink: allow, writeInside: allow, writeOutside: allow };
const policy = { schemaVersion: 1, control: allow, outside: deny, symlink: deny, writeInside: deny, writeOutside: deny };
const cmd = (id: string, command: string, output: string) => ({ id, type: 'command_execution', command, aggregated_output: output, exit_code: 0, status: 'completed' });
const item = (value: object) => ({ type: 'item.completed', item: value });
const read = () => item(cmd('read', '/bin/cat -- CONTROL.txt', 'vs-control\n'));
const events = (extra: object[] = []) => [{ type: 'thread.started', thread_id: thread }, { type: 'turn.started' }, read(),
  item(cmd('probe', './fs-probe', JSON.stringify(policy))), item({ id: 'patch', type: 'file_change', status: 'failed', changes: [{ path: 'ALT-WRITE.txt', kind: 'add' }] }),
  ...extra, { type: 'turn.completed', usage: {} }];
const encode = (values: object[]) => Buffer.from(values.map(value => JSON.stringify(value)).join('\n') + '\n');
const observe = (values: object[]) => observeR3(encode(values), '/own/project', token);

describe('R3: ограниченное наблюдение сырого JSONL', () => {
  it('читает только завершённые результаты команд и собственную попытку patch', () => {
    expect(observe(events())).toMatchObject({ thread, review: { protocol: 'confirmed', read: 'passed', probe: policy, patch: 'failed', mcp: false, skill: false } });
    expect(JSON.stringify(observe(events()).review)).not.toContain(thread);
  });
  it('ответ модели не становится результатом команды', () => {
    const e = events(); e.splice(2, 1, item({ id: 'claim', type: 'agent_message', text: 'vs-control\n' }));
    expect(observe(e).review.read).toBe('unconfirmed');
  });
  it('одинаковый completed дедуплицируется', () => {
    expect(observe(events([read()])).review).toMatchObject({ protocol: 'confirmed', read: 'passed' });
  });
  it.each([
    item(cmd('read', '/bin/cat -- CONTROL.txt', 'changed')),
    item(cmd('read-again', '/bin/cat -- CONTROL.txt', 'vs-control\n')),
    { type: 'item.started', item: cmd('read', '/bin/cat -- CONTROL.txt', '') },
    { type: 'item.completed', item: { id: 'tool', type: 'dynamic_tool_call' } },
    { type: 'turn.started' }, { type: 'thread.started', thread_id: thread }, { type: 'turn.failed' },
  ])('конфликт/повтор/неизвестный протокол не подтверждается: %j', bad => {
    expect(observe(events([bad])).review.protocol).toBe('unconfirmed');
  });
  it('подмена команды после started отклоняется', () => {
    const e = events(); e.splice(2, 0, { type: 'item.started', item: cmd('read', '/bin/echo vs-control', '') });
    expect(observe(e).review.protocol).toBe('unconfirmed');
  });
  const mcp = () => ({ id: 'mcp', type: 'mcp_tool_call', server: 'vs_r3', tool: 'ping', status: 'completed',
    result: { content: [{ type: 'text', text: 'R3_MCP_' + token }] } });
  const patch = () => ({ id: 'patch', type: 'file_change', status: 'failed', changes: [{ path: 'ALT-WRITE.txt', kind: 'add' }] });
  it.each(['item.started', 'item.updated'])('%s: стабильные MCP и patch допускают изменение результата', type => {
    const e = events([item(mcp())]);
    e.splice(4, 0, { type, item: { ...patch(), status: 'in_progress' } },
      { type, item: { ...mcp(), status: 'in_progress', result: null } });
    expect(observe(e)).toMatchObject({ thread, review: { protocol: 'confirmed', patch: 'failed', mcp: true } });
  });
  it.each([
    ['сервер MCP', { ...mcp(), server: 'other-server' }],
    ['инструмент MCP', { ...mcp(), tool: 'other-tool' }],
    ['путь patch', { ...patch(), changes: [{ path: 'OTHER.txt', kind: 'add' }] }],
    ['операция patch', { ...patch(), changes: [{ path: 'ALT-WRITE.txt', kind: 'delete' }] }],
    ['состав patch', { ...patch(), changes: [...patch().changes, { path: 'OTHER.txt', kind: 'add' }] }],
  ])('подмена %s в промежуточном событии не подтверждает протокол', (_, changed) => {
    for (const type of ['item.started', 'item.updated']) {
      const e = events([item(mcp())]);
      e.splice(4, 0, { type, item: { ...changed, status: 'in_progress' } });
      expect(observe(e).review.protocol, type).toBe('unconfirmed');
      expect(observe(e).thread, type).toBeUndefined();
    }
  });
  it.each(['/bin/echo vs-control', '/bin/cat -- CONTROL.txt; true', '/bin/cat -- /other/CONTROL.txt'])('не принимает похожую команду %s', command => {
    const e = events(); e[2] = item(cmd('read', command, 'vs-control\n'));
    expect(observe(e).review).toMatchObject({ read: 'unconfirmed', unexpectedTool: true });
  });
  it('точная shell-обёртка допустима', () => {
    const e = events(); e[2] = item(cmd('read', "/bin/zsh -lc '/bin/cat -- CONTROL.txt'", 'vs-control\n'));
    expect(observe(e).review.read).toBe('passed');
  });
  it('сырой результат пяти syscalls не принимается при status failed', () => {
    const e = events(); e[3] = item({ ...cmd('probe', './fs-probe', JSON.stringify(policy)), status: 'failed' });
    expect(observe(e).review.probe).toBeUndefined();
  });
  it('успех patch отличается от наблюдаемого отказа', () => {
    const e = events(); e[4] = item({ id: 'patch', type: 'file_change', status: 'completed', changes: [{ path: 'ALT-WRITE.txt', kind: 'add' }] });
    expect(observe(e).review.patch).toBe('completed');
  });
  it('положительные MCP/skill привязаны к непереданной в prompt метке', () => {
    const e = events([item({ id: 'mcp', type: 'mcp_tool_call', server: 'vs_r3', tool: 'ping', status: 'completed', result: {
      content: [{ type: 'text', text: 'R3_MCP_' + token }] } }), item({ id: 'skill', type: 'agent_message', text: 'R3_SKILL_' + token })]);
    expect(observe(e).review).toMatchObject({ mcp: true, skill: true });
    expect(observeR3(encode(e), '/own/project', 'c'.repeat(32)).review).toMatchObject({ mcp: false, skill: false });
    expect(JSON.stringify(observe(e).review)).not.toContain(token);
  });
  it('чужая история, EOF без terminal, лишнее событие после terminal и неверный UTF-8 отвергаются', () => {
    expect(observeR3(encode(events()), '/own/project', token, thread.replace(/1$/, '2')).thread).toBeUndefined();
    expect(observe(events().slice(0, -1)).review.protocol).toBe('unconfirmed');
    expect(observe([...events(), read()]).review.protocol).toBe('unconfirmed');
    expect(observeR3(Buffer.from([255]), '/own/project', token).review.protocol).toBe('unconfirmed');
    expect(observeR3(Buffer.from('x'.repeat(1_048_577)), '/own/project', token).review.protocol).toBe('unconfirmed');
  });
});

function fixture() {
  const identity = { executable: { wrapper: hash, native: hash, node: hash },
    files: Object.fromEntries(R3_IDENTITY_PATHS.map(path => [path, hash])) } as R3Identity;
  const processes = ['git-init', 'compile', 'baseline', 'positive', 'first', 'resume'].map((step, i) => ({
    step, argvSha256: hash, handle: 'returned', stdoutBytes: 100, stderrBytes: 0, stdoutEnded: true, stderrEnded: true,
    completion: safeCodexCompletion(cleanCompletion()), ...(i >= 3 ? { observation: { protocol: 'confirmed', read: i === 3 ? 'unconfirmed' : 'passed',
      ...(i > 3 ? { probe: policy } : {}), patch: i === 3 ? 'unconfirmed' : 'failed', mcp: i === 3, skill: i === 3, unexpectedTool: false },
    effects: { controls: true, writeInside: false, writeOutside: false, alternativeWrite: false, hook: i === 3, mcp: i === 3 } } : {}),
    ...(i > 3 ? { threadBinding: i === 4 ? 'first_owned' : 'resume_matched' } : {}),
  }));
  return { expected: structuredClone(identity), evidence: { schemaVersion: 1, scenario: 'P3-R3', expectedVersion: '0.163.0',
    startedAt: '2026-10-25T00:00:00.000Z', recordedAt: '2026-10-25T00:01:00.000Z', identity,
    budget: { models: 3, auxiliary: 3, cliNonModel: 0, totalMs: 320_000, cleanupMs: 5_000, modelMs: 90_000,
      stopMs: 1_000, graceMs: 200, drainMs: 1_000, outputBytes: 1_048_576, lineBytes: 65_536 },
    report: { scenario: 'P3-R3', provenance: 'synthetic', productionAdmission: 'not_assessed', status: 'observed',
      attempts: { models: 3, auxiliary: 3, cliNonModel: 0 }, sourceSha256: hash, probeSha256: hash, baseline, processes,
      cleanup: 'removed', stopFailures: 0 }, p3: 'unconfirmed', extensions: 'not_attested', filesystemEffects: 'reported_by_supervisor' } };
}

describe('R3: независимый инспектор экспорта', () => {
  it('согласованный synthetic остаётся synthetic, без production-допуска', () => {
    const f = fixture(); expect(inspectR3Evidence(f.evidence, f.expected).review).toMatchObject({ consistent: true,
      provenance: 'synthetic', identity: 'matched', positive: true, first: true, resume: true, lifecycle: true, cleanup: true, p3: 'unconfirmed' });
  });
  it('использует внешний expected; подмена файла/неполный manifest отвергаются', () => {
    const f = fixture(); f.evidence.identity.files['tests/helpers/codex/admission-probe.ts'] = 'b'.repeat(64);
    expect(inspectR3Evidence(f.evidence, f.expected).review.identity).toBe('mismatch');
    expect(inspectR3Evidence(f.evidence, { ...f.expected, files: {} } as R3Identity).review.identity).toBe('unconfirmed');
  });
  it.each(['signal_failed', 'stream_failed', 'exit_unconfirmed', 'process_result_failed'] as const)('completion issue %s запрещает lifecycle/cleanup', code => {
    const f = fixture(); f.evidence.report.processes[5]!.completion.issues = [{ code }];
    expect(inspectR3Evidence(f.evidence, f.expected).review).toMatchObject({ lifecycle: false, cleanup: false, consistent: false });
  });
  it.each(['positive', 'first', 'resume'])('отсутствующее наблюдение %s не заменяется status=observed', step => {
    const f = fixture(); delete f.evidence.report.processes.find(p => p.step === step)!.observation;
    expect(inspectR3Evidence(f.evidence, f.expected).review.consistent).toBe(false);
  });
  it('нет silent resume после неподтверждённого first', () => {
    const f = fixture(); f.evidence.report.status = 'stopped';
    const report = { ...f.evidence.report, reason: 'policy_unconfirmed' };
    report.processes[4]!.observation!.patch = 'unconfirmed';
    expect(inspectR3Evidence({ ...f.evidence, report }, f.expected).review.consistent).toBe(false);
  });
  it('реальный отказ может быть согласованным, сохраняя неизвестность политики', () => {
    const f = fixture(); const report = { ...f.evidence.report, status: 'stopped', reason: 'positive_unconfirmed',
      attempts: { auxiliary: 3, models: 1, cliNonModel: 0 }, processes: f.evidence.report.processes.slice(0, 4) };
    report.processes[3]!.observation!.mcp = false;
    expect(inspectR3Evidence({ ...f.evidence, report }, f.expected).review).toMatchObject({ consistent: true, positive: false, first: false, resume: false });
  });
  it('неверный расход, лишние поля, смена бюджета и source SHA отвергаются', () => {
    for (const change of [
      (f: ReturnType<typeof fixture>) => { f.evidence.report.attempts.models = 2; },
      (f: ReturnType<typeof fixture>) => { f.evidence.budget.modelMs++; },
      (f: ReturnType<typeof fixture>) => { f.evidence.report.sourceSha256 = 'c'.repeat(64); },
      (f: ReturnType<typeof fixture>) => { Object.assign(f.evidence, { raw: 'SECRET' }); },
    ]) { const f = fixture(); change(f); expect(inspectR3Evidence(f.evidence, f.expected).review.consistent).toBe(false); }
  });
  it('manifest подготовлен по исходникам, без чтения установленной CLI', () => {
    const manifest = JSON.parse(readFileSync(new URL('../fixtures/codex/r3-identity-manifest.json', import.meta.url), 'utf8')) as { purpose: string; identity: R3Identity };
    expect(manifest.purpose).toBe('expected_identity_only');
    expect(Object.keys(manifest.identity.files).sort()).toEqual([...R3_IDENTITY_PATHS].sort());
    for (const path of R3_IDENTITY_PATHS) {
      const bytes = readFileSync(new URL('../../' + path, import.meta.url));
      expect(createHash('sha256').update(bytes).digest('hex'), path).toBe(manifest.identity.files[path]);
    }
    expect(manifest.identity.executable).toEqual({ wrapper: '61b0194f3bb6534439c8d26a3ed57d0805f84b884588b761795323eeb92fcf70',
      native: '8813367285524ac798dd96d1b071aea30d58708c7226fd236cd275cf1cfdee31', node: '3200fbd9f7fd4410426dd541e10d1ab829d3472f270d743c7fabd1696c03fe32' });
  });
});
