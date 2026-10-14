import { createHash } from 'node:crypto';
import type { ClaudeAdmissionFacts } from '../../../src/adapters/claude/admission.ts';
import { buildClaudeArgs } from '../../../src/adapters/claude/args.ts';
import type { PracticalAdmissionContext, RuntimeInventoryExpectation } from '../../../src/adapters/claude/profile.ts';
import type { AgentCapabilities, AgentRunRequest, PracticalLocalReadProfile } from '../../../src/core/ports/agent.ts';
import { practicalRequest } from './requests.ts';

/** Только искусственные данные P2b. Ни один helper не утверждает готовность реальной CLI. */
export const SYNTHETIC_SESSION = '11111111-1111-4111-8111-111111111111';
export const SYNTHETIC_CAPABILITIES: AgentCapabilities = {
  streamJson: true, partialMessages: true, sessionId: true, resume: true, noSessionPersistence: true, maxTurns: true,
  restricted: true, safeMode: true, tools: true, settingSources: true, strictMcpConfig: true, permissionPrompts: true,
  readOnly: 'unverified',
};
/** Ожидание сформировано независимо от parser и production expectedInventoryFor. */
export const independentInventoryId = (name: string): string => `sha256:${createHash('sha256').update(name).digest('hex')}`;
export function syntheticExpectation(): RuntimeInventoryExpectation {
  return {
    tools: ['Read', 'Glob', 'Grep'],
    plugins: ['cc-plugin-agents-md', 'cc-plugin-plugin-authoring'].map(name => ({ id: independentInventoryId(name), origin: 'builtin' })),
    mcpServers: [], skills: [], slashCommands: [], agents: ['claude', 'Explore', 'general-purpose', 'Plan'].map(independentInventoryId),
    cliVersion: '2.1.295', permissionMode: 'dontAsk',
  };
}
export function syntheticInit(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'system', subtype: 'init', session_id: SYNTHETIC_SESSION,
    tools: ['Read', 'Glob', 'Grep'],
    plugins: ['cc-plugin-agents-md', 'cc-plugin-plugin-authoring'].map(name => ({ name, path: 'builtin', source: `${name}@builtin` })),
    mcp_servers: [], skills: [], slash_commands: [], agents: ['claude', 'Explore', 'general-purpose', 'Plan'],
    claude_code_version: '2.1.295', permissionMode: 'dontAsk', ...patch,
  };
}
export function syntheticResult(): Record<string, unknown> {
  return { type: 'result', subtype: 'success', is_error: false, result: 'Готово', session_id: SYNTHETIC_SESSION };
}
export function jsonLines(...values: unknown[]): Buffer {
  return Buffer.from(values.map(value => JSON.stringify(value)).join('\n') + '\n');
}
export function syntheticContext(cwd = '/tmp/p2b-synthetic', binaryPath = '/tmp/p2b-synthetic/claude'): PracticalAdmissionContext {
  const request = practicalRequest(cwd, { agentSessionId: SYNTHETIC_SESSION,
    env: { HOME: '/tmp/p2b-auth', PATH: '/usr/bin:/bin' } }) as AgentRunRequest & { profile: PracticalLocalReadProfile };
  const built = buildClaudeArgs(request);
  return {
    request, args: built.args, env: built.env,
    detection: { status: 'available', binaryPath, version: '2.1.295', auth: 'authenticated', capabilities: { ...SYNTHETIC_CAPABILITIES }, unavailable: [] },
  };
}
export const syntheticKnown = <T>(value: T) => ({ state: 'known' as const, value, provenance: 'synthetic' as const });
export function syntheticFacts(context: PracticalAdmissionContext): ClaudeAdmissionFacts {
  return {
    executable: syntheticKnown({ path: context.detection.binaryPath!, size: 1234, mtimeMs: 1000 }),
    managed: syntheticKnown({ observed: ['file', 'os-policy', 'server-managed'] as const,
      policyDigest: createHash('sha256').update('synthetic-empty-effective-policy').digest('hex'), executableConfig: 'none' as const }),
  };
}
