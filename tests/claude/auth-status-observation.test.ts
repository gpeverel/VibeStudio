import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProcessCompletion, ProcessRequest, ProcessResult, ProcessRun } from '../../src/core/ports/process-runner.ts';
import { collectAuthStatus, parseAuthStatus } from '../helpers/claude/auth-status-observation.ts';

/** Все процессы здесь synthetic doubles; реальная CLI, Keychain и сеть не вызываются. */
const SECRET = 'SYNTHETIC-PRIVATE-AUTH-DATA';
function complete(patch: Partial<ProcessCompletion> = {}): ProcessCompletion {
  return { process: { state: 'exited', exitCode: 0, signal: null }, stdout: 'ended', stderr: 'ended',
    wait: 'settled', descendants: 'not_guaranteed', signals: [], issues: [], ...patch };
}
function result(completion = complete()): ProcessResult {
  return { exitCode: completion.process.state === 'exited' ? completion.process.exitCode : null,
    signal: completion.process.state === 'exited' ? completion.process.signal : null, completion };
}
async function* bytes(...values: string[]) { for (const value of values) yield Buffer.from(value); }
function never<T>(): Promise<T> { return new Promise(() => undefined); }
function processDouble(output: string, completion = complete(), patch: Partial<ProcessRun> = {}): ProcessRun {
  return { stdout: bytes(output), stderr: bytes(), done: Promise.resolve(result(completion)),
    interrupt: vi.fn(async () => undefined), kill: vi.fn(async () => undefined), ...patch };
}
function observe(handle: ProcessRun, options: { deadlineMs?: number; cleanupMs?: number } = {}) {
  const start = vi.fn<(request: ProcessRequest) => ProcessRun>(() => handle);
  const observation = collectAuthStatus({ runner: { start }, executable: '/synthetic/claude', cwd: '/synthetic/tmp',
    env: { HOME: '/synthetic/home', PRIVATE: SECRET }, ...options });
  return { start, observation };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('P2b auth: закрытая проекция synthetic JSON', () => {
  it('сохраняет только boolean и закрытые значения method/provider', () => {
    expect(parseAuthStatus(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty',
      email: SECRET, token: SECRET, account: { name: SECRET } }))).toEqual({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' });
  });

  it.each(['broken JSON', 'null', '[]', '"true"', '{}', '{"loggedIn":"true"}', '{"loggedIn":1}'])('%s не становится authenticated', output => {
    expect(parseAuthStatus(output).loggedIn).toBeNull();
    expect(JSON.stringify(parseAuthStatus(output))).not.toContain(SECRET);
  });

  it('неизвестные строки заменяются other, значения другого типа — unknown', () => {
    expect(parseAuthStatus(JSON.stringify({ loggedIn: false, authMethod: SECRET, apiProvider: SECRET })))
      .toEqual({ loggedIn: false, authMethod: 'other', apiProvider: 'other' });
    expect(parseAuthStatus(JSON.stringify({ loggedIn: false, authMethod: { secret: SECRET }, apiProvider: 7 })))
      .toEqual({ loggedIn: false, authMethod: 'unknown', apiProvider: 'unknown' });
  });
});

describe('P2b auth: один фиксированный диагностический процесс, synthetic', () => {
  it('передаёт только auth status и конечные бюджеты, без модели/version/help', async () => {
    const handle = processDouble('{"loggedIn":true}');
    const { start, observation } = observe(handle);
    const report = await observation;
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]?.[0]).toEqual({ executable: '/synthetic/claude', args: ['auth', 'status'],
      cwd: '/synthetic/tmp', env: { HOME: '/synthetic/home', PRIVATE: SECRET }, stdin: '',
      timeoutMs: 5_000, stopGraceMs: 100, drainTimeoutMs: 500, maxQueueBytes: 262_144 });
    expect(report).toMatchObject({ status: 'authenticated', auth: { loggedIn: true }, cleanup: 'confirmed', stop: 'not_needed' });
    expect(handle.kill).not.toHaveBeenCalled();
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

  it.each([0, 1])('parsed false при exit %i даёт unauthenticated', async exitCode => {
    const report = await observe(processDouble('{"loggedIn":false,"authMethod":"none"}',
      complete({ process: { state: 'exited', exitCode, signal: null } }))).observation;
    expect(report).toMatchObject({ status: 'unauthenticated', auth: { loggedIn: false, authMethod: 'none' }, cleanup: 'confirmed' });
  });

  it.each([
    ['true с exit 1', '{"loggedIn":true}', complete({ process: { state: 'exited', exitCode: 1, signal: null } })],
    ['false с exit 2', '{"loggedIn":false}', complete({ process: { state: 'exited', exitCode: 2, signal: null } })],
    ['неизвестный loggedIn', '{"loggedIn":null}', complete()],
    ['отсутствующий EOF', '{"loggedIn":true}', complete({ stdout: 'unconfirmed' })],
    ['signal вместо нормального exit', '{"loggedIn":true}', complete({ process: { state: 'exited', exitCode: null, signal: 'SIGTERM' } })],
    ['deadline', '{"loggedIn":true}', complete({ wait: 'deadline' })],
    ['issue', '{"loggedIn":true}', complete({ issues: [{ code: 'stdin_failed', operation: 'stdin', detail: SECRET }] })],
  ])('%s не даёт успешную авторизацию', async (_name, output, completion) => {
    const report = await observe(processDouble(output, completion)).observation;
    expect(report.status).toBe('unconfirmed');
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

  it('собирает фрагментированный UTF-8, stderr учитывает без раскрытия', async () => {
    const json = Buffer.from(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'данные-' + SECRET }));
    const report = await observe(processDouble('', complete(), {
      stdout: (async function* () { for (const byte of json) yield Uint8Array.of(byte); })(), stderr: bytes(SECRET),
    })).observation;
    expect(report).toMatchObject({ status: 'authenticated', stdoutBytes: json.length, stderrBytes: Buffer.byteLength(SECRET) });
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

  it('превышение общего бюджета stdout не допускает parsed success и останавливает свой handle', async () => {
    const handle = processDouble('{"loggedIn":true}' + ' '.repeat(262_144));
    const report = await observe(handle).observation;
    expect(report.status).toBe('unconfirmed');
    expect(handle.kill).toHaveBeenCalledTimes(1);
  });

  it('rejected done не теряет безопасный отчёт', async () => {
    const handle = processDouble('{"loggedIn":true}', complete(), { done: Promise.reject(new Error(SECRET)) });
    const report = await observe(handle).observation;
    expect(report).toMatchObject({ status: 'unconfirmed', cleanup: 'unconfirmed' });
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

  it('ошибка чтения stdout останавливает свой handle без раскрытия ошибки', async () => {
    const handle = processDouble('', complete(), { stdout: {
      [Symbol.asyncIterator]: () => ({ next: async (): Promise<IteratorResult<Uint8Array>> => { throw new Error(SECRET); } }),
    } });
    const report = await observe(handle).observation;
    expect(report).toMatchObject({ status: 'unconfirmed', reason: 'collection_failed', stop: 'requested' });
    expect(handle.kill).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

  it('throw без полученного handle не объявляет cleanup подтверждённым', async () => {
    const start = vi.fn((): ProcessRun => { throw new Error(SECRET); });
    const report = await collectAuthStatus({ runner: { start }, executable: '/synthetic/claude', cwd: '/synthetic/tmp', env: {} });
    expect(start).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({ status: 'unconfirmed', cleanup: 'unconfirmed' });
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });
});

describe('P2b auth: конечность ошибочных synthetic handles', () => {
  it('просроченный абсолютный deadline не превращается в success до callback таймера', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const handle = processDouble('{"loggedIn":true}');
    const start = vi.fn(() => { now = 6; return handle; });
    const report = await collectAuthStatus({ runner: { start }, executable: '/synthetic/claude', cwd: '/synthetic/tmp',
      env: {}, deadlineMs: 5, cleanupMs: 3 });
    expect(report).toMatchObject({ status: 'unconfirmed', reason: 'deadline' });
  });

  it('выход после абсолютного срока cleanup не объявляется подтверждённой уборкой', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    let resolve!: (value: ProcessResult) => void;
    const done = new Promise<ProcessResult>(resolveResult => { resolve = resolveResult; });
    const handle = processDouble('', complete(), { done, stdout: {
      [Symbol.asyncIterator]: () => ({ next: async (): Promise<IteratorResult<Uint8Array>> => { throw new Error(SECRET); } }),
    }, kill: vi.fn(async () => { now = 4; resolve(result()); }) });
    const report = await observe(handle, { deadlineMs: 5, cleanupMs: 3 }).observation;
    expect(report).toMatchObject({ status: 'unconfirmed', cleanup: 'unconfirmed', stop: 'requested' });
    expect(handle.kill).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

  it.each([0, -1, 8_001, NaN])('некорректный deadline %s отклонён до spawn', async deadlineMs => {
    const start = vi.fn(() => processDouble('{"loggedIn":true}'));
    await expect(collectAuthStatus({ runner: { start }, executable: '/synthetic/claude', cwd: '/synthetic/tmp',
      env: {}, deadlineMs })).rejects.toThrow();
    expect(start).not.toHaveBeenCalled();
  });

  it.each(['stdout', 'stderr', 'done'] as const)('pending %s завершает наблюдение с unconfirmed', async part => {
    vi.useFakeTimers();
    const patch: Partial<ProcessRun> = part === 'done' ? { done: never() }
      : { [part]: { [Symbol.asyncIterator]: () => ({ next: () => never<IteratorResult<Uint8Array>>() }) } };
    const handle = processDouble('{"loggedIn":true}', complete(), patch);
    const { observation } = observe(handle, { deadlineMs: 5, cleanupMs: 3 });
    await vi.advanceTimersByTimeAsync(9);
    expect(await observation).toMatchObject({ status: 'unconfirmed', cleanup: 'unconfirmed' });
    expect(handle.kill).toHaveBeenCalledTimes(1);
  });

  it('rejected kill не теряется и не печатает исходную ошибку', async () => {
    vi.useFakeTimers();
    const handle = processDouble('', complete(), { done: never(), kill: vi.fn(async () => { throw new Error(SECRET); }) });
    const { observation } = observe(handle, { deadlineMs: 5, cleanupMs: 3 });
    await vi.advanceTimersByTimeAsync(9);
    const report = await observation;
    expect(report).toMatchObject({ status: 'unconfirmed', cleanup: 'unconfirmed', stop: 'failed' });
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

  it('pending kill имеет конечный исход; поздний done не меняет опубликованный отчёт', async () => {
    vi.useFakeTimers();
    let resolve!: (value: ProcessResult) => void;
    const done = new Promise<ProcessResult>(resolveResult => { resolve = resolveResult; });
    const handle = processDouble('{"loggedIn":true}', complete(), { done, kill: vi.fn(() => never<void>()) });
    const { observation } = observe(handle, { deadlineMs: 5, cleanupMs: 3 });
    await vi.advanceTimersByTimeAsync(9);
    const report = await observation;
    expect(report).toMatchObject({ status: 'unconfirmed', cleanup: 'unconfirmed' });
    const serialized = JSON.stringify(report);
    resolve(result());
    await vi.advanceTimersByTimeAsync(1);
    expect(JSON.stringify(report)).toBe(serialized);
  });
});
