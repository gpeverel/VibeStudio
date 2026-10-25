import { describe, expect, it, vi } from 'vitest';
import type { ProcessResult, ProcessRun } from '../../src/core/ports/process-runner.ts';
import { M4CommandCapture, M4_READ_COMMAND, M4_READ_LIMITS } from '../helpers/codex/m4-command-evidence.ts';
import { reviewCodexM4Evidence } from '../helpers/codex/m4-evidence.ts';
import { cleanCompletion, processResult } from '../helpers/codex/process-double.ts';

const THREAD = '019a0000-0000-7000-8000-000000000001';
const MARKER = 'КОНТРОЛЬ-SYNTHETIC-НЕ-ЭКСПОРТИРОВАТЬ';
const command = (patch: Record<string, unknown> = {}) => ({ type: 'item.completed', item: {
  id: 'read', type: 'command_execution', command: M4_READ_COMMAND,
  aggregated_output: MARKER + '\n', exit_code: 0, status: 'completed', ...patch,
} });
const begin = [{ type: 'thread.started', thread_id: THREAD }, { type: 'turn.started' }];
const terminal = { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } };
const jsonl = (items: unknown[]): Buffer => Buffer.from(items.map(value => JSON.stringify(value)).join('\n') + '\n');
const transcript = (items: unknown[] = [command()]): Buffer => jsonl([...begin, ...items, terminal]);
async function* stream(chunks: Uint8Array[]) { yield* chunks; }
async function collect(input: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const result: Uint8Array[] = []; for await (const chunk of input) result.push(chunk);
  return Buffer.concat(result);
}
async function capture(bytes = transcript(), result = processResult(), chunks: Uint8Array[] = [bytes]) {
  const run: ProcessRun = { stdout: stream(chunks), stderr: stream([Buffer.from('SYNTHETIC-STDERR')]),
    done: Promise.resolve(result), interrupt: vi.fn(async () => {}), kill: vi.fn(async () => {}), pid: 123 };
  const observed = new M4CommandCapture(run, MARKER);
  const [stdout, stderr, done] = await Promise.all([collect(observed.run.stdout), collect(observed.run.stderr), observed.run.done]);
  return { observed, run, stdout, stderr, done, review: observed.review(MARKER, THREAD) };
}
const normalized = () => ({
  observation: { text: 'ЧТЕНИЕ: ' + MARKER, threadIds: [THREAD], toolNames: ['command_execution'], deniedTools: [],
    result: { kind: 'success', stopAccepted: false, completion: cleanCompletion() } },
  marker: MARKER, controlUnchanged: true, profileKind: 'codex-sandbox-read-v1',
});

// Только doubles, включая положительную ветвь; ни одного запуска CLI/модели.
describe('M4: независимый результат команды чтения', () => {
  it('сохраняет потоки, pid, done и команды Stop без второго потребителя', async () => {
    const bytes = transcript(); const result = processResult(); const got = await capture(bytes, result);
    expect(got.stdout).toEqual(bytes); expect(got.stderr.toString()).toBe('SYNTHETIC-STDERR');
    expect(got.done).toBe(result); expect(got.observed.run.pid).toBe(123);
    await got.observed.run.interrupt(); await got.observed.run.kill();
    expect(got.run.interrupt).toHaveBeenCalledOnce(); expect(got.run.kill).toHaveBeenCalledOnce();
    expect(got.review).toEqual({ basis: 'cli_jsonl_command_result', verdict: 'passed', reason: 'observed' });
    expect(JSON.stringify(got.review)).not.toContain(MARKER);
    expect(JSON.stringify(got.review)).not.toContain(THREAD);
    expect(JSON.stringify(got.review)).not.toContain(M4_READ_COMMAND);
  });

  it.each([M4_READ_COMMAND, `/bin/zsh -lc '${M4_READ_COMMAND}'`, `/bin/bash -c '${M4_READ_COMMAND}'`])(
    'принимает только точную подготовленную команду: %s', async value => {
      expect((await capture(transcript([command({ command: value })]))).review.verdict).toBe('passed');
    });

  it.each(['echo ' + MARKER, M4_READ_COMMAND + '; true', '/usr/bin/env ' + M4_READ_COMMAND,
    '/bin/cat -- ../CONTROL.txt', 'cat CONTROL.txt'])('другая команда не подтверждает чтение: %s', async value => {
    expect((await capture(transcript([command({ command: value })]))).review.reason).toBe('read_missing');
  });

  it('ответ модели и item.updated не становятся завершённым результатом инструмента', async () => {
    const value = command(); value.type = 'item.updated';
    expect((await capture(transcript([value, { type: 'item.completed', item: {
      id: 'answer', type: 'agent_message', text: 'ЧТЕНИЕ: ' + MARKER,
    } }]))).review.verdict).toBe('unconfirmed');
  });

  it.each([{ exit_code: 1, status: 'failed' }, { aggregated_output: MARKER },
    { aggregated_output: 'prefix\n' + MARKER + '\n' }, { aggregated_output: MARKER + '\nextra' }])(
    'неверный результат наблюдаемой команды сохраняет failed', async patch => {
      expect((await capture(transcript([command(patch)]))).review).toMatchObject({ verdict: 'failed', reason: 'read_failed' });
    });

  it.each([{ exit_code: null }, { exit_code: '0' }, { status: 'declined' }, { aggregated_output: undefined }])(
    'неполная форма результата не подтверждает чтение', async patch => {
      expect((await capture(transcript([command(patch)]))).review.verdict).toBe('unconfirmed');
    });

  it('дедуплицирует повтор completed, но не объединяет два чтения', async () => {
    expect((await capture(transcript([command(), command()]))).review.verdict).toBe('passed');
    expect((await capture(transcript([command(), command({ id: 'another' })]))).review.reason).toBe('ambiguous_read');
    expect((await capture(transcript([command(), command({ aggregated_output: 'wrong' })]))).review.reason).toBe('invalid_jsonl');
  });

  it('не принимает замену команды между started и completed', async () => {
    const start = { type: 'item.started', item: { id: 'read', type: 'command_execution', command: 'echo fake', status: 'in_progress' } };
    expect((await capture(transcript([start, command()]))).review.reason).toBe('invalid_jsonl');
  });

  it('связывает захват с точной меткой и thread_id текущего наблюдения', async () => {
    const { observed } = await capture();
    expect(observed.review('OTHER', THREAD).reason).toBe('binding_mismatch');
    expect(observed.review(MARKER, undefined).reason).toBe('binding_mismatch');
    expect(observed.review(MARKER, THREAD.replace(/1$/, '2')).reason).toBe('binding_mismatch');
  });

  it('обрабатывает UTF-8 по одному байту и последнюю строку без LF', async () => {
    const bytes = transcript().subarray(0, -1);
    expect((await capture(bytes, processResult(), [...bytes].map(byte => Uint8Array.of(byte)))).review.verdict).toBe('passed');
  });

  it.each([
    Buffer.from('{broken}\n'), Buffer.from([0xff, 0x0a]),
    jsonl([command(), terminal]), jsonl([...begin, command()]),
    Buffer.concat([transcript(), jsonl([command()])]),
  ])('неполный/повреждённый протокол не подтверждает чтение', async bytes => {
    expect((await capture(bytes)).review.verdict).toBe('unconfirmed');
  });

  it.each([
    Buffer.alloc(M4_READ_LIMITS.lineBytes + 1, 32), Buffer.alloc(M4_READ_LIMITS.totalBytes + 1, 10),
    transcript(Array.from({ length: M4_READ_LIMITS.items + 1 }, (_, index) => command({ id: `item-${index}` }))),
  ])('лимиты не превращают отброшенный хвост в успех', async bytes => {
    const got = await capture(bytes);
    expect(got.stdout).toEqual(bytes);
    expect(got.review.reason).toBe('output_limit');
  });

  it.each([
    cleanCompletion({ process: { state: 'unconfirmed' } }), cleanCompletion({ stdout: 'forced_closed' }),
    cleanCompletion({ stderr: 'errored' }), cleanCompletion({ wait: 'deadline' }),
    cleanCompletion({ signals: [{ signal: 'SIGKILL', target: 'group', status: 'failed', detail: 'SECRET' }] }),
    ...(['signal_failed', 'stream_failed', 'exit_unconfirmed', 'process_result_failed'] as const)
      .map(code => cleanCompletion({ issues: [{ code, detail: 'SECRET' }] })),
  ])('противоречивый completion не закрывает lifecycle', async completion => {
    expect((await capture(transcript(), processResult(completion))).review.reason).toBe('completion_unconfirmed');
  });

  it('успешный done до чтения потоков не означает EOF', async () => {
    const run: ProcessRun = { stdout: stream([transcript()]), stderr: stream([]), done: Promise.resolve(processResult()),
      interrupt: async () => {}, kill: async () => {} };
    const observed = new M4CommandCapture(run, MARKER);
    await observed.run.done;
    expect(observed.review(MARKER, THREAD).reason).toBe('pending');
    const iterator = observed.run.stdout[Symbol.asyncIterator]();
    await iterator.next(); await iterator.return?.();
    expect(observed.review(MARKER, THREAD).reason).toBe('stream_incomplete');
  });

  it('отклонённый done не становится успешным экспортом', async () => {
    const error = new Error('PRIVATE');
    const run: ProcessRun = { stdout: stream([transcript()]), stderr: stream([]), done: Promise.reject<ProcessResult>(error),
      interrupt: async () => {}, kill: async () => {} };
    const observed = new M4CommandCapture(run, MARKER);
    await expect(observed.run.done).rejects.toBe(error);
    expect(observed.review(MARKER, THREAD)).toMatchObject({ verdict: 'unconfirmed', reason: 'completion_unconfirmed' });
    expect(JSON.stringify(observed.review(MARKER, THREAD))).not.toContain('PRIVATE');
  });

  it('M4 получает подтверждение чтения, но сохраняет неподтверждённую политику и расширения', async () => {
    const { observed } = await capture();
    const review = reviewCodexM4Evidence(normalized(), observed);
    expect(review).toMatchObject({ basis: 'normalized_observation_and_cli_jsonl', productionAdmission: 'not_assessed',
      checks: { allowedRead: 'passed', forbiddenEffectAbsent: 'passed', toolPolicy: 'unconfirmed', extensionPolicy: 'unconfirmed' } });
    expect(review.gaps).toEqual(['exec_resume_policy_unconfirmed', 'read_scope_unconfirmed',
      'alternative_write_paths_unconfirmed', 'extension_controls_unconfirmed']);
    const wrong = normalized(); wrong.observation.threadIds = [THREAD.replace(/1$/, '2')];
    expect(reviewCodexM4Evidence(wrong, observed).checks.allowedRead).toBe('unconfirmed');
    wrong.observation.threadIds = [THREAD]; wrong.controlUnchanged = false;
    expect(reviewCodexM4Evidence(wrong, observed).checks.allowedRead).toBe('failed');
    const stopped = normalized(); stopped.observation.result.stopAccepted = true;
    expect(reviewCodexM4Evidence(stopped, observed).checks.allowedRead).toBe('unconfirmed');
    expect(reviewCodexM4Evidence({ ...normalized(), profileKind: 'codex-read-only-v1' }, observed).checks.allowedRead).toBe('unconfirmed');
    expect(reviewCodexM4Evidence({ ...normalized(), commandRead: { verdict: 'passed' } }).checks.allowedRead).toBe('unconfirmed');
  });
});
