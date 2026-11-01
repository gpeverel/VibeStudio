import { contextBridge, ipcRenderer } from 'electron';
import { SOLO_EVENTS_CHANNEL, SOLO_IPC_PREFIX } from '../shared/app-api.ts';
import type { AppApi } from '../shared/app-api.ts';
import type { ApiResult, EventsAvailable } from '../shared/solo.ts';

function invoke<T>(method: string, request: object): Promise<ApiResult<T>> {
  return ipcRenderer.invoke(`${SOLO_IPC_PREFIX}${method}`, request) as Promise<ApiResult<T>>;
}

const api: AppApi = Object.freeze({
  appName: 'VibeStudio',
  selectProject: request => invoke('selectProject', request),
  listProjects: () => invoke('listProjects', {}),
  listSessions: () => invoke('listSessions', {}),
  getSession: request => invoke('getSession', request),
  createSession: request => invoke('createSession', request),
  prepareSetup: request => invoke('prepareSetup', request),
  confirmSetup: request => invoke('confirmSetup', request),
  revokeConsent: request => invoke('revokeConsent', request),
  sendTurn: request => invoke('sendTurn', request),
  stop: request => invoke('stop', request),
  readEvents: request => invoke('readEvents', request),
  onEventsAvailable(listener: (notice: EventsAvailable) => void) {
    const handler = (_event: Electron.IpcRendererEvent, notice: unknown): void => {
      if (!notice || typeof notice !== 'object' || !('sessionId' in notice) || !('seq' in notice)) return;
      if (typeof notice.sessionId !== 'string' || notice.sessionId.length > 128
        || !Number.isSafeInteger(notice.seq) || Number(notice.seq) < 0) return;
      // Neither the Electron event nor arbitrary main payload properties cross the bridge.
      listener({ sessionId: notice.sessionId, seq: Number(notice.seq) });
    };
    ipcRenderer.on(SOLO_EVENTS_CHANNEL, handler);
    return () => { ipcRenderer.removeListener(SOLO_EVENTS_CHANNEL, handler); };
  },
} satisfies AppApi);
contextBridge.exposeInMainWorld('api', api);
