import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INSPECTION_BUDGET as B, INSPECTION_PROTOCOL_FAILURES, inspectSettings } from '../helpers/claude/settings-inspection.ts';
import type { InspectionChild, InspectionOptions, InspectionProtocolFailure } from '../helpers/claude/settings-inspection.ts';
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
function double(options: { holdWrite?: boolean | number; holdFinish?: boolean; holdKill?: boolean; ignoreKill?: boolean; signalError?: string; falseKill?: boolean } = {}, inspectionOptions: InspectionOptions = {}) {
  const emitter = new EventEmitter();
  const stdout = new PassThrough(), stderr = new PassThrough();
  const writes: string[] = [], callbacks: ((error?: Error | null) => void)[] = [], finals: ((error?: Error | null) => void)[] = [];
  const signalReplies: { resolve(value: boolean): void; reject(error: unknown): void }[] = [];
  const stdin = new Writable({ write(chunk: Buffer, _encoding, callback) {
    writes.push(chunk.toString('utf8'));
    if (options.holdWrite === true || options.holdWrite === writes.length) callbacks.push(callback); else callback();
  }, final(callback) { if (options.holdFinish) finals.push(callback); else callback(); } });
  const exit = (code: number | null = 0, signal: string | null = null, end = true) => {
    emitter.emit('exit', code, signal);
    if (end) { stdout.end(); stderr.end(); }
  };
  const kill = vi.fn((signal: string) => {
    if (options.holdKill) return new Promise<boolean>((resolve, reject) => { signalReplies.push({ resolve, reject }); });
    if (options.signalError) throw Object.assign(new Error('SECRET-signal'), { code: options.signalError });
    if (!options.ignoreKill) queueMicrotask(() => exit(null, signal));
    return !options.falseKill;
  });
  const child = Object.assign(emitter, { stdin, stdout, stderr, pid: 12345, kill, unref: vi.fn() }) as unknown as InspectionChild;
  const spawn = vi.fn(() => child);
  const run = inspectSettings(spawn, inspectionOptions);
  const acceptInit = async () => { stdout.write(line(init())); await flush(); };
  const observe = async (payload: unknown = settingsPayload()) => { await acceptInit(); stdout.write(line(settings(payload))); await flush(); };
  return { child, emitter, stdout, stderr, stdin, writes, callbacks, finals, signalReplies, exit, kill, spawn, run, acceptInit, observe };
}
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('Узкое уведомление режима и безопасные system-классы: synthetic', () => {
  const ids = { uuid: '00000000-0000-4000-8000-000000000001', session_id: '00000000-0000-4000-8000-000000000002' };
  const status = (patch: Record<string, unknown> = {}) => ({ type: 'system', subtype: 'status', status: null,
    permissionMode: 'dontAsk', ...ids, ...patch });
  it('status до initialize и между ответами не является init и не меняет два запроса', async () => {
    const h = double(); h.stdout.write(line(status())); await flush();
    expect(h.writes).toHaveLength(1); expect(h.kill).not.toHaveBeenCalled();
    h.stdout.write(line(init(), status())); await flush(); expect(h.writes).toHaveLength(2);
    h.stdout.write(line(status(), settings(), status())); await flush(); h.exit(); await flush();
    const report = await h.run.done;
    expect(report).toMatchObject({ outcome: 'observed', statusNotifications: 4, initialize: 'accepted', getSettings: 'accepted', inventoryObserved: false, sessionState: 'unknown' });
    expect(report).not.toHaveProperty('systemObservation'); expect(JSON.stringify(report)).not.toContain(ids.uuid);
    expect(JSON.stringify(report)).not.toContain(ids.session_id); expect(h.writes).toHaveLength(2);
  });
  it('не отправляет settings до завершения частичной строки status и callback init', async () => {
    const h = double({ holdWrite: 1 }), bytes = line(status());
    h.stdout.write(Buffer.concat([line(init()), bytes.subarray(0, bytes.length - 1)])); await flush();
    h.callbacks[0]!(); await flush(); expect(h.writes).toHaveLength(1);
    h.stdout.write(bytes.subarray(-1)); await flush(); expect(h.writes).toHaveLength(2);
    h.stdout.write(line(settings())); await flush(); h.exit(); await flush();
    expect(await h.run.done).toMatchObject({ outcome: 'observed', statusNotifications: 1 });
  });
  it('status не перезапускает response deadline и не допускает поздний init/settings', async () => {
    const h = double(); await vi.advanceTimersByTimeAsync(B.response - 1);
    h.stdout.write(line(status())); await flush(); await vi.advanceTimersByTimeAsync(1);
    h.stdout.emit('data', line(init())); await flush();
    expect(await h.run.done).toMatchObject({ statusNotifications: 1, initialize: 'pending', getSettings: 'not_sent', reasons: expect.arrayContaining(['response_deadline']) });
    expect(h.writes).toHaveLength(1);
  });
  it('status не обходит исходные byte/line лимиты и не становится разрешением других system', async () => {
    const h = double(); h.stdout.write(line(status()));
    h.stdout.write(Buffer.alloc(B.line + 1, 32)); await flush();
    expect(await h.run.done).toMatchObject({ statusNotifications: 1, reasons: expect.arrayContaining(['output_limit']) });
    expect(h.writes).toHaveLength(1);
  });
  it.each([
    { status: undefined }, { status: 'requesting' }, { status: 'compacting' }, { status: 'SECRET-status' },
    { permissionMode: undefined }, { permissionMode: null }, { permissionMode: 'default' }, { permissionMode: 'plan' },
    { permissionMode: 'bypassPermissions' }, { permissionMode: 'acceptEdits' }, { permissionMode: 'auto' },
    { permissionMode: 'SECRET-mode' }, { uuid: undefined }, { uuid: 'SECRET-uuid' }, { uuid: 1 },
    { session_id: undefined }, { session_id: 'SECRET-session' }, { session_id: [] },
    { compact_result: 'success' }, { compact_error: 'SECRET-error' }, { compact_output_chars: 0 }, { detail: 'SECRET-detail' },
  ])('отказывается от неполной/активной/расширенной status формы %j', async patch => {
    const h = double(); h.stdout.write(line(status(patch), init())); await flush();
    const report = await h.run.done;
    expect(report.protocolFailure).toBe('system_message_unsupported'); expect(report.systemObservation?.subtype).toBe('status');
    expect(report).not.toHaveProperty('statusNotifications'); expect(h.writes).toHaveLength(1);
    expect(JSON.stringify(report)).not.toContain('SECRET');
  });
  it.each([
    [{ type: 'system' }, { subtype: 'absent', shape: 'unclassified' }],
    [{ type: 'system', subtype: {} }, { subtype: 'invalid', shape: 'unclassified' }],
    [{ type: 'system', subtype: 'SECRET-subtype' }, { subtype: 'unknown', shape: 'unclassified' }],
    [status({ permissionMode: undefined }), { subtype: 'status', shape: 'status_valid', statusValue: 'null', permissionMode: 'absent' }],
    [status({ status: 'requesting' }), { subtype: 'status', shape: 'status_valid', statusValue: 'requesting', permissionMode: 'dontAsk' }],
    [status({ status: 'compacting', permissionMode: 'plan' }), { subtype: 'status', shape: 'status_valid', statusValue: 'compacting', permissionMode: 'other' }],
    [status({ status: undefined }), { subtype: 'status', shape: 'status_invalid', statusValue: 'absent', permissionMode: 'dontAsk' }],
    [status({ status: 'SECRET-value', permissionMode: {} }), { subtype: 'status', shape: 'status_invalid', statusValue: 'invalid', permissionMode: 'invalid' }],
    [status({ uuid: 'SECRET-uuid', session_id: 'SECRET-session' }), { subtype: 'status', shape: 'status_valid', statusValue: 'null', permissionMode: 'dontAsk' }],
    [status({ compact_result: 'success', compact_error: 'SECRET-error', compact_output_chars: 1 }), { subtype: 'status', shape: 'status_valid', statusValue: 'null', permissionMode: 'dontAsk' }],
    [status({ compact_result: 'SECRET-result' }), { subtype: 'status', shape: 'status_invalid', statusValue: 'null', permissionMode: 'dontAsk' }],
    [status({ compact_error: {} }), { subtype: 'status', shape: 'status_invalid', statusValue: 'null', permissionMode: 'dontAsk' }],
    [status({ compact_output_chars: 0.5 }), { subtype: 'status', shape: 'status_invalid', statusValue: 'null', permissionMode: 'dontAsk' }],
    [{ type: 'system', subtype: 'session_state_changed', state: 'idle', ...ids }, { subtype: 'session_state_changed', shape: 'session_state_valid', state: 'idle' }],
    [{ type: 'system', subtype: 'session_state_changed', state: 'running', ...ids }, { subtype: 'session_state_changed', shape: 'session_state_valid', state: 'running' }],
    [{ type: 'system', subtype: 'session_state_changed', state: 'requires_action', ...ids }, { subtype: 'session_state_changed', shape: 'session_state_valid', state: 'requires_action' }],
    [{ type: 'system', subtype: 'session_state_changed', state: 'SECRET-state', ...ids }, { subtype: 'session_state_changed', shape: 'session_state_invalid', state: 'invalid' }],
    [{ type: 'system', subtype: 'session_state_changed', ...ids }, { subtype: 'session_state_changed', shape: 'session_state_invalid', state: 'absent' }],
    [{ type: 'system', subtype: 'session_title_changed', title: 'SECRET-title', ...ids }, { subtype: 'session_title_changed', shape: 'session_title_valid' }],
    [{ type: 'system', subtype: 'session_title_changed', title: {}, ...ids }, { subtype: 'session_title_changed', shape: 'session_title_invalid' }],
    [{ type: 'system', subtype: 'hook_started', detail: 'SECRET-detail' }, { subtype: 'hook_started', shape: 'unclassified' }],
    [{ type: 'system', subtype: 'notification', detail: 'SECRET-detail' }, { subtype: 'notification', shape: 'unclassified' }],
  ])('классификация system не экспортирует входные значения и не разрешает сообщение %#', async (value, observation) => {
    const h = double(); h.stdout.write(line(value)); await flush(); const report = await h.run.done;
    expect(report.systemObservation).toEqual(observation); expect(report.protocolFailure).toBe('system_message_unsupported');
    expect(report.getSettings).toBe('not_sent'); expect(JSON.stringify(report)).not.toContain('SECRET');
  });
  it('сохраняет только первый отвергнутый system и замороженный снимок', async () => {
    const h = double(); h.stdout.write(line(status(), { type: 'system', subtype: 'api_error', message: 'SECRET-error' }, status({ status: 'requesting' })));
    await flush(); const report = await h.run.done, snapshot = JSON.stringify(report);
    expect(report.systemObservation).toEqual({ subtype: 'api_error', shape: 'unclassified' }); expect(report.statusNotifications).toBe(1);
    h.stdout.emit('data', line(status())); h.run.stop(); expect(JSON.stringify(await h.run.done)).toBe(snapshot);
    expect(Object.isFrozen(report.systemObservation)).toBe(true);
  });
});

describe('ui_invalidate: уведомление без UI-ответа или исполнения', () => {
  const ids = { uuid: '00000000-0000-4000-8000-000000000003', session_id: '00000000-0000-4000-8000-000000000004' };
  const instance = { surface: 'SECRET-surface', component: 'SECRET-component', instance_id: 'SECRET-instance' };
  const ui = (patch: Record<string, unknown> = {}) => ({ type: 'system', subtype: 'ui_invalidate', event: 'ui.render', ...ids, ...patch });
  it.each([{}, { instances: [] }, { instances: [instance] }])('принимает точную форму до initialize без нового запроса %j', async patch => {
    const h = double(); h.stdout.write(line(ui(patch))); await flush(); expect(h.writes).toHaveLength(1);
    await h.observe(); h.exit(); await flush(); const report = await h.run.done;
    expect(report).toMatchObject({ outcome: 'observed', uiInvalidations: 1, inventoryObserved: false, sessionState: 'unknown' });
    expect(h.writes).toHaveLength(2); expect(JSON.stringify(report)).not.toContain('SECRET'); expect(JSON.stringify(report)).not.toContain(ids.uuid);
  });
  it('частичная строка и callback сохраняют причинность; поздний ui не меняет terminal', async () => {
    const h = double({ holdWrite: 1 }), bytes = line(ui({ instances: [instance] }));
    h.stdout.write(Buffer.concat([line(init()), bytes.subarray(0, -1)])); await flush(); h.callbacks[0]!(); await flush();
    expect(h.writes).toHaveLength(1); h.stdout.write(bytes.subarray(-1)); await flush(); expect(h.writes).toHaveLength(2);
    h.stdout.write(line(ui(), settings(), ui())); await flush(); h.exit(); await flush();
    const report = await h.run.done, snapshot = JSON.stringify(report); expect(report.uiInvalidations).toBe(3);
    h.stdout.emit('data', line(ui())); expect(JSON.stringify(await h.run.done)).toBe(snapshot);
  });
  it('ui не продлевает deadline и не разрешает поздний initialize', async () => {
    const h = double(); await vi.advanceTimersByTimeAsync(B.response - 1); h.stdout.write(line(ui())); await flush();
    await vi.advanceTimersByTimeAsync(1); h.stdout.emit('data', line(ui(), init())); await flush();
    expect(await h.run.done).toMatchObject({ uiInvalidations: 1, getSettings: 'not_sent', reasons: expect.arrayContaining(['response_deadline']) });
    expect(h.writes).toHaveLength(1);
  });
  it.each([
    { event: undefined }, { event: 'SECRET-event' }, { event: {} }, { uuid: 'SECRET-uuid' }, { session_id: 'SECRET-session' },
    { instances: null }, { instances: {} }, { instances: ['SECRET-instance'] },
    { instances: [{ surface: 'SECRET', component: 'SECRET' }] }, { instances: [{ ...instance, surface: 1 }] },
    { instances: [{ ...instance, callback: 'SECRET-callback' }] }, { callback: 'SECRET-callback' },
  ])('отвергает неизвестные, исполняемые и неполные формы %j', async patch => {
    const h = double(); h.stdout.write(line(ui(patch), init())); await flush(); const report = await h.run.done;
    expect(report.protocolFailure).toBe('system_message_unsupported'); expect(report.systemObservation?.subtype).toBe('ui_invalidate');
    expect(report).not.toHaveProperty('uiInvalidations'); expect(h.writes).toHaveLength(1); expect(JSON.stringify(report)).not.toContain('SECRET');
  });
  it.each([
    [ui({ event: undefined }), { subtype: 'ui_invalidate', shape: 'ui_invalidate_invalid', uiEvent: 'absent', instances: 'absent' }],
    [ui({ event: 'SECRET-event', instances: [] }), { subtype: 'ui_invalidate', shape: 'ui_invalidate_invalid', uiEvent: 'invalid', instances: 'empty' }],
    [ui({ uuid: 'SECRET-id', instances: [instance] }), { subtype: 'ui_invalidate', shape: 'ui_invalidate_valid', uiEvent: 'ui.render', instances: 'nonempty' }],
    [ui({ instances: [{ ...instance, component: {} }] }), { subtype: 'ui_invalidate', shape: 'ui_invalidate_invalid', uiEvent: 'ui.render', instances: 'invalid' }],
    [ui({ instances: [{ ...instance, callback: 'SECRET' }] }), { subtype: 'ui_invalidate', shape: 'ui_invalidate_valid', uiEvent: 'ui.render', instances: 'nonempty' }],
  ])('схема диагностируется отдельно от более строгого приёма %#', async (value, observation) => {
    const h = double(); h.stdout.write(line(value)); await flush(); const report = await h.run.done;
    expect(report.systemObservation).toEqual(observation); expect(report.protocolFailure).toBe('system_message_unsupported');
    expect(JSON.stringify(report)).not.toContain('SECRET');
  });
  it('UI-уведомление не разрешает преждевременный settings', async () => {
    const h = double(); h.stdout.write(line(ui(), init(), settings())); await flush();
    expect(await h.run.done).toMatchObject({ uiInvalidations: 1, reasons: expect.arrayContaining(['premature_response']) });
    expect(h.writes).toHaveLength(1);
  });
});

describe('Безопасная точность протокольного отказа: synthetic checks', () => {
  // Ожидания заданы отдельно от реализации; Record требует пример для каждого закрытого кода.
  const cases = {
    utf8_invalid: Buffer.from([0xc3, 0x28, 10]),
    json_invalid: Buffer.from('SECRET-not-json\n'),
    message_not_object: line(['SECRET-value']),
    message_type_missing: line({ 'SECRET-key': true }),
    message_type_invalid: line({ type: { secret: 'SECRET-value' } }),
    message_type_unknown: line({ type: 'SECRET-type' }),
    control_request_unsupported: line({ type: 'control_request', request: { subtype: 'SECRET-subtype' } }),
    control_cancel_unsupported: line({ type: 'control_cancel_request', request_id: 'SECRET-id' }),
    system_message_unsupported: line({ type: 'system', subtype: 'SECRET-subtype' }),
    response_missing: line({ type: 'control_response', 'SECRET-key': true }),
    response_not_object: line({ type: 'control_response', response: 'SECRET-value' }),
    response_subtype_missing: line(init(initPayload(), { subtype: undefined })),
    response_subtype_unknown: line(init(initPayload(), { subtype: 'SECRET-subtype' })),
    response_error_missing: line(init(initPayload(), { subtype: 'error' })),
    response_error_invalid: line(init(initPayload(), { subtype: 'error', error: { secret: 'SECRET-value' } })),
    response_payload_missing: line(init(initPayload(), { response: undefined })),
    response_payload_not_object: line(init(initPayload(), { response: ['SECRET-value'] })),
    pending_permissions_missing: line(init(initPayload(), { pending_permission_requests: undefined })),
    pending_permissions_invalid: line(init(initPayload(), { pending_permission_requests: 'SECRET-value' })),
    pending_dialogs_missing: line(init(initPayload(), { pending_user_dialog_requests: undefined })),
    pending_dialogs_invalid: line(init(initPayload(), { pending_user_dialog_requests: 'SECRET-value' })),
    initialize_commands_missing: line(init({ ...initPayload(), commands: undefined })),
    initialize_commands_invalid: line(init({ ...initPayload(), commands: ['SECRET-value'] })),
    initialize_agents_missing: line(init({ ...initPayload(), agents: undefined })),
    initialize_agents_invalid: line(init({ ...initPayload(), agents: ['SECRET-value'] })),
    initialize_models_missing: line(init({ ...initPayload(), models: undefined })),
    initialize_models_invalid: line(init({ ...initPayload(), models: ['SECRET-value'] })),
    initialize_output_style_missing: line(init({ ...initPayload(), output_style: undefined })),
    initialize_output_style_invalid: line(init({ ...initPayload(), output_style: { secret: 'SECRET-value' } })),
    initialize_available_output_styles_missing: line(init({ ...initPayload(), available_output_styles: undefined })),
    initialize_available_output_styles_invalid: line(init({ ...initPayload(), available_output_styles: [{ secret: 'SECRET-value' }] })),
    initialize_account_missing: line(init({ ...initPayload(), account: undefined })),
    initialize_account_invalid: line(init({ ...initPayload(), account: 'SECRET-value' })),
    initialize_session_state_invalid: line(init({ ...initPayload(), session_state: 'SECRET-state' })),
    settings_effective_missing: line(settings({ sources: [], secret: 'SECRET-value' })),
    settings_effective_invalid: line(settings({ effective: ['SECRET-value'], sources: [] })),
    settings_sources_missing: line(settings({ effective: {}, secret: 'SECRET-value' })),
    settings_sources_invalid: line(settings({ effective: {}, sources: 'SECRET-value' })),
    settings_source_entry_invalid: line(settings({ effective: {}, sources: ['SECRET-value'] })),
    settings_source_unknown: line(settings({ effective: {}, sources: [{ source: 'SECRET-source', settings: {} }] })),
    settings_source_settings_invalid: line(settings({ effective: {}, sources: [{ source: 'policySettings', settings: 'SECRET-value' }] })),
    settings_source_duplicate: line(settings({ effective: {}, sources: [{ source: 'policySettings', settings: {} }, { source: 'policySettings', settings: { secret: 'SECRET-value' } }] })),
    settings_applied_invalid: line(settings({ ...settingsPayload(), applied: { model: 'SECRET-model', effort: 'SECRET-effort' } })),
    settings_errors_invalid: line(settings({ ...settingsPayload(), errors: 'SECRET-value' })),
  } satisfies Record<InspectionProtocolFailure, Buffer>;

  it.each(INSPECTION_PROTOCOL_FAILURES)('%s сохраняет только имя первого проваленного check', async check => {
    const h = double(); const afterInit = check.startsWith('settings_');
    if (afterInit) await h.acceptInit();
    h.stdout.write(cases[check]); await flush();
    const report = await h.run.done;
    expect(report.protocolFailure).toBe(check); expect(report.reasons).toContain('protocol_unknown');
    expect(report.outcome).toBe('failed'); expect(report.settings).toBeUndefined();
    expect(h.writes).toHaveLength(afterInit ? 2 : 1); expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(report)).not.toContain('SECRET');
  });

  it('первый check переживает ещё одну строку, поздние события и terminal freeze', async () => {
    const h = double(); h.stdout.write(Buffer.concat([cases.response_missing, cases.json_invalid])); await flush();
    const report = await h.run.done, snapshot = JSON.stringify(report);
    expect(report.protocolFailure).toBe('response_missing'); expect(Object.isFrozen(report)).toBe(true);
    h.stdout.emit('data', cases.message_type_unknown); h.run.stop(); h.stderr.emit('error', new Error('SECRET-late'));
    expect(JSON.stringify(await h.run.done)).toBe(snapshot); expect(h.writes).toHaveLength(1);
  });

  it.each([
    ['request_id_mismatch', success('SECRET-id', initPayload())],
    ['premature_response', settings()],
    ['request_rejected', init(initPayload(), { subtype: 'error', error: 'SECRET-error' })],
    ['pending_request', init(initPayload(), { pending_permission_requests: [{ secret: 'SECRET-value' }] })],
    ['unexpected_event', { type: 'assistant', content: 'SECRET-value' }],
    ['inventory_mismatch', { type: 'system', subtype: 'init', secret: 'SECRET-value' }],
  ] as const)('%s остаётся прежним отказом без protocolFailure', async (reason, value) => {
    const h = double(); h.stdout.write(line(value)); await flush();
    const report = await h.run.done; expect(report.reasons).toContain(reason);
    expect(report).not.toHaveProperty('protocolFailure'); expect(JSON.stringify(report)).not.toContain('SECRET');
  });
});

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

  it.each(['sent', 'false', 'EPERM', 'ESRCH', 'SECRET-code'] as const)('асинхронный ответ владельца %s учитывается после exit/EOF', async result => {
    const h = double({ holdKill: true }); await h.observe(); h.run.stop(); h.exit(); await flush();
    let settled = false; void h.run.done.then(() => { settled = true; }); await flush();
    expect(settled).toBe(false);
    if (result === 'sent' || result === 'false') h.signalReplies[0]!.resolve(result === 'sent');
    else h.signalReplies[0]!.reject(Object.assign(new Error('SECRET-signal'), { code: result }));
    await flush(); const report = await h.run.done;
    expect(report.completion.process).toEqual({ state: 'exited', exitCode: 0, signal: null });
    expect(report.completion.signals).toEqual([{ signal: 'SIGTERM', target: 'process',
      status: result === 'sent' ? 'sent' : result === 'ESRCH' ? 'not_found' : 'failed',
      ...(['EPERM', 'ESRCH'].includes(result) ? { errorCode: result } : {}),
    }]);
    expect(report.reasons.includes('signal_failed')).toBe(result !== 'sent');
    expect(JSON.stringify(report)).not.toContain('SECRET'); expect(vi.getTimerCount()).toBe(0);
  });

  it('потеря подтверждения сигнала ограничена drain; поздний ответ не меняет terminal', async () => {
    const h = double({ holdKill: true }); await h.observe(); h.run.stop(); h.exit();
    await vi.advanceTimersByTimeAsync(B.drain); const report = await h.run.done; const snapshot = JSON.stringify(report);
    expect(report.completion).toMatchObject({ process: { state: 'exited' }, wait: 'deadline',
      signals: [{ signal: 'SIGTERM', status: 'failed' }] });
    expect(report.reasons).toContain('signal_failed'); expect(report.elapsedMs).toBe(B.drain);
    h.signalReplies[0]!.resolve(true); await flush();
    expect(JSON.stringify(await h.run.done)).toBe(snapshot); expect(vi.getTimerCount()).toBe(0);
  });

  it('ожидание обоих сигналов не перезапускает outer и не превращает потерянный exit в not_started', async () => {
    const h = double({ holdKill: true }); await h.observe(); await vi.advanceTimersByTimeAsync(B.outer);
    const report = await h.run.done;
    expect(report.elapsedMs).toBe(B.outer); expect(h.kill.mock.calls.map(call => call[0])).toEqual(['SIGTERM', 'SIGKILL']);
    expect(report.completion).toMatchObject({ process: { state: 'unconfirmed' }, wait: 'deadline',
      signals: [{ signal: 'SIGTERM', status: 'failed' }, { signal: 'SIGKILL', status: 'failed' }] });
    expect(report.reasons).toEqual(expect.arrayContaining(['signal_failed', 'exit_unconfirmed']));
    expect(h.spawn).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });

  it('переставленные подтверждения сохраняют порядок TERM/KILL и не доказывают exit', async () => {
    const h = double({ holdKill: true }); h.run.stop(); await vi.advanceTimersByTimeAsync(B.term);
    h.signalReplies[1]!.resolve(true); h.signalReplies[0]!.resolve(false); await flush();
    await vi.advanceTimersByTimeAsync(B.kill + B.drain); const report = await h.run.done;
    expect(report.completion).toMatchObject({ process: { state: 'unconfirmed' },
      signals: [{ signal: 'SIGTERM', status: 'failed' }, { signal: 'SIGKILL', status: 'sent' }] });
    expect(report.reasons).toContain('exit_unconfirmed'); expect(vi.getTimerCount()).toBe(0);
  });

  it('переданный общий t0 учитывает время до запуска worker и initialize', async () => {
    const h = double({}, { startedAt: performance.now() - (B.response - 1) });
    await h.acceptInit(); await vi.advanceTimersByTimeAsync(1);
    const report = await h.run.done;
    expect(report.elapsedMs).toBe(B.response); expect(report.reasons).toContain('response_deadline');
    expect(h.writes).toHaveLength(2); expect(vi.getTimerCount()).toBe(0);
  });

  it('истёкший общий t0 не вызывает фабрику и не отправляет initialize', async () => {
    const spawn = vi.fn((): InspectionChild => { throw new Error('Фабрика не должна вызываться'); });
    const run = inspectSettings(spawn, { startedAt: performance.now() - B.response });
    expect(await run.done).toMatchObject({ outcome: 'failed', reasons: ['response_deadline'],
      completion: { process: { state: 'not_started' }, wait: 'deadline' } });
    expect(spawn).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it.each([B.response, B.work, B.outer])('задержанный callback записи при t=%s не отправляет get_settings до просроченного timer', async elapsed => {
    const h = double({ holdWrite: true }); h.stdout.write(line(init())); await flush();
    vi.spyOn(performance, 'now').mockReturnValue(elapsed);
    h.callbacks[0]!(); await flush(); const report = await h.run.done;
    expect(h.writes).toHaveLength(1); expect(report.getSettings).toBe('not_sent');
    expect(report.reasons).toContain(elapsed === B.outer ? 'outer_deadline' : elapsed === B.work ? 'work_deadline' : 'response_deadline');
    expect(report.completion.wait).toBe('deadline'); expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('поздний initialize при остановившейся очереди timers не разрешает второй запрос', async () => {
    const h = double(); vi.spyOn(performance, 'now').mockReturnValue(B.response + 1);
    h.stdout.write(line(init())); await flush(); const report = await h.run.done;
    expect(h.writes).toHaveLength(1); expect(report.getSettings).toBe('not_sent');
    expect(report.reasons).toContain('response_deadline'); expect(vi.getTimerCount()).toBe(0);
  });

  it('поздний settings не отменяет response deadline и не вызывает callback принятия', async () => {
    const accepted = vi.fn(), h = double({}, { onSettingsAccepted: accepted }); await h.acceptInit();
    vi.spyOn(performance, 'now').mockReturnValue(B.response);
    h.stdout.write(line(settings())); await flush(); const report = await h.run.done;
    expect(report.getSettings).toBe('pending'); expect(report.settings).toBeUndefined();
    expect(report.reasons).toContain('response_deadline'); expect(accepted).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('фабрика, занявшая оставшийся бюджет, не получает initialize после возврата handle', async () => {
    const emitter = new EventEmitter(), stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
    const write = vi.spyOn(stdin, 'write'), clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    const child = Object.assign(emitter, { stdin, stdout, stderr, pid: 12345, unref() {}, kill() {
      queueMicrotask(() => { emitter.emit('exit', null, 'SIGTERM'); stdout.end(); stderr.end(); }); return true;
    } }) as unknown as InspectionChild;
    const spawn = vi.fn(() => { clock.mockReturnValue(B.response); return child; });
    const run = inspectSettings(spawn); await flush(); const report = await run.done;
    expect(write).not.toHaveBeenCalled(); expect(report.initialize).toBe('not_sent');
    expect(report.reasons).toContain('response_deadline'); expect(spawn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([NaN, Infinity, 1])('недопустимый startedAt=%s отклоняется до фабрики', startedAt => {
    const spawn = vi.fn((): InspectionChild => { throw new Error('Фабрика не должна вызываться'); });
    expect(() => inspectSettings(spawn, { startedAt })).toThrow('Некорректное начало');
    expect(spawn).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it('callback принятия settings вызывается один раз без payload, не завершает transport', async () => {
    const accepted = vi.fn(); const h = double({}, { onSettingsAccepted: accepted }); await h.observe();
    expect(accepted).toHaveBeenCalledExactlyOnceWith();
    let settled = false; void h.run.done.then(() => { settled = true; }); await flush(); expect(settled).toBe(false);
    h.exit(); await flush(); expect((await h.run.done).outcome).toBe('observed');
  });

  it('ошибка callback принятия безопасно прекращает transport', async () => {
    const h = double({}, { onSettingsAccepted: () => { throw new Error('SECRET-callback'); } }); await h.observe();
    const report = await h.run.done;
    expect(report.reasons).toContain('process_failed'); expect(JSON.stringify(report)).not.toContain('SECRET');
    expect(h.spawn).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
});
