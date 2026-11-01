import type {
  ConsentRecord, NewSoloEvent, OperationRecord, ParticipantRecord, ProjectRecord, SessionRecord, StoreWrite,
  TurnRecord, WorkspaceRecord,
} from '../../src/core/ports/store.ts';

/** Минимальные полные записи для проверок хранилища; все значения синтетические. */
export const NOW = '2026-10-29T10:00:00.000Z';

export function project(id = 'project-1', path = `/synthetic/${id}`): ProjectRecord {
  return {
    id, canonicalPath: path, name: id, defaultBranch: 'main', configVersion: 1,
    config: { setup: { kind: 'npm-script', script: 'setup', args: [] }, copyFiles: [], setupTimeoutMs: 60_000 },
  };
}

export function session(id = 'session-1', projectId = 'project-1'): SessionRecord {
  return { id, projectId, title: id, status: 'ready', detail: '', createdAt: NOW, updatedAt: NOW };
}

export function workspace(sessionId = 'session-1', id = `workspace-${sessionId}`): WorkspaceRecord {
  return {
    id, sessionId, path: `/synthetic/worktrees/${id}`, branch: `vs/${sessionId}`, baseRef: 'main', initialBaseSha: null,
    state: 'ready', setupState: 'not_configured', setupDecision: null, setupCompletion: null, configVersion: 1,
  };
}

export function participant(sessionId = 'session-1', workspaceId = `workspace-${sessionId}`, cli: 'claude' | 'codex' = 'claude'): ParticipantRecord {
  return {
    id: `participant-${sessionId}`, sessionId, workspaceId, cli,
    profile: cli === 'claude' ? 'practical-local-v1' : 'codex-app-server-read-v1', agentSessionId: null, context: 'new',
  };
}

export function operation(id: string, overrides: Partial<OperationRecord> = {}): OperationRecord {
  return {
    id, requestId: `request-${id}`, sessionId: 'session-1', kind: 'send_turn', status: 'running', error: null,
    fingerprint: `fingerprint-${id}`, workspaceId: 'workspace-session-1', projectId: 'project-1', turnId: null,
    phase: 'intent_saved', createdAt: NOW, updatedAt: NOW, result: null, ...overrides,
  };
}

export function turn(id: string, seq: number, operationId: string, overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    id, participantId: 'participant-session-1', sessionId: 'session-1', workspaceId: 'workspace-session-1', seq,
    prompt: 'задача', conversation: 'new', status: 'starting', operationId, startedAt: NOW, endedAt: null,
    result: null, processIdentity: null, ...overrides,
  };
}

export function consent(id: string, operationId = 'setup:project-1', overrides: Partial<ConsentRecord> = {}): ConsentRecord {
  return {
    id, operationId, projectId: 'project-1', version: 1, contextDigest: 'a'.repeat(64), fingerprint: 'b'.repeat(64),
    coverage: { profile: 'project-command-v1', inputs: [{ path: 'package.json', kind: 'manifest', digest: 'c'.repeat(64) }], limitations: [] },
    status: 'granted', updatedAt: NOW, ...overrides,
  };
}

export function event(id: string, sessionId = 'session-1', detail = id): NewSoloEvent {
  return { id, sessionId, timestamp: NOW, payload: { type: 'diagnostic', code: 'synthetic', detail } };
}

/** Проект, сессия, workspace и participant одной записью. */
export function baseWrite(extra: StoreWrite = {}): StoreWrite {
  return {
    projects: [project()], sessions: [session()], workspaces: [workspace()], participants: [participant()], ...extra,
  };
}
