import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSessionEngine } from '../../src/core/session-engine.ts';
import type { SessionEngineOptions } from '../../src/core/session-engine.ts';
import { createProjectCommandConsent } from '../../src/core/project-command-consent.ts';
import { createProjectCommandSnapshotPort } from '../../src/adapters/project-command-snapshot/index.ts';
import { openSqliteStorage } from '../../src/adapters/store/index.ts';
import type { SqliteStorageOptions } from '../../src/adapters/store/index.ts';
import { createGitAdapter } from '../../src/adapters/git/index.ts';
import { createProjectCommandRunner } from '../../src/adapters/project-command-runner/index.ts';
import { createProcessRunner } from '../../src/adapters/process-runner/index.ts';
import { createWorkspaceFiles } from '../../src/adapters/workspace-files/index.ts';
import { createJournal } from '../../src/adapters/journal/index.ts';
import { createIpcHandlers } from '../../src/main/ipc.ts';
import type { WorkspaceFiles } from '../../src/core/ports/workspace-files.ts';
import type { ProjectRecord } from '../../src/core/ports/store.ts';
import type { ApiResult } from '../../src/shared/solo.ts';
import { createControlledAgent } from './p5-agent.ts';
import { consentPersistence, digest } from './p5-consent.ts';

export function must<T>(result: ApiResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}
export async function until(check: () => boolean, timeout = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error('Условие стенда не наступило в срок.');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
export function openEngineStand(directory: string, options: {
  agent?: ReturnType<typeof createControlledAgent>;
  setup?: boolean;
  storage?: SqliteStorageOptions;
  fault?: SessionEngineOptions['faultInjector'];
  files?: WorkspaceFiles;
  commands?: SessionEngineOptions['commands'];
  journal?: SessionEngineOptions['journal'];
  stopTimeoutMs?: number;
  onCreateWorkspace?: () => void;
} = {}) {
  mkdirSync(directory, { recursive: true });
  const root = realpathSync(directory), projectPath = join(root, 'project'), workspaceRoot = join(root, 'workspaces');
  mkdirSync(workspaceRoot, { recursive: true });
  if (!existsSync(projectPath)) {
    mkdirSync(projectPath);
    const git = (args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd: projectPath, stdio: 'pipe', timeout: 10_000 });
    git(['init', '-b', 'main']);
    writeFileSync(join(projectPath, 'README.md'), 'Собственный временный проект P5.\n');
    writeFileSync(join(projectPath, 'setup.cjs'), 'require("node:fs").appendFileSync("setup-effects.txt", "setup\\n");\n');
    git(['add', '.']); git(['-c', 'user.name=P5 Test', '-c', 'user.email=p5@example.invalid', 'commit', '-m', 'fixture']);
  }
  const storage = openSqliteStorage(join(root, 'state.sqlite'), options.storage);
  const agent = options.agent ?? createControlledAgent();
  const config: ProjectRecord['config'] = { setup: options.setup ? { kind: 'direct', executable: process.execPath, args: ['setup.cjs'], inputFiles: [] } : null,
    copyFiles: [], setupTimeoutMs: 1000 };
  const realGit = createGitAdapter({ store: storage.gitOperationStore });
  const git = { ...realGit, createWorkspace(request: Parameters<typeof realGit.createWorkspace>[0]) {
    options.onCreateWorkspace?.();
    return realGit.createWorkspace(request);
  } };
  const productionFiles = createWorkspaceFiles({ workspacesRoot: workspaceRoot, git });
  // Only the test's named setup configuration is supplied here; paths, worktree checks and copying are production code.
  const files: WorkspaceFiles = options.files ?? {
    ...productionFiles, inspectProject: async path => ({ ...await productionFiles.inspectProject(path), config }),
  };
  const consent = createProjectCommandConsent(createProjectCommandSnapshotPort(), consentPersistence(storage.store));
  const engine = createSessionEngine({ store: storage.store, git, gitOperations: storage.gitOperationStore,
    files, agents: agent.port, consent,
    commands: options.commands ?? createProjectCommandRunner({ runner: createProcessRunner() }),
    journal: options.journal ?? createJournal({ directory: join(root, 'diagnostics') }), clock: { now: () => new Date().toISOString() }, ids: { next: randomUUID },
    fingerprints: { digest }, stopTimeoutMs: options.stopTimeoutMs ?? 80, faultInjector: options.fault,
    setupRequest: (project, workspace) => {
      if (!project.config.setup) throw new Error('Setup не настроен');
      return { projectId: project.id, projectRoot: workspace.path, operationId: `setup:${workspace.id}`, purpose: 'setup',
        command: project.config.setup, cwd: workspace.path, env: {},
        permissions: { fileSystem: 'workspace-write', network: 'denied', elevated: false } };
    },
  });
  const source = Object.freeze({ ownWindow: randomUUID() });
  const ipc = createIpcHandlers({ engine, selectProject: async () => projectPath, authorize: origin => origin === source });
  async function create(cli: 'claude' | 'codex' = 'claude') {
    const project = must(await ipc.selectProject(source, { requestId: randomUUID() }));
    if (!project) throw new Error('Не выбран проект');
    const operation = must(await ipc.createSession(source, { requestId: randomUUID(), projectId: project.id, cli }));
    await engine.waitForIdle();
    const session = must(await ipc.getSession(source, { sessionId: operation.sessionId }));
    if (session.status !== (options.setup ? 'needs_consent' : 'ready')) throw new Error(`Не подготовлена сессия: ${JSON.stringify(session)}`);
    return session;
  }
  return { root, projectPath, storage, store: storage.store, engine, agent, source, ipc, create, consent,
    close: async () => { await engine.shutdown(); storage.close(); } };
}
