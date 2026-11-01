// Дочерний процесс для проверки durable-журнала Git: на заданной точке он убивает сам себя SIGKILL.
// Запуск: node --experimental-transform-types git-crash-child.ts <db> <project> <workspace> <session> <point>
import { createGitAdapter } from '../../src/adapters/git/index.ts';
import { openSqliteStorage } from '../../src/adapters/store/index.ts';
import type { GitFaultPoint } from '../../src/core/ports/git.ts';

const [dbPath, projectPath, workspacePath, sessionId, point] = process.argv.slice(2);
if (!dbPath || !projectPath || !workspacePath || !sessionId || !point) throw new Error('Недостаточно аргументов.');

const storage = openSqliteStorage(dbPath);
const adapter = createGitAdapter({
  store: storage.gitOperationStore,
  faultInjector: (current: GitFaultPoint) => {
    if (current === point) process.kill(process.pid, 'SIGKILL');
  },
});
await adapter.createWorkspace({
  requestId: 'create-crash', projectPath, workspacePath, sessionId, branch: `vs/${sessionId}`, baseRef: 'main',
});
storage.close();
