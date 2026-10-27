import type { AgentRunRequestBase } from '../../../src/core/ports/agent.ts';
import { CODEX_LIMITATIONS, CODEX_RESTRICTIONS } from '../../../src/adapters/codex/contracts.ts';
import type { CodexAdmission, CodexCapabilities, CodexDetection, CodexReadOnlyProfile, CodexRunRequest, CodexSandboxReadProfile } from '../../../src/adapters/codex/contracts.ts';

export const THREAD = '019a0000-0000-7000-8000-000000000001';
/** Это полный SYNTHETIC допуск: не заключение о какой-либо установленной CLI. */
export const SYNTHETIC_ADMISSION: CodexAdmission = {
  status: 'ready', detail: 'synthetic-test-only', confirmed: [...CODEX_RESTRICTIONS], limitations: [...CODEX_LIMITATIONS],
};
export const SYNTHETIC_CAPABILITIES: CodexCapabilities = {
  execJson: true, stdinPrompt: true, resume: true, ephemeral: true, sandbox: true,
  configOverrides: true, ignoreUserConfig: true, ignoreRules: true, model: true, loginStatus: true,
  strictConfig: true, resumeStrictConfig: true,
};
export const detection = (binaryPath: string): CodexDetection => ({
  status: 'available', binaryPath, version: '0.163.0', auth: 'authenticated',
  capabilities: { ...SYNTHETIC_CAPABILITIES }, unavailable: [],
});
export const profile = (cwd: string): CodexReadOnlyProfile => ({
  kind: 'codex-read-only-v1', mode: 'read-only', sandbox: 'read-only', approvalPolicy: 'never',
  workspaceRoot: cwd, projectTrust: 'trusted', requires: [...CODEX_RESTRICTIONS],
});
export function firstRequest(cwd: string, patch: Partial<AgentRunRequestBase> = {}): CodexRunRequest {
  return {
    sessionId: 'app-session-synthetic', turnId: 'app-turn-synthetic-1', participantId: 'codex-participant-synthetic',
    workspaceId: 'workspace-synthetic', cwd, prompt: 'Синтетическая задача',
    env: { HOME: cwd, PATH: '/usr/bin:/bin' }, profile: profile(cwd), resume: false, ...patch,
  };
}
export function resumeRequest(cwd: string, threadId = THREAD): CodexRunRequest {
  return { ...firstRequest(cwd), turnId: 'app-turn-synthetic-2', resume: true, thread: { adapter: 'codex', threadId } };
}

/** Список фиксирован независимо от production-константы, чтобы её изменение не ослабило тесты. */
export const sandboxProfile = (cwd: string): CodexSandboxReadProfile => ({
  kind: 'codex-sandbox-read-v1', mode: 'read-only', sandbox: 'named-profile', approvalPolicy: 'never',
  workspaceRoot: cwd, projectTrust: 'trusted',
  requires: ['shell_sandboxed', 'reads_scoped', 'writes_forbidden', 'project_extensions_disabled', 'user_extensions_disabled'],
});
export const SYNTHETIC_SANDBOX_ADMISSION: CodexAdmission = {
  status: 'ready', detail: 'synthetic-sandbox-test-only',
  confirmed: ['shell_sandboxed', 'reads_scoped', 'writes_forbidden', 'project_extensions_disabled', 'user_extensions_disabled'],
  limitations: ['os_isolation_not_attested', 'network_not_restricted', 'detached_children_not_guaranteed', 'cli_configuration_not_audited'],
};
export function sandboxFirstRequest(cwd: string, patch: Partial<AgentRunRequestBase> = {}): CodexRunRequest {
  return { ...firstRequest(cwd, patch), profile: sandboxProfile(cwd) };
}
export function sandboxResumeRequest(cwd: string, threadId = THREAD): CodexRunRequest {
  return { ...resumeRequest(cwd, threadId), profile: sandboxProfile(cwd) };
}
