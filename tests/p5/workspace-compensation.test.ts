import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createGitAdapter } from '../../src/adapters/git/index.ts';
import { createWorkspaceFiles } from '../../src/adapters/workspace-files/index.ts';
import { openEngineStand } from '../helpers/p5-engine.ts';

it('P5: компенсация копирования сохраняет пользовательский файл, заменивший созданный', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vs-p5-compensation-')));
  const s = openEngineStand(root);
  try {
    writeFileSync(join(s.projectPath, '.gitignore'), 'local-data.txt\n');
    writeFileSync(join(s.projectPath, 'local-data.txt'), 'исходный локальный файл');
    const git = (args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd: s.projectPath, timeout: 10_000, stdio: 'pipe' });
    git(['add', '.gitignore']); git(['-c', 'user.name=P5 Test', '-c', 'user.email=p5@example.invalid', 'commit', '-m', 'copy fixture']);
    await s.engine.recover(); const session = await s.create();
    const workspace = s.store.getSessionWorkspace(session.id)!;
    const project = s.store.getProject(session.projectId)!;
    const copy = createWorkspaceFiles({ workspacesRoot: join(root, 'workspaces'), git: createGitAdapter(),
      faultInjector: (_point, destination) => {
        unlinkSync(destination); writeFileSync(destination, 'новые пользовательские данные');
        throw new Error('исходная ошибка копирования');
      } });
    await expect(copy.copyFiles({ ...project, config: { ...project.config, copyFiles: ['local-data.txt'] } }, workspace))
      .rejects.toMatchObject({ code: 'copy_failed' });
    const destination = join(workspace.path, 'local-data.txt');
    expect(existsSync(destination)).toBe(true);
    expect(readFileSync(destination, 'utf8')).toBe('новые пользовательские данные');
  } finally { await s.close(); rmSync(root, { recursive: true, force: true }); }
});
