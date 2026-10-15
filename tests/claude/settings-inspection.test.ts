import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INSPECTION_BUDGET as B, inspectSettings } from '../helpers/claude/settings-inspection.ts';
import type { InspectionChild } from '../helpers/claude/settings-inspection.ts';
import { syntheticInit } from '../helpers/claude/practical-evidence.ts';

/** Все ответы и handles ниже — synthetic transport doubles, НЕ реальные CLI fixtures.
 * Проверяется лишь механизм по статическим схемам Nkr/IF/PY; совместимость argv не проверяется.
 */
const initPayload = () => ({ commands: [], agents: [], output_style: 'normal', available_output_styles: ['normal'],
  models: [], account: { secret: 'SECRET-account' } });
const settingsPayload = () => ({ effective: { env: { SECRET: 'SECRET-value' } }, sources: [],
  applied: { model: 'SECRET-model', effort: null } });
const success = (id: string, payload: unknown, patch: Record<string, unknown> = {}) => ({ type: 'control_response', response: {
  subtype: 'success', request_id: id, response: payload, pending_permission_requests: [], pending_user_dialog_requests: [], ...patch,
} });
const init = (payload: unknown = initPayload(), patch: Record<string, unknown> = {}) => success('p2b-policy-init', payload, patch);
const settings = (payload: unknown = settingsPayload(), patch: Record<string, unknown> = {}) => success('p2b-policy-read', payload, patch);
const line = (...values: unknown[]) => Buffer.from(values.map(value => JSON.stringify(value)).join('\n') + '\n');
const flush = () => vi.advanceTimersByTimeAsync(0);
function double(options: { holdWrite?: boolean | number; holdFinish?: boolean; ignoreKill?: boolean; signalError?: string; falseKill?: boolean } = {}) {
  const emitter = new EventEmitter();
  const stdout = new PassThrough(), stderr = new PassThrough();
  const writes: string[] = [], callbacks: ((error?: Error | null) => void)[] = [], finals: ((error?: Error | null) => void)[] = [];
  const stdin = new Writable({ write(chunk: Buffer, _encoding, callback) {
    writes.push(chunk.toString('utf8'));
    if (options.holdWrite === true || options.holdWrite === writes.length) callbacks.push(callback); else callback();
  }, final(callback) { if (options.holdFinish) finals.push(callback); else callback(); } });
  const exit = (code: number | null = 0, signal: string | null = null, end = true) => {
    emitter.emit('exit', code, signal);
    if (end) { stdout.end(); stderr.end(); }
  };
  const kill = vi.fn((signal: string) => {
    if (options.signalError) throw Object.assign(new Error('SECRET-signal'), { code: options.signalError });
    if (!options.ignoreKill) queueMicrotask(() => exit(null, signal));
    return !options.falseKill;
  });
  const child = Object.assign(emitter, { stdin, stdout, stderr, pid: 12345, kill, unref: vi.fn() }) as unknown as InspectionChild;
  const spawn = vi.fn(() => child);
  const run = inspectSettings(spawn);
  const acceptInit = async () => { stdout.write(line(init())); await flush(); };
  const observe = async (payload: unknown = settingsPayload()) => { await acceptInit(); stdout.write(line(settings(payload))); await flush(); };
  return { child, emitter, stdout, stderr, stdin, writes, callbacks, finals, exit, kill, spawn, run, acceptInit, observe };
}
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }); });
afterEach(() => { vi.useRealTimers(); });

describe('get_settings: synthetic transport, без разрешения CLI', () => {
  it('создаёт один handle, посылает ровно два запроса по порядку и закрывает stdin без prompt', async () => {
    const h = double();
    expect(h.writes.map(text => JSON.parse(text))).toEqual([{ type: 'control_request', request_id: 'p2b-policy-init', request: { subtype: 'initialize' } }]);
    await h.observe();
    expect(h.writes.map(text => JSON.parse(text))).toEqual([
      { type: 'control_request', request_id: 'p2b-policy-init', request: { subtype: 'initialize' } },
      { type: 'control_request', request_id: 'p2b-policy-read', request: { subtype: 'get_settings' } },
    ]);
    expect(h.stdin.writableEnded).toBe(true);
    h.exit(); await flush(); const result = await h.run.done;
    expect(result).toMatchObject({ cliCompatibility: 'unconfirmed', outcome: 'observed', initialize: 'accepted', getSettings: 'accepted',
      sessionState: 'unknown', inventoryObserved: false, settings: { policySettings: 'absent_unknown', executableKeysPresent: ['env'] },
      completion: { process: { state: 'exited', exitCode: 0, signal: null }, stdout: 'ended', stderr: 'ended', wait: 'settled', issues: [], descendants: 'not_guaranteed' } });
    expect(h.spawn).toHaveBeenCalledTimes(1); expect(h.kill).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    expect(JSON.stringify(result)).not.toContain('SECRET'); expect(result).not.toHaveProperty('ready');
  });

  it.each(['absent', 'empty', 'nonempty'] as const)('errors=%s сохраняется отдельно от observed и completeness', async form => {
    const h = double(); const payload: Record<string, unknown> = { effective: {}, sources: [] };
    if (form !== 'absent') payload.errors = form === 'empty' ? [] : [{ file: 'SECRET-path', message: 'SECRET-error' }];
    await h.observe(payload); h.exit(); await flush();
    const report = await h.run.done;
    expect(report.settings?.applied).toBe('absent');
    expect(report.settings?.errors).toEqual(form === 'absent' ? { presence: 'absent' } : { presence: 'present', count: form === 'empty' ? 0 : 1 });
    expect(report.cliCompatibility).toBe('unconfirmed'); expect(JSON.stringify(report)).not.toContain('SECRET');
  });

  it('policySettings:{} означает лишь наличие записи; неизвестные ключи и значения не раскрываются', async () => {
    const h = double(); await h.observe({ effective: { 'SECRET-key': true }, sources: [{ source: 'policySettings', settings: {} }] });
    h.exit(); await flush(); expect((await h.run.done).settings).toEqual({ effective: 'object', sources: ['policySettings'],
      policySettings: 'present', applied: 'absent', errors: { presence: 'absent' }, executableKeysPresent: [] });
  });

  it.each([
    ['верхний id', { type: 'control_response', request_id: 'p2b-policy-init', response: { subtype: 'success', response: initPayload() } }],
    ['чужой id', success('SECRET-id', initPayload())],
    ['повтор init', [init(), init()]],
    ['предварительный settings', [init(), settings()]],
    ['ответ до init', settings()],
    ['обязательный control', { type: 'control_request', request: { subtype: 'SECRET-subtype' } }],
    ['cancel', { type: 'control_cancel_request', request_id: 'p2b-policy-init' }],
    ['модельное событие', [init(), { type: 'assistant', content: 'SECRET' }]],
  ])('%s останавливает последовательность без позднего get_settings', async (_label, values) => {
    const h = double(); h.stdout.write(line(...(Array.isArray(values) ? values : [values]))); await flush();
    const report = await h.run.done;
    expect(report.outcome).not.toBe('observed'); expect(h.writes).toHaveLength(1);
    expect(h.spawn).toHaveBeenCalledTimes(1); expect(JSON.stringify(report)).not.toContain('SECRET');
  });

  it('принимает совпадающий read id только после фактической отправки, а не после await write', async () => {
    const h = double({ holdWrite: true }); h.stdout.write(line(init()));
    h.stdout.write(line(settings())); h.callbacks[0]!(); await flush();
    expect((await h.run.done).reasons).toContain('premature_response'); expect(h.writes).toHaveLength(1);
  });

  it.each([
    { pending_permission_requests: undefined }, { pending_user_dialog_requests: undefined },
    { pending_permission_requests: {} }, { pending_permission_requests: [{ input: 'SECRET' }] },
    { pending_user_dialog_requests: [{ request_id: 'SECRET' }] },
  ])('не заменяет отсутствующий/непустой pending пустым массивом: %j', async patch => {
    const h = double(); h.stdout.write(line(init(initPayload(), patch))); await flush();
    expect((await h.run.done).outcome).not.toBe('observed'); expect(h.writes).toHaveLength(1);
  });

  it.each(['running', 'requires_action', 'SECRET-state'])('session_state=%s запрещает второй запрос', async state => {
    const h = double(); h.stdout.write(line(init({ ...initPayload(), session_state: state }))); await flush();
    expect((await h.run.done).outcome).not.toBe('observed'); expect(h.writes).toHaveLength(1);
  });

  it.each(['commands', 'agents', 'output_style', 'available_output_styles', 'models', 'account'])('отсутствующее обязательное initialize.%s — отказ', async key => {
    const payload: Record<string, unknown> = initPayload(); delete payload[key];
    const h = double(); h.stdout.write(line(init(payload))); await flush();
    expect((await h.run.done).reasons).toContain('protocol_unknown'); expect(h.writes).toHaveLength(1);
  });

  it.each([
    {}, { effective: {}, sources: null }, { effective: [], sources: [] }, { effective: {}, sources: [{ source: 'SECRET', settings: {} }] },
    { effective: {}, sources: [], applied: null }, { effective: {}, sources: [], applied: { model: 'x', effort: { toString: 'SECRET' } } },
    { effective: {}, sources: [], errors: {} }, { effective: {}, sources: [{ source: 'policySettings', settings: {} }, { source: 'policySettings', settings: {} }] },
  ])('повреждённый settings payload не даёт наблюдение: %j', async payload => {
    const h = double(); await h.acceptInit(); h.stdout.write(line(settings(payload))); await flush();
    const report = await h.run.done; expect(report.reasons).toContain('protocol_unknown'); expect(report.settings).toBeUndefined();
    expect(JSON.stringify(report)).not.toContain('SECRET');
  });

  it('допустимый error get_settings не вызывает переподключения и не раскрывает текст', async () => {
    const h = double(); await h.acceptInit();
    h.stdout.write(line({ type: 'control_response', response: { subtype: 'error', request_id: 'p2b-policy-read', error: 'SECRET get_settings is not available on this connection' } }));
    await flush(); const result = await h.run.done;
    expect(result.getSettings).toBe('rejected'); expect(result.reasons).toContain('request_rejected');
    expect(result.stopAccepted).toBe(false); expect(h.writes).toHaveLength(2); expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('побайтовая UTF-8/JSONL и последнее сообщение без LF читаются без подмены символов', async () => {
    const h = double();
    for (const byte of line(init({ ...initPayload(), output_style: 'русский' }))) h.stdout.write(Buffer.from([byte]));
    await flush(); const payload = JSON.stringify(settings());
    for (const byte of Buffer.from(payload)) h.stdout.write(Buffer.from([byte]));
    h.exit(); await flush(); expect((await h.run.done).outcome).toBe('observed');
  });

  it.each([Buffer.from('SECRET not json\n'), Buffer.from([0xc3, 0x28, 10]), Buffer.from('{"SECRET":')])('неполный/не-JSON/битый UTF-8 не становится ответом', async bytes => {
    const h = double(); h.stdout.write(bytes); h.stdout.end(); await flush();
    const result = await h.run.done; expect(result.reasons).toContain('protocol_unknown'); expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('не отправляет get_settings, пока после initialize остаётся неполная строка', async () => {
    const h = double(); h.stdout.write(Buffer.concat([line(init()), Buffer.from('{"type":"assistant"')])); await flush();
    expect(h.writes).toHaveLength(1); h.stdout.write(Buffer.from('}\n')); await flush();
    expect((await h.run.done).reasons).toContain('unexpected_event'); expect(h.writes).toHaveLength(1);
  });

  it('отклоняет ответ get_settings, начавшийся до запроса и завершившийся следующим chunk', async () => {
    const h = double(); const reply = line(settings());
    h.stdout.write(Buffer.concat([line(init()), reply.subarray(0, 31)])); await flush();
    expect(h.writes).toHaveLength(1);
    h.stdout.write(reply.subarray(31)); await flush();
    const report = await h.run.done;
    expect(report.reasons).toContain('premature_response'); expect(report.getSettings).toBe('not_sent');
    expect(h.writes).toHaveLength(1); expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(report)).not.toContain('SECRET');
  });

  it('граница строки учитывается по байтам, до декодирования', async () => {
    const h = double(); h.stdout.write(Buffer.alloc(B.line, 0xc3)); await flush(); expect(h.kill).not.toHaveBeenCalled();
    h.stdout.write(Buffer.from([0xc3])); await flush();
    expect((await h.run.done).reasons).toContain('output_limit');
  });

  it('совокупный stdout+stderr учитывает незавершённый UTF-8 и не усекает его в валидный ответ', async () => {
    const h = double(); h.stderr.write(Buffer.alloc(B.output - 1)); h.stdout.write(Buffer.from([0xc3])); await flush();
    expect(h.kill).not.toHaveBeenCalled(); h.stderr.write(Buffer.from([0])); await flush();
    const report = await h.run.done; expect(report.reasons).toContain('output_limit');
    expect(report.stdoutBytes + report.stderrBytes).toBe(B.output + 1);
  });

  it.each(['model', 'stream', 'output'] as const)('поздний %s после settings не теряется до completion', async kind => {
    const h = double(); await h.observe();
    if (kind === 'model') h.stdout.write(line({ type: 'assistant', content: 'SECRET' }));
    if (kind === 'stream') h.stderr.emit('error', new Error('SECRET-stream'));
    if (kind === 'output') h.stderr.write(Buffer.alloc(B.output));
    await flush(); const report = await h.run.done;
    expect(report.getSettings).toBe('accepted'); expect(report.outcome).toBe('failed'); expect(report.settings).toBeDefined();
    expect(JSON.stringify(report)).not.toContain('SECRET');
  });

  it('общий response deadline от spawn не сбрасывается успешным initialize', async () => {
    const h = double(); await vi.advanceTimersByTimeAsync(B.response - 1); await h.acceptInit();
    await vi.advanceTimersByTimeAsync(1); const report = await h.run.done;
    expect(report.reasons).toContain('response_deadline'); expect(report.completion.wait).toBe('deadline');
    expect(report.elapsedMs).toBe(B.response); expect(h.writes).toHaveLength(2);
  });

  it('поздний callback write после deadline не посылает второй запрос', async () => {
    const h = double({ holdWrite: true }); h.stdout.write(line(init()));
    await vi.advanceTimersByTimeAsync(B.response); h.callbacks[0]!(); await flush();
    expect((await h.run.done).reasons).toContain('response_deadline'); expect(h.writes).toHaveLength(1);
  });

  it('успешный ответ не скрывает work deadline, TERM/KILL и unconfirmed exit при общем таймере 18 с', async () => {
    const h = double({ ignoreKill: true }); await h.observe();
    await vi.advanceTimersByTimeAsync(B.work - 1); expect(h.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(B.outer - B.work + 1); const report = await h.run.done;
    expect(h.kill.mock.calls.map(call => call[0])).toEqual(['SIGTERM', 'SIGKILL']);
    expect(report.elapsedMs).toBe(B.outer); expect(report.outcome).toBe('failed');
    expect(report.completion).toMatchObject({ process: { state: 'unconfirmed' }, stdout: 'forced_closed', stderr: 'forced_closed', wait: 'deadline' });
    expect(report.reasons).toEqual(expect.arrayContaining(['work_deadline', 'exit_unconfirmed', 'drain_timeout']));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['EPERM', 'ESRCH', 'SECRET-code'])('ошибка сигнала %s не доказывает выход', async code => {
    const h = double({ signalError: code }); h.run.stop(); await vi.advanceTimersByTimeAsync(3_000);
    const report = await h.run.done;
    expect(report).toMatchObject({ outcome: 'stopped', stopAccepted: true, completion: { process: { state: 'unconfirmed' }, wait: 'deadline' } });
    expect(report.reasons).toEqual(expect.arrayContaining(['signal_failed', 'exit_unconfirmed']));
    expect(report.completion.signals).toHaveLength(2); expect(JSON.stringify(report)).not.toContain('SECRET');
  });

  it('ложный kill сохраняется как failed, собственный Stop запрещает observed', async () => {
    const h = double({ ignoreKill: true, falseKill: true }); await h.observe(); h.run.stop();
    await vi.advanceTimersByTimeAsync(3_000); const report = await h.run.done;
    expect(report.outcome).toBe('stopped'); expect(report.completion.signals.map(value => value.status)).toEqual(['failed', 'failed']);
  });

  it('подтверждённый exit не подменяет EOF; drain конечен, поздние события не меняют снимок', async () => {
    const h = double(); await h.observe(); h.exit(0, null, false); await vi.advanceTimersByTimeAsync(B.drain);
    const report = await h.run.done; const snapshot = JSON.stringify(report);
    expect(report.completion).toMatchObject({ process: { state: 'exited', exitCode: 0 }, stdout: 'forced_closed', stderr: 'forced_closed', wait: 'deadline' });
    h.emitter.emit('exit', 8, 'SIGABRT'); h.stderr.emit('error', new Error('SECRET-late')); h.run.stop();
    expect(JSON.stringify(await h.run.done)).toBe(snapshot); expect(Object.isFrozen(report.completion)).toBe(true);
  });

  it('ошибка stdin не вызывает повтор записи', async () => {
    const h = double({ holdWrite: true }); h.callbacks[0]!(new Error('SECRET-write')); await flush();
    const report = await h.run.done; expect(report.reasons).toContain('stdin_failed'); expect(h.writes).toHaveLength(1);
  });

  it.each(['error', 'success', 'never'] as const)('callback второй записи %s после exit/EOF не теряется', async result => {
    const h = double({ holdWrite: 2 }); await h.observe();
    expect(h.callbacks).toHaveLength(1); expect(h.stdin.writableEnded).toBe(false);
    let settled = false; void h.run.done.then(() => { settled = true; });
    h.exit(); await flush(); expect(settled).toBe(false);
    if (result === 'never') await vi.advanceTimersByTimeAsync(B.drain);
    else { h.callbacks[0]!(result === 'error' ? new Error('SECRET-write') : undefined); await flush(); }
    const report = await h.run.done;
    expect(report.outcome).toBe(result === 'success' ? 'observed' : 'failed');
    expect(report.stdin).toBe(result === 'success' ? 'finished' : result === 'never' ? 'forced_closed' : 'errored');
    if (result !== 'success') expect(report.reasons).toContain('stdin_failed');
    if (result === 'never') expect(report.completion.wait).toBe('deadline');
    expect(h.writes).toHaveLength(2); expect(h.kill).not.toHaveBeenCalled();
    expect(JSON.stringify(report)).not.toContain('SECRET'); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['error', 'success', 'never'] as const)('finish stdin %s после end/exit/EOF требуется отдельно', async result => {
    const h = double({ holdFinish: true }); await h.observe();
    expect(h.stdin.writableEnded).toBe(true); expect(h.stdin.writableFinished).toBe(false);
    let settled = false; void h.run.done.then(() => { settled = true; });
    h.exit(); await flush(); expect(settled).toBe(false);
    if (result === 'never') await vi.advanceTimersByTimeAsync(B.drain);
    else { h.finals[0]!(result === 'error' ? new Error('SECRET-final') : undefined); await flush(); }
    const report = await h.run.done;
    expect(report.outcome).toBe(result === 'success' ? 'observed' : 'failed');
    expect(report.stdin).toBe(result === 'success' ? 'finished' : result === 'never' ? 'forced_closed' : 'errored');
    if (result !== 'success') expect(report.reasons).toContain('stdin_failed');
    if (result === 'never') expect(report.completion.wait).toBe('deadline');
    expect(JSON.stringify(report)).not.toContain('SECRET'); expect(h.writes).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('закрытие stdin без finish остаётся ошибкой', async () => {
    const h = double({ holdFinish: true }); await h.observe(); h.stdin.destroy(); await flush();
    expect(await h.run.done).toMatchObject({ outcome: 'failed', stdin: 'errored', reasons: ['stdin_failed', 'process_failed'] });
  });

  it.each(['before_handle', 'after_handle'] as const)('неопределённая ошибка фабрики %s не доказывает отсутствие процесса', async stage => {
    let allocated: { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> } | undefined;
    const spawn = vi.fn((): InspectionChild => {
      if (stage === 'after_handle') allocated = { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() };
      throw new Error('SECRET-spawn');
    });
    const report = await inspectSettings(spawn).done;
    expect(report).toMatchObject({ outcome: 'failed', stdin: 'unconfirmed', completion: {
      process: { state: 'unconfirmed' }, stdout: 'unconfirmed', stderr: 'unconfirmed', signals: [],
    }, reasons: expect.arrayContaining(['spawn_failed', 'exit_unconfirmed', 'process_handle_unavailable']) });
    expect(spawn).toHaveBeenCalledTimes(1); expect(JSON.stringify(report)).not.toContain('SECRET'); expect(vi.getTimerCount()).toBe(0);
    if (allocated) {
      expect(allocated.kill).not.toHaveBeenCalled(); expect(allocated.stdin.destroyed).toBe(false);
      allocated.stdin.destroy(); allocated.stdout.destroy(); allocated.stderr.destroy();
    }
  });

  it.each([0, 7])('выход %s до ответа остаётся отказом', async code => {
    const h = double(); h.exit(code); await flush(); expect((await h.run.done).outcome).toBe('failed');
  });

  it('историческое ожидание inventory допускает только точные builtin-регистрации', async () => {
    const h = double(); h.stdout.write(line(syntheticInit())); await h.observe(); h.exit(); await flush();
    expect(await h.run.done).toMatchObject({ outcome: 'observed', inventoryObserved: true });
  });

  it.each(['extra', 'repeat', 'missing'] as const)('inventory %s не превращается в согласованный', async kind => {
    const h = double(); const value = syntheticInit(kind === 'extra' ? { tools: ['Read', 'Glob', 'Grep', 'Bash'] } : kind === 'missing' ? { plugins: undefined } : {});
    h.stdout.write(line(value, ...(kind === 'repeat' ? [value] : []))); await flush();
    expect((await h.run.done).reasons).toContain('inventory_mismatch'); expect(h.writes).toHaveLength(1);
  });
});
