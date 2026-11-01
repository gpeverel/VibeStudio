import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGitAdapter, DEFAULT_GIT_TIMEOUTS } from '../src/adapters/git/index.ts';
import type { ApplyWorkspaceRequest, GitPort, PreparedCandidate } from '../src/core/ports/git.ts';
import { WorkspaceStand } from './workspace/stand.ts';

const stands: WorkspaceStand[] = [];
afterEach(() => { for (const own of stands.splice(0)) own.cleanup(); });

function stand(): WorkspaceStand {
  const own = new WorkspaceStand();
  stands.push(own);
  own.commit({ 'tracked.txt': 'base\n' }, 'Базовый коммит');
  return own;
}

const workspaceOf = (own: WorkspaceStand) => join(own.workspacesRoot, 's1');
const identity = (own: WorkspaceStand) => ({
  projectPath: own.project, workspacePath: workspaceOf(own), sessionId: 's1', branch: 'vs/s1', baseRef: 'main',
});

/** Сессия с собственным коммитом в workspace и (по желанию) продвинувшейся базой: тогда prepare делает настоящий merge. */
async function session(own: WorkspaceStand, adapter: GitPort, baseMoved: boolean): Promise<void> {
  await adapter.createWorkspace({ requestId: 'create-1', ...identity(own) });
  own.write(join(workspaceOf(own), 'session.txt'), 'session\n');
  own.run(workspaceOf(own), 'add', 'session.txt');
  own.run(workspaceOf(own), 'commit', '-m', 'Работа сессии');
  if (baseMoved) own.commit({ 'moved.txt': 'moved\n' }, 'База сдвинулась');
}

const mergeHead = (own: WorkspaceStand) => {
  try {
    return own.run(workspaceOf(own), 'rev-parse', '-q', '--verify', 'MERGE_HEAD');
  } catch {
    return '';
  }
};
const verification = (candidate: PreparedCandidate): ApplyWorkspaceRequest['verification'] =>
  ({ status: 'passed', revisionId: candidate.revisionId, checksFingerprint: 'checks-1' });

describe('G9: отдельные конечные пределы команд Git', () => {
  it('значения по умолчанию конечны и различаются по классам', () => {
    expect(DEFAULT_GIT_TIMEOUTS.readMs).toBeGreaterThan(0);
    expect(DEFAULT_GIT_TIMEOUTS.writeMs).toBeGreaterThan(DEFAULT_GIT_TIMEOUTS.readMs);
    expect(Number.isSafeInteger(DEFAULT_GIT_TIMEOUTS.networkMs)).toBe(true);
  });

  it('недопустимые пределы отклоняются при создании адаптера', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Infinity, 2_147_483_648]) {
      expect(() => createGitAdapter({ timeouts: { readMs: bad } }), String(bad)).toThrowError(expect.objectContaining({ code: 'invalid_request' }));
      expect(() => createGitAdapter({ timeouts: { writeMs: bad } })).toThrowError(expect.objectContaining({ code: 'invalid_request' }));
      expect(() => createGitAdapter({ timeouts: { networkMs: bad } })).toThrowError(expect.objectContaining({ code: 'invalid_request' }));
    }
  });

  it('предел чтения применяется только к чтению, и разные экземпляры не мешают друг другу', async () => {
    const own = stand();
    const strict = createGitAdapter({ timeouts: { readMs: 1 } });
    const normal = createGitAdapter();
    const [slow, fast] = await Promise.allSettled([strict.inspectRepository(own.project), normal.inspectRepository(own.project)]);
    expect(slow).toMatchObject({ status: 'rejected', reason: { code: 'git_timeout' } });
    expect(fast.status).toBe('fulfilled');
    // Короткий предел записи не затрагивает чтение.
    expect((await createGitAdapter({ timeouts: { writeMs: 1 } }).inspectRepository(own.project)).warnings).toEqual([]);
  });

  it('предел записи останавливает команду изменения и оставляет репозиторий без следов', async () => {
    const own = stand();
    const adapter = createGitAdapter({ timeouts: { writeMs: 1 } });
    await expect(adapter.createWorkspace({ requestId: 'create-1', ...identity(own) })).rejects.toMatchObject({ code: 'git_timeout' });
    expect(own.run(own.project, 'for-each-ref', 'refs/vibestudio', 'refs/heads/vs')).toBe('');
    expect(existsSync(workspaceOf(own))).toBe(false);
    expect(own.run(own.project, 'status', '--porcelain=v1')).toBe('');
  });

  it('предел сети применяется к push и даёт git_timeout, а не push_failed', async () => {
    const own = stand();
    const remote = join(own.root, 'remote.git');
    own.run(own.root, 'init', '--bare', '--initial-branch=main', remote);
    own.run(own.project, 'remote', 'add', 'origin', remote);
    await expect(createGitAdapter({ timeouts: { networkMs: 1 } }).pushWorkspace({ workspacePath: own.project, remote: 'origin', branch: 'main' }))
      .rejects.toMatchObject({ code: 'git_timeout' });
    await createGitAdapter().pushWorkspace({ workspacePath: own.project, remote: 'origin', branch: 'main' });
    expect(own.run(remote, 'rev-parse', 'refs/heads/main')).toBe(own.run(own.project, 'rev-parse', 'main'));
  });
});

describe('G9: политика подписи и автора до изменений', () => {
  it('обязательная подпись, которую приложение не выполнит, отклоняет настоящий merge до первого изменения workspace', async () => {
    const own = stand();
    const adapter = createGitAdapter();
    await session(own, adapter, true);
    own.run(own.project, 'config', '--local', 'commit.gpgsign', 'true');
    const head = own.run(workspaceOf(own), 'rev-parse', 'HEAD');

    await expect(adapter.prepareWorkspace({ requestId: 'prepare-1', ...identity(own) })).rejects.toMatchObject({ code: 'signing_required' });
    expect(own.run(workspaceOf(own), 'rev-parse', 'HEAD')).toBe(head);
    expect(mergeHead(own)).toBe('');
    expect(own.run(workspaceOf(own), 'status', '--porcelain=v1')).toBe('');

    // Без требования подписи тот же merge проходит.
    own.run(own.project, 'config', '--local', 'commit.gpgsign', 'false');
    const candidate = await adapter.prepareWorkspace({ requestId: 'prepare-2', ...identity(own) });
    expect(candidate.candidateSha).not.toBe(head);
  });

  it('если коммит не создаётся (база не сдвинулась), требование подписи не мешает подготовке', async () => {
    const own = stand();
    const adapter = createGitAdapter();
    await session(own, adapter, false);
    own.run(own.project, 'config', '--local', 'commit.gpgsign', 'true');
    const candidate = await adapter.prepareWorkspace({ requestId: 'prepare-1', ...identity(own) });
    expect(candidate.candidateSha).toBe(own.run(workspaceOf(own), 'rev-parse', 'HEAD'));
  });

  it('применение при обязательной подписи отклоняется до checkpoint и изменений основной копии', async () => {
    const own = stand();
    const adapter = createGitAdapter();
    await session(own, adapter, false);
    const candidate = await adapter.prepareWorkspace({ requestId: 'prepare-1', ...identity(own) });
    own.run(own.project, 'config', '--local', 'commit.gpgsign', 'true');
    const before = {
      head: own.run(own.project, 'rev-parse', 'HEAD'), refs: own.run(own.project, 'for-each-ref', 'refs/vibestudio'),
      status: own.run(own.project, 'status', '--porcelain=v1'),
    };
    await expect(adapter.applyWorkspace({ requestId: 'apply-1', candidate, verification: verification(candidate), checksFingerprint: 'checks-1' }))
      .rejects.toMatchObject({ code: 'signing_required' });
    expect({
      head: own.run(own.project, 'rev-parse', 'HEAD'), refs: own.run(own.project, 'for-each-ref', 'refs/vibestudio'),
      status: own.run(own.project, 'status', '--porcelain=v1'),
    }).toEqual(before);
  });

  it('автор коммита проверяется до merge: без имени и email workspace не остаётся в состоянии слияния', async () => {
    const own = stand();
    const adapter = createGitAdapter();
    await session(own, adapter, true);
    own.run(own.project, 'config', '--local', 'user.name', '');
    own.run(own.project, 'config', '--local', 'user.email', '');
    const head = own.run(workspaceOf(own), 'rev-parse', 'HEAD');
    await expect(adapter.prepareWorkspace({ requestId: 'prepare-1', ...identity(own) })).rejects.toMatchObject({ code: 'author_missing' });
    expect(own.run(workspaceOf(own), 'rev-parse', 'HEAD')).toBe(head);
    expect(mergeHead(own)).toBe('');
    expect(own.run(workspaceOf(own), 'status', '--porcelain=v1')).toBe('');
  });
});

describe('G9: hooks проекта и пользователя не исполняются', () => {
  it('hook, блокирующий merge, не запускается ни из .git/hooks, ни через core.hooksPath', async () => {
    const own = stand();
    const adapter = createGitAdapter();
    await session(own, adapter, true);
    const marker = join(own.root, 'hook-ran.txt');
    const hook = `#!/bin/sh\necho ran >> '${marker}'\nexit 1\n`;
    const installed = [join(own.project, '.git', 'hooks', 'pre-merge-commit'), join(own.project, '.git', 'hooks', 'post-merge')];
    for (const path of installed) {
      writeFileSync(path, hook);
      chmodSync(path, 0o755);
    }
    // Контроль: без политики приложения git действительно запускает этот hook.
    expect(() => own.run(workspaceOf(own), 'hook', 'run', 'pre-merge-commit')).toThrow();
    expect(existsSync(marker)).toBe(true);
    writeFileSync(marker, '');

    const candidate = await adapter.prepareWorkspace({ requestId: 'prepare-1', ...identity(own) });
    expect(candidate.candidateSha).toBe(own.run(workspaceOf(own), 'rev-parse', 'HEAD'));
    // Создан настоящий merge-коммит (два родителя), и ни один hook не выполнился.
    expect(own.run(workspaceOf(own), 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(3);
    expect(own.read(marker)).toBe('');
  });
});
