import type { AgentDiagnostic, AgentErrorReason, AgentEvent, AgentRunResult } from '../../shared/agent.ts';
export type { AgentDiagnostic, AgentErrorReason, AgentEvent, AgentRunResult, AgentUsage, NormalizedPayload } from '../../shared/agent.ts';

export type ReadTool = 'Read' | 'Glob' | 'Grep';
export interface AccessProfile {
  mode: 'read-only';
  tools: readonly ReadTool[];
  allow: readonly string[];
  deny: readonly string[];
  configPolicy: {
    settingSources: readonly [];
    loadHooks: false;
    loadMcp: false;
    loadPlugins: false;
  };
  fs: {
    readRoots: readonly string[];
    writeRoots: readonly [];
    runtimeWriteRoots: readonly string[];
    protectedPaths: readonly string[];
    gitCommonDir?: string;
  };
  network: 'provider-only';
}

/** Значения принимаются только из документированного allowlist адаптера. */
export type AgentEnvironment = Readonly<Record<string, string>>;
export interface AgentRunRequest {
  sessionId: string;
  turnId: string;
  participantId: string;
  workspaceId: string;
  cwd: string;
  prompt: string;
  agentSessionId: string;
  resume: boolean;
  profile: AccessProfile;
  model?: string;
  maxTurns?: number;
  env: AgentEnvironment;
  persistSession?: boolean;
}
export interface AgentCapabilities {
  streamJson: boolean;
  partialMessages: boolean;
  sessionId: boolean;
  resume: boolean;
  noSessionPersistence: boolean;
  maxTurns: boolean;
  restricted: boolean;
  safeMode: boolean;
  tools: boolean;
  settingSources: boolean;
  strictMcpConfig: boolean;
  permissionPrompts: boolean;
  readOnly: 'verified' | 'unverified' | 'unsupported';
}
export interface AgentDetection {
  status: 'available' | 'unavailable';
  binaryPath: string | null;
  version: string | null;
  auth: 'authenticated' | 'unauthenticated' | 'unknown';
  capabilities: AgentCapabilities;
  unavailable: { reason: AgentErrorReason; detail: string }[];
}
export interface AgentDetectOptions { binaryPath?: string; env?: AgentEnvironment }
export interface AgentRun {
  events: AsyncIterable<AgentEvent>;
  interrupt(): Promise<void>;
  kill(): Promise<void>;
  done: Promise<AgentRunResult>;
  readonly diagnostics: readonly AgentDiagnostic[];
}
export interface AgentAdapter {
  detect(options?: AgentDetectOptions): Promise<AgentDetection>;
  start(request: AgentRunRequest): Promise<AgentRun>;
}
