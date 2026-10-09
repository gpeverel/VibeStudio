import { buildAgentInstructions } from '../../core/agent-instructions.ts';
import type { AgentEnvironment, AgentRunRequest } from '../../core/ports/agent.ts';
import { BLOCKED_TOOLS, validateAccessProfile } from './profile.ts';

/** HOME/CLAUDE_CONFIG_DIR сохраняют штатный OAuth/Keychain; токены не журналируются.
 * PATH нужен launcher-скриптам; локаль — UTF-8; TMPDIR — служебным файлам CLI.
 * NODE_OPTIONS, DYLD_*, прокси, произвольные CLAUDE_* и env проекта не наследуются. */
export const CLAUDE_ENV_ALLOWLIST = [
  'HOME', 'PATH', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR',
  'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
] as const;

export function buildClaudeEnv(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of CLAUDE_ENV_ALLOWLIST) {
    const value = source[name];
    if (value !== undefined && !value.includes('\0')) env[name] = value;
  }
  // Не устанавливать и не обновлять CLI, не отправлять необязательную телеметрию.
  env.DISABLE_AUTOUPDATER = '1';
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  return env;
}

export function buildClaudeArgs(request: AgentRunRequest): { args: string[]; stdin: string; env: Record<string, string> } {
  const issues = validateAccessProfile(request.profile, request.cwd);
  if (issues.length) throw new Error(issues[0]!.detail);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.agentSessionId)) throw new Error('agentSessionId должен быть UUID');
  if (request.resume && request.persistSession === false) throw new Error('Resume требует сохранения диалога');
  if (request.maxTurns !== undefined && (!Number.isSafeInteger(request.maxTurns) || request.maxTurns < 1)) throw new Error('maxTurns должен быть положительным целым');
  if ([request.sessionId, request.turnId, request.participantId, request.workspaceId].some(id => !id || id.length > 256)) throw new Error('Не заданы идентификаторы запуска');
  if (typeof request.prompt !== 'string' || Buffer.byteLength(request.prompt) > 10_000_000) throw new Error('Превышен размер prompt');
  const args = [
    '--print', '--verbose', '--input-format', 'text', '--output-format', 'stream-json',
    '--include-partial-messages', '--restricted', '--safe-mode',
    '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--tools', request.profile.tools.join(','),
    '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
    '--disable-slash-commands', '--no-chrome',
    '--disallowedTools', [...new Set([...BLOCKED_TOOLS, ...request.profile.deny])].join(','),
    '--system-prompt-snapshot', 'off',
    '--append-system-prompt', buildAgentInstructions({ resume: request.resume }),
    request.resume ? '--resume' : '--session-id', request.agentSessionId,
  ];
  if (request.profile.allow.length) args.push('--allowedTools', request.profile.allow.join(','));
  if (request.model) args.push('--model', request.model);
  if (request.maxTurns !== undefined) args.push('--max-turns', String(request.maxTurns));
  if (request.persistSession === false) args.push('--no-session-persistence');
  return { args, stdin: request.prompt, env: buildClaudeEnv(request.env as AgentEnvironment) };
}
