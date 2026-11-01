import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createGitAdapter } from '../../src/adapters/git/index.ts';
import type { ProjectRecord, WorkspaceRecord } from '../../src/core/ports/store.ts';
import { runTestProcess } from '../helpers/process.ts';

const IDENTITY = ['-c', 'user.name=Workspace Test', '-c', 'user.email=workspace@example.invalid', '-c', 'commit.gpgsign=false'];

/** Собственный репозиторий и корень workspace во временном каталоге; всё удаляется целиком. */
export class WorkspaceStand {
  readonly root = realpathSync(mkdtempSync(join(tmpdir(), 'vs-p5-workspace-')));
  readonly project = join(this.root, 'project with spaces');
  readonly workspacesRoot = join(this.root, 'workspaces');
  readonly git = createGitAdapter();

  constructor() {
    mkdirSync(this.project, { recursive: true });
    mkdirSync(this.workspacesRoot, { recursive: true });
    this.run(this.project, 'init', '--initial-branch=main');
  }

  run(cwd: string, ...args: string[]): string {
    return runTestProcess('git', [...IDENTITY, ...args], { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } }).trim();
  }

  write(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }

  read(path: string): string { return readFileSync(path, 'utf8'); }

  /** Коммит файлов проекта: имя → содержимое. */
  commit(files: Record<string, string>, message = 'Коммит стенда'): void {
    for (const [name, content] of Object.entries(files)) this.write(join(this.project, name), content);
    this.run(this.project, 'add', '--', ...Object.keys(files));
    this.run(this.project, 'commit', '-m', message);
  }

  /** Настоящий worktree через Git-адаптер: та же привязка сессии, что использует приложение. */
  async createWorkspace(sessionId = 'session-1'): Promise<WorkspaceRecord> {
    const path = join(this.workspacesRoot, sessionId);
    const branch = `vs/${sessionId}`;
    await this.git.createWorkspace({
      requestId: `create-${sessionId}`, projectPath: this.project, workspacePath: path, sessionId, branch, baseRef: 'main',
    });
    return {
      id: `workspace-${sessionId}`, sessionId, path, branch, baseRef: 'main', initialBaseSha: null, state: 'ready',
      setupState: 'not_configured', setupDecision: null, setupCompletion: null, configVersion: 1,
    };
  }

  projectRecord(copyFiles: readonly string[] = []): ProjectRecord {
    return {
      id: 'project-1', canonicalPath: realpathSync(this.project), name: 'project', defaultBranch: 'main', configVersion: 1,
      config: { setup: null, copyFiles, setupTimeoutMs: 60_000 },
    };
  }

  /** Возвращает права, чтобы rmSync смог удалить каталог. */
  cleanup(): void {
    for (const path of [this.workspacesRoot, this.project]) {
      try { chmodSync(path, 0o700); } catch { /* каталога уже нет */ }
    }
    rmSync(this.root, { recursive: true, force: true });
  }
}
