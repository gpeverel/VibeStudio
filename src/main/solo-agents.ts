import { randomUUID } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createClaudeAdapter } from '../adapters/claude/index.ts';
import { createCodexAppServerAdapter } from '../adapters/codex/app-server.ts';
import { CODEX_SANDBOX_RESTRICTIONS } from '../adapters/codex/contracts.ts';
import { createProcessRunner } from '../adapters/process-runner/index.ts';
import { createInteractiveProcessRunner } from '../adapters/process-runner/interactive.ts';
import type { ProcessRequest, ProcessRun } from '../core/ports/process-runner.ts';
import type { AppServerBinding } from '../adapters/codex/app-server.ts';
import type { AgentAdapter, AgentRunRequest, PracticalLocalReadProfile } from '../core/ports/agent.ts';
import type { CodexAppServerCapabilities, CodexAppServerRequest } from '../adapters/codex/app-server-contracts.ts';
import type { SoloAgentPort } from '../core/ports/solo-agent.ts';
import type { ParticipantRecord, Store, WorkspaceRecord } from '../core/ports/store.ts';
import { SoloEngineError } from '../core/session-engine.ts';

export interface SoloAgentsOptions {
  store: Store;
  env?: Readonly<Record<string, string | undefined>>;
  /** Подстановки только для тестов доверенной композиции; main их не предоставляет. */
  claude?: AgentAdapter;
  codex?: AgentAdapter<CodexAppServerRequest, CodexAppServerCapabilities>;
}

export function createSoloAgents(options: SoloAgentsOptions): SoloAgentPort {
  const source = options.env ?? process.env;
  const verifyThread = (binding: AppServerBinding): boolean => {
    const participant = options.store.getParticipant(binding.participantId), workspace = options.store.getWorkspace(binding.workspaceId);
    return !!participant && !!workspace && participant.cli === 'codex' && participant.profile === binding.profile
      && participant.agentSessionId === binding.threadId && participant.sessionId === binding.sessionId
      && participant.workspaceId === binding.workspaceId && workspace.sessionId === binding.sessionId
      && workspace.path === binding.cwd && binding.transport === 'app-server';
  };
  // Не запускает диагностику или модель до пользовательской команды sendTurn.
  return {
    async start({ participant, turn, workspace, onProcessStarted }) {
      const saved = options.store.getParticipant(participant.id);
      const savedWorkspace = options.store.getWorkspace(workspace.id);
      if (!saved || !savedWorkspace || savedWorkspace.path !== workspace.path || savedWorkspace.sessionId !== workspace.sessionId
          || saved.sessionId !== turn.sessionId || saved.workspaceId !== workspace.id
          || workspace.sessionId !== turn.sessionId || turn.participantId !== participant.id
          || saved.cli !== participant.cli || saved.profile !== participant.profile
          || saved.agentSessionId !== participant.agentSessionId) throw new SoloEngineError('foreign_entity', 'Контекст запуска не принадлежит участнику.');
      const base = { sessionId: turn.sessionId, turnId: turn.id, participantId: participant.id,
        workspaceId: workspace.id, cwd: workspace.path, prompt: turn.prompt, env: {}, persistSession: true };
      const processRunner = createProcessRunner(), interactiveRunner = createInteractiveProcessRunner();
      const track = <T extends ProcessRun>(request: ProcessRequest, start: () => T): T => {
        const run = start();
        try { onProcessStarted?.({ pid: run.pid, requestedExecutable: request.executable, cwd: request.cwd, spawnObservedAt: new Date().toISOString() }); }
        catch (cause) { void run.interrupt().catch(() => undefined); throw cause; }
        return run;
      };
      const runner = { start: (request: ProcessRequest) => track(request, () => processRunner.start(request)) };
      if (participant.cli === 'claude') {
        if (participant.profile !== 'practical-local-v1') throw new SoloEngineError('adapter_unavailable', 'Профиль Claude не поддержан.');
        const profile: PracticalLocalReadProfile = { kind: 'practical-local-v1', mode: 'read-only',
          tools: ['Read', 'Glob', 'Grep'], allow: [], deny: [], workspaceRoot: workspace.path, projectTrust: 'trusted',
          configPolicy: { settingSources: [], projectHooks: 'disabled', projectMcp: 'disabled', projectPlugins: 'disabled' } };
        const request: AgentRunRequest = { ...base, profile, agentSessionId: participant.agentSessionId ?? randomUUID(), resume: !!participant.agentSessionId };
        return (options.claude ?? createClaudeAdapter({ runner })).start(request);
      }
      if (participant.cli !== 'codex' || participant.profile !== 'codex-app-server-read-v1') throw new SoloEngineError('adapter_unavailable', 'Профиль Codex не поддержан.');
      const profile = { kind: 'codex-app-server-read-v1' as const, mode: 'read-only' as const, sandbox: 'named-profile' as const,
        approvalPolicy: 'never' as const, workspaceRoot: workspace.path, projectTrust: 'trusted' as const, requires: CODEX_SANDBOX_RESTRICTIONS };
      const codex = options.codex ?? createCodexAppServerAdapter({ verifyThread, runner,
        interactiveRunner: { start: request => track(request, () => interactiveRunner.start(request)) } });
      return codex.start(participant.agentSessionId
        ? { ...base, profile, resume: true, thread: { adapter: 'codex', threadId: participant.agentSessionId } }
        : { ...base, profile, resume: false });
    },
    history: (participant, workspace) => ownHistory(source, participant, workspace),
  };
}

/** Только имена каталогов и метаданные файла UUID собственной беседы.
 * Содержимое чужих историй/credentials не открывается; неизвестная структура не даёт resume. */
export async function ownHistory(env: Readonly<Record<string, string | undefined>>, participant: ParticipantRecord,
  workspace: WorkspaceRecord): Promise<'available' | 'missing' | 'unknown'> {
  if (participant.workspaceId !== workspace.id || participant.sessionId !== workspace.sessionId
      || !participant.agentSessionId || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(participant.agentSessionId)) return 'unknown';
  const home = env.HOME; if (!home || !isAbsolute(home)) return 'unknown';
  const root = participant.cli === 'claude' ? join(env.CLAUDE_CONFIG_DIR ?? join(home, '.claude'), 'projects')
    : join(env.CODEX_HOME ?? join(home, '.codex'), 'sessions');
  if (!isAbsolute(root)) return 'unknown';
  let visited = 0, found = 0, ambiguous = false;
  async function walk(dir: string, depth: number): Promise<void> {
    if (++visited > 10_000) throw new Error('limit');
    const info = await lstat(dir); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('directory');
    const entries = await readdir(dir, { withFileTypes: true });
    if (entries.length > 20_000) throw new Error('limit');
    for (const entry of entries) {
      const own = participant.cli === 'claude' ? entry.name === `${participant.agentSessionId}.jsonl`
        : entry.name.startsWith('rollout-') && entry.name.endsWith(`-${participant.agentSessionId}.jsonl`);
      if (own) {
        const file = await lstat(join(dir, entry.name));
        if (file.isFile() && !file.isSymbolicLink() && file.size > 0) found++; else ambiguous = true;
      } else if (depth > 0 && entry.isDirectory() && !entry.isSymbolicLink()
          && (participant.cli === 'claude' || /^\d{2,4}$/.test(entry.name))) await walk(join(dir, entry.name), depth - 1);
    }
  }
  try { await walk(root, participant.cli === 'claude' ? 1 : 3); }
  catch (cause) { return (cause as { code?: string }).code === 'ENOENT' ? 'missing' : 'unknown'; }
  return ambiguous || found > 1 ? 'unknown' : found === 1 ? 'available' : 'missing';
}
