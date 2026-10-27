import type { AgentDetection, AgentRunRequestBase } from '../../core/ports/agent.ts';
import type { CodexSandboxReadProfile, CodexThreadRef } from './contracts.ts';

/** Новый транспорт имеет собственный профиль; exec-профили не получают иных прав. */
export type CodexAppServerProfile = Omit<CodexSandboxReadProfile, 'kind'> & { kind: 'codex-app-server-read-v1' };
export type CodexAppServerRequest = AgentRunRequestBase & { profile: CodexAppServerProfile } & (
  | { resume: false; thread?: never }
  | { resume: true; thread: CodexThreadRef }
);
export interface CodexAppServerCapabilities { appServer: boolean; strictConfig: boolean; loginStatus: boolean }
export type CodexAppServerDetection = AgentDetection<CodexAppServerCapabilities>;
