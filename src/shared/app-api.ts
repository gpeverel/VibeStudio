import type { ApiResult, ConfirmSetupRequest, CreateSessionRequest, EventPage, EventsAvailable,
  OperationView, ProjectView, ReadEventsRequest, RevokeConsentRequest, SelectProjectRequest,
  SendTurnRequest, SessionCommandRequest, SessionView } from './solo.ts';

/** Только именованные действия. Пути, процессы и разрешающие флаги остаются в main. */
export interface AppApi {
  readonly appName: string;
  selectProject(request: SelectProjectRequest): Promise<ApiResult<ProjectView | null>>;
  listProjects(): Promise<ApiResult<ProjectView[]>>;
  listSessions(): Promise<ApiResult<SessionView[]>>;
  getSession(request: { sessionId: string }): Promise<ApiResult<SessionView>>;
  createSession(request: CreateSessionRequest): Promise<ApiResult<OperationView>>;
  prepareSetup(request: SessionCommandRequest): Promise<ApiResult<OperationView>>;
  confirmSetup(request: ConfirmSetupRequest): Promise<ApiResult<OperationView>>;
  revokeConsent(request: RevokeConsentRequest): Promise<ApiResult<OperationView>>;
  sendTurn(request: SendTurnRequest): Promise<ApiResult<OperationView>>;
  stop(request: SessionCommandRequest): Promise<ApiResult<OperationView>>;
  readEvents(request: ReadEventsRequest): Promise<ApiResult<EventPage>>;
  onEventsAvailable(listener: (notice: EventsAvailable) => void): () => void;
}
export const SOLO_IPC_PREFIX = 'vibestudio:solo:';
export const SOLO_EVENTS_CHANNEL = 'vibestudio:solo:events-available';
