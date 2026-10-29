import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppApi } from '../../src/shared/app-api.ts';
import { SOLO_EVENTS_CHANNEL, SOLO_IPC_PREFIX } from '../../src/shared/app-api.ts';

const electron = vi.hoisted(() => ({ exposeInMainWorld: vi.fn(), invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }));
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: electron.exposeInMainWorld }, ipcRenderer: electron }));
let api: AppApi;
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks();
  electron.invoke.mockResolvedValue({ ok: true, value: null });
  await import('../../src/preload/index.ts');
  api = electron.exposeInMainWorld.mock.calls[0]![1] as AppApi;
});
describe('P5 preload: узкая граница', () => {
  it('экспортирует только именованные действия, без raw IPC/fs/process', () => {
    expect(electron.exposeInMainWorld.mock.calls[0]![0]).toBe('api');
    expect(Object.isFrozen(api)).toBe(true);
    expect(Object.keys(api).sort()).toEqual(['appName', 'selectProject', 'listProjects', 'listSessions', 'getSession', 'createSession',
      'prepareSetup', 'confirmSetup', 'revokeConsent', 'sendTurn', 'stop', 'readEvents', 'onEventsAvailable'].sort());
  });
  it('передаёт исходный requestId и связывает вызовы с фиксированными каналами', async () => {
    const request = { requestId: 'request-1', sessionId: 'session-1', prompt: 'Текст', conversation: 'continue' as const };
    await api.sendTurn(request); await api.sendTurn(request);
    expect(electron.invoke.mock.calls).toEqual([[`${SOLO_IPC_PREFIX}sendTurn`, request], [`${SOLO_IPC_PREFIX}sendTurn`, request]]);
    await api.readEvents({ sessionId: 'session-1', after: 30, limit: 100 });
    expect(electron.invoke).toHaveBeenLastCalledWith(`${SOLO_IPC_PREFIX}readEvents`, { sessionId: 'session-1', after: 30, limit: 100 });
  });
  it('уведомление не раскрывает Electron event, лишние поля и удаляет свой listener', () => {
    const listener = vi.fn(); const unsubscribe = api.onEventsAvailable(listener);
    const handler = electron.on.mock.calls[0]![1] as (event: unknown, payload: unknown) => void;
    handler({ sender: 'private' }, { sessionId: 'session', seq: 4, secret: 'private' });
    expect(listener).toHaveBeenCalledExactlyOnceWith({ sessionId: 'session', seq: 4 });
    handler({}, { sessionId: 'session', seq: NaN }); handler({}, null); handler({}, { sessionId: 1, seq: 5 });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe(); expect(electron.removeListener).toHaveBeenCalledWith(SOLO_EVENTS_CHANNEL, handler);
  });
});
