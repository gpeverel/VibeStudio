import type { AgentRun } from './agent.ts';
import type { ParticipantRecord, TurnRecord, WorkspaceRecord } from './store.ts';
/** Доверенная композиция преобразует один запрос engine в конкретный тип CLI. */
export interface SoloAgentPort {
  start(input: { participant: ParticipantRecord; turn: TurnRecord; workspace: WorkspaceRecord;
    onProcessStarted?: (identity: { pid?: number; requestedExecutable: string; cwd: string; spawnObservedAt: string }) => void;
  }): Promise<AgentRun>;
  history(participant: ParticipantRecord, workspace: WorkspaceRecord): Promise<'available' | 'missing' | 'unknown'>;
}
