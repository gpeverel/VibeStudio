import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createGitAdapter } from '../adapters/git/index.ts';
import { createProjectCommandSnapshotPort } from '../adapters/project-command-snapshot/index.ts';
import { openSqliteStorage } from '../adapters/store/index.ts';
import { createWorkspaceFiles } from '../adapters/workspace-files/index.ts';
import { createJournal } from '../adapters/journal/index.ts';
import { createProjectCommandRunner } from '../adapters/project-command-runner/index.ts';
import { createProcessRunner } from '../adapters/process-runner/index.ts';
import { createProjectCommandConsent } from '../core/project-command-consent.ts';
import { createSessionEngine } from '../core/session-engine.ts';
import type { ProjectCommandRequest } from '../core/ports/project-command-snapshot.ts';
import { createSoloAgents } from './solo-agents.ts';

/** Производственная композиция. Здесь нет detect/admission/agent doubles. */
export async function createProductionComposition(dataDirectory: string) {
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const storage = openSqliteStorage(join(dataDirectory, 'vibestudio.sqlite'));
  const { store } = storage;
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  const now = () => new Date().toISOString();
  const git = createGitAdapter({ store: storage.gitOperationStore });
  const consent = createProjectCommandConsent(createProjectCommandSnapshotPort(), {
    find: operationId => store.findConsent(operationId), get: consentId => store.getConsent(consentId),
    save: record => {
      const workspace = record.operationId.startsWith('setup:') ? store.getWorkspace(record.operationId.slice(6)) : undefined;
      store.commit({ consents: [record], events: workspace ? [{ id: randomUUID(), sessionId: workspace.sessionId,
        timestamp: now(), payload: { type: 'diagnostic', code: `consent_${record.status}`,
          detail: record.status === 'granted' ? 'Сохранено конкретное согласие на setup.'
            : record.status === 'revoked' ? 'Согласие отозвано.' : 'Согласие больше не соответствует исполняемым входам.' } }] : [] });
    }, digest, nextId: randomUUID, now,
  });
  const engine = createSessionEngine({ store, consent,
    git, gitOperations: storage.gitOperationStore,
    files: createWorkspaceFiles({ workspacesRoot: join(dataDirectory, 'workspaces'), git }),
    journal: createJournal({ directory: join(dataDirectory, 'diagnostics') }),
    commands: createProjectCommandRunner({ runner: createProcessRunner() }),
    agents: createSoloAgents({ store }), clock: { now }, ids: { next: randomUUID }, fingerprints: { digest },
    setupRequest(project, workspace): ProjectCommandRequest {
      if (!project.config.setup) throw new Error('Подготовка не настроена.');
      const env: Record<string, string> = {};
      for (const key of ['HOME', 'PATH', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR']) {
        const value = process.env[key]; if (value !== undefined) env[key] = value;
      }
      env.PATH ??= '/usr/bin:/bin';
      return { projectId: project.id, projectRoot: workspace.path, operationId: `setup:${workspace.id}`,
        purpose: 'setup', command: project.config.setup, cwd: workspace.path, env,
        permissions: { fileSystem: 'unrestricted', network: 'allowed', elevated: false } };
    },
  });
  try { await engine.recover(); }
  catch (cause) { storage.close(); throw cause; }
  return { engine, close: () => storage.close() };
}
