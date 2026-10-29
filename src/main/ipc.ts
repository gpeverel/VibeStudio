import type { z } from 'zod';
import type { ApiResult } from '../shared/solo.ts';
import { soloSchemas } from '../shared/solo.ts';
import { soloError } from '../core/session-engine.ts';
import type { SessionEngine } from '../core/session-engine.ts';

export interface IpcHandlerOptions {
  engine: SessionEngine;
  selectProject(): Promise<string | null>;
  /** Источник предоставляет Electron; значения renderer не являются источником доверия. */
  authorize(source: unknown): boolean;
}

/** Проверяются идентичности объектов Electron и точный URL, а не renderer-поля с ID. */
export function isTrustedIpcSource(source: unknown, expected: {
  sender: unknown; mainFrame: unknown; url: string; currentUrl: string;
}): boolean {
  if (!source || typeof source !== 'object' || !expected.url || expected.url !== expected.currentUrl) return false;
  const value = source as { sender?: unknown; senderFrame?: { url?: unknown } | null };
  return value.sender === expected.sender && value.senderFrame === expected.mainFrame
    && value.senderFrame?.url === expected.url;
}

/** Импорт не запускает Electron. Это те же обработчики, которые регистрирует production main. */
export function createIpcHandlers({ engine, selectProject, authorize }: IpcHandlerOptions) {
  function handler<S extends z.ZodType, T>(schema: S, action: (input: z.output<S>) => T | Promise<T>) {
    return async (source: unknown, payload: unknown): Promise<ApiResult<T>> => {
      try {
        if (!authorize(source)) return { ok: false, error: { code: 'unauthorized', message: 'Источник запроса не является главным окном приложения.' } };
        const parsed = schema.safeParse(payload);
        if (!parsed.success) return { ok: false, error: { code: 'invalid_request', message: 'Некорректный запрос: проверьте обязательные поля.' } };
        return { ok: true, value: await action(parsed.data) };
      } catch (cause) { return { ok: false, error: soloError(cause) }; }
    };
  }
  return {
    selectProject: handler(soloSchemas.selectProject, input => engine.selectProject(input, selectProject)),
    listProjects: handler(soloSchemas.listProjects, () => engine.listProjects()),
    listSessions: handler(soloSchemas.listSessions, () => engine.listSessions()),
    getSession: handler(soloSchemas.getSession, input => engine.getSession(input)),
    createSession: handler(soloSchemas.createSession, input => engine.createSession(input)),
    prepareSetup: handler(soloSchemas.prepareSetup, input => engine.prepareSetup(input)),
    confirmSetup: handler(soloSchemas.confirmSetup, input => engine.confirmSetup(input)),
    revokeConsent: handler(soloSchemas.revokeConsent, input => engine.revokeConsent(input)),
    sendTurn: handler(soloSchemas.sendTurn, input => engine.sendTurn(input)),
    stop: handler(soloSchemas.stop, input => engine.stop(input)),
    readEvents: handler(soloSchemas.readEvents, input => engine.readEvents(input)),
  };
}
export type IpcHandlers = ReturnType<typeof createIpcHandlers>;
