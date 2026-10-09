import type { AccessProfile, AgentRunRequest } from '../../../src/core/ports/agent.ts';

export const AGENT_SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e';

export function readOnlyProfile(cwd: string, overrides: Partial<AccessProfile> = {}): AccessProfile {
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

export function request(cwd: string, overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
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

/** Значение аргумента, следующего за флагом (первое вхождение). */
export function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}
