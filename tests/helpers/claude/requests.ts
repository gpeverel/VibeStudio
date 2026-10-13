import type { AccessProfile, AgentRunRequest, PracticalLocalReadProfile } from '../../../src/core/ports/agent.ts';

export const AGENT_SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e';

export function legacyStrictProfile(cwd: string, overrides: Partial<AccessProfile> = {}): AccessProfile {
  return {
    mode: 'read-only',
    tools: ['Read', 'Glob', 'Grep'],
    allow: [],
    deny: [],
    configPolicy: { settingSources: [], loadHooks: false, loadMcp: false, loadPlugins: false },
    fs: { readRoots: [cwd], writeRoots: [], runtimeWriteRoots: [], protectedPaths: [] },
    network: 'provider-only',
    ...overrides,
  };
}

/** Старое имя сохраняет строгий профиль без kind, в том числе для реальных replay. */
export const readOnlyProfile = legacyStrictProfile;

export function legacyStrictRequest(cwd: string, overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    sessionId: 'app-session-1',
    turnId: 'turn-1',
    participantId: 'participant-1',
    workspaceId: 'workspace-1',
    cwd,
    prompt: 'Опиши структуру проекта',
    agentSessionId: AGENT_SESSION,
    resume: false,
    profile: readOnlyProfile(cwd),
    env: { HOME: '/home/test' },
    ...overrides,
  };
}

/** Старые запросы не переводятся в practical автоматически. */
export const request = legacyStrictRequest;

export function practicalLocalReadProfile(cwd: string, overrides: Partial<PracticalLocalReadProfile> = {}): PracticalLocalReadProfile {
  return {
    kind: 'practical-local-v1', mode: 'read-only', workspaceRoot: cwd, projectTrust: 'trusted',
    tools: ['Read', 'Glob', 'Grep'], allow: [], deny: [],
    configPolicy: { settingSources: [], projectHooks: 'disabled', projectMcp: 'disabled', projectPlugins: 'disabled' },
    ...overrides,
  };
}

export function practicalRequest(cwd: string, overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return legacyStrictRequest(cwd, { profile: practicalLocalReadProfile(cwd), ...overrides });
}

/** Значение аргумента, следующего за флагом (первое вхождение). */
export function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}
