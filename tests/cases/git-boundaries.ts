import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import type {
  ApplyWorkspaceRequest, ApplyWorkspaceResult, GitAdapterOptions, GitFaultPoint, GitOperation,
  GitOperationStore, PreparedCandidate,
} from '../../src/core/ports/git.ts';
import type { CreateGitAdapter, GitBoundaryAdapter } from '../contracts/git-boundaries.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const implementation = join(root, 'src/adapters/git/index.ts');
const gitEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Spec Test',
  GIT_AUTHOR_EMAIL: 'spec@example.invalid',
  GIT_COMMITTER_NAME: 'Spec Test',
  GIT_COMMITTER_EMAIL: 'spec@example.invalid',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function adapter(options?: GitAdapterOptions): Promise<GitBoundaryAdapter> {
  assert.ok(existsSync(implementation), 'RED_MISSING_IMPLEMENTATION: требуется src/adapters/git/index.ts');
  const module = await import(/* @vite-ignore */ pathToFileURL(implementation).href) as {
    createGitAdapter: CreateGitAdapter;
  };
  assert.equal(typeof module.createGitAdapter, 'function', 'Адаптер должен экспортировать createGitAdapter');
  return module.createGitAdapter(options);
}

/**
 * Тестовый Store живёт в памяти процесса теста. Он проверяет протокол записи фаз и сверки,
 * но не доказывает восстановление после падения приложения: durable-хранилище — этап 1.
 */
function memoryStore(): GitOperationStore {
  const operations = new Map<string, GitOperation>();
  return {
    async get(requestId) {
      const found = operations.get(requestId);
      return found ? structuredClone(found) : undefined;
    },
    async save(operation) {
      operations.set(operation.requestId, structuredClone(operation));
    },
    async list() {
      return [...operations.values()].map((operation) => structuredClone(operation));
    },
  };
}

/** Исключение из faultInjector имитирует смерть процесса: адаптер не должен его перехватывать. */
class SimulatedCrash extends Error {}

/** Порядок точек инъекции в успешном применении. */
const FAULT_POINTS: readonly GitFaultPoint[] = [
  'after_intent', 'before_checkpoint', 'after_checkpoint', 'before_commit', 'after_commit',
  'before_files', 'after_files', 'before_ref', 'after_ref', 'before_result', 'after_result',
];

type Outcome = { result: ApplyWorkspaceResult; error?: undefined } | { result?: undefined; error: unknown };
async function outcome(promise: Promise<ApplyWorkspaceResult>): Promise<Outcome> {
  try {
    return { result: await promise };
  } catch (error) {
    return { error };
  }
}

function errorCode(error: unknown): unknown {
  return (error as { code?: unknown }).code;
}

async function rejectsWith(promise: Promise<unknown>, code: string | string[]): Promise<void> {
  const codes = Array.isArray(code) ? code : [code];
  await assert.rejects(promise, (error: unknown) => {
    const failure = error as { code?: unknown; message?: string };
    assert.ok(codes.includes(String(failure.code)), `ожидался код ${codes.join('|')}, получено ${String(failure.code)}: ${failure.message}`);
    return true;
  });
}

function applied(result: ApplyWorkspaceResult | undefined): Extract<ApplyWorkspaceResult, { status: 'applied' }> {
  assert.equal(result?.status, 'applied');
  if (result?.status !== 'applied') throw new Error('unreachable');
  return result;
}

type TestFunction = () => void | Promise<void>;
export interface TestApi {
  beforeEach: (fn: TestFunction) => unknown;
  afterEach: (fn: TestFunction) => unknown;
  describe: (name: string, fn: () => void) => unknown;
  it: (name: string, fn: TestFunction) => unknown;
}

export function registerGitBoundaryTests({ beforeEach, afterEach, describe, it }: TestApi): void {
  let sandbox: string;
  let project: string;
  let workspace: string;
  let store: GitOperationStore;

  async function initRepository(path: string, commit = true): Promise<void> {
    await mkdir(path, { recursive: true });
    git(path, 'init', '--initial-branch=main');
    git(path, 'config', '--local', 'user.name', 'Spec Test');
    git(path, 'config', '--local', 'user.email', 'spec@example.invalid');
    if (commit) {
      await writeFile(join(path, 'tracked.txt'), 'base\n');
      git(path, 'add', 'tracked.txt');
      git(path, 'commit', '-m', 'Базовый коммит');
    }
  }

  /** Адаптер с чистым тестовым Store; options.faultInjector задаёт точки сбоя. */
  function adapterWithStore(options: Omit<GitAdapterOptions, 'store'> = {}): Promise<GitBoundaryAdapter> {
    store = memoryStore();
    return adapter({ ...options, store });
  }

  function vibestudioRefs(path = project): string {
    return git(path, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/vibestudio');
  }

  function operationRefs(path = project): string[] {
    return vibestudioRefs(path).split('\n').filter((line) => line.includes('/operations/'));
  }

  /** Незавершённые Git-операции основной копии; пустой список означает отсутствие следов. */
  function unfinishedGitState(path = project): string[] {
    return ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'SQUASH_MSG']
      .filter((name) => existsSync(join(path, git(path, 'rev-parse', '--git-path', name))));
  }

  function snapshot(path: string) {
    return {
      head: git(path, 'rev-parse', 'HEAD'),
      status: git(path, 'status', '--porcelain=v1', '--untracked-files=all'),
      diff: git(path, 'diff', 'HEAD'),
    };
  }

  /** Полное состояние основной копии: HEAD, индекс, файлы, служебные refs и незавершённые операции. */
  function fullSnapshot(path = project) {
    return {
      ...snapshot(path),
      branch: git(path, 'branch', '--show-current'),
      cached: git(path, 'diff', '--cached'),
      refs: vibestudioRefs(path),
      unfinished: unfinishedGitState(path),
    };
  }

  function commitCount(): number {
    return Number(git(project, 'rev-list', '--count', 'HEAD'));
  }

  function identity(baseRef = 'main') {
    return { projectPath: project, workspacePath: workspace, sessionId: 'boundary',
      branch: 'vs/boundary-task', baseRef };
  }

  function createRequest(baseRef = 'main', requestId = 'create-1') {
    return { ...identity(baseRef), requestId };
  }

  function prepare(sut: GitBoundaryAdapter, requestId = 'prepare-1', baseRef = 'main'): Promise<PreparedCandidate> {
    return sut.prepareWorkspace({ ...identity(baseRef), requestId });
  }

  function applyRequest(
    candidate: PreparedCandidate, requestId = 'apply-1', overrides: Partial<ApplyWorkspaceRequest> = {},
  ): ApplyWorkspaceRequest {
    return {
      requestId,
      candidate,
      verification: { status: 'passed', revisionId: candidate.revisionId, checksFingerprint: 'checks-1' },
      checksFingerprint: 'checks-1',
      ...overrides,
    };
  }

  async function sessionCommit(file: string, content: string, message = 'Изменение сессии'): Promise<void> {
    await mkdir(dirname(join(workspace, file)), { recursive: true });
    await writeFile(join(workspace, file), content);
    git(workspace, 'add', file);
    git(workspace, 'commit', '-m', message);
  }

  /** Worktree создаётся через порт, чтобы связь session/branch/workspace была сохранена адаптером. */
  async function startSession(sut: GitBoundaryAdapter, baseRef = 'main'): Promise<void> {
    await sut.createWorkspace(createRequest(baseRef));
  }

  async function committedSession(sut: GitBoundaryAdapter): Promise<void> {
    await startSession(sut);
    await sessionCommit('session.txt', 'session\n');
  }

  async function preparedSession(sut: GitBoundaryAdapter): Promise<PreparedCandidate> {
    await committedSession(sut);
    return prepare(sut);
  }

  async function externalCommit(file: string, content: string): Promise<string> {
    await writeFile(join(project, file), content);
    git(project, 'add', file);
    git(project, 'commit', '-m', `Внешний коммит ${file}`);
    return git(project, 'rev-parse', 'HEAD');
  }

  /** Проверка итогового состояния успешного применения независимо от ответа адаптера. */
  function assertAppliedState(candidate: PreparedCandidate, appliedSha: string): void {
    assert.equal(git(project, 'rev-parse', 'HEAD'), appliedSha);
    const [sha, ...parents] = git(project, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ');
    assert.equal(sha, appliedSha);
    assert.deepEqual(parents, [candidate.expectedBaseSha], 'коммит применения имеет единственного родителя — выбранную базу');
    assert.equal(git(project, 'rev-parse', 'HEAD^{tree}'), candidate.candidateTree);
    assert.equal(git(project, 'status', '--porcelain=v1', '--untracked-files=all'), '');
    assert.equal(git(project, 'diff', '--cached'), '');
    assert.equal(git(project, 'diff'), '');
    assert.deepEqual(unfinishedGitState(), []);
    assert.equal(git(project, 'branch', '--show-current'), candidate.baseRef);
  }

  beforeEach(async () => {
    await mkdir(join(root, '.tmp'), { recursive: true });
    sandbox = await mkdtemp(join(root, '.tmp/git-boundaries-'));
    project = join(sandbox, 'project with spaces');
    workspace = join(sandbox, 'session worktree');
  });

  afterEach(async () => {
    if (sandbox) await rm(sandbox, { recursive: true, force: true });
  });

  describe('Этап 2: крайние случаи Git', () => {
    it('S2-B01: каталог без Git отклоняется без автоматического git init', async () => {
      await mkdir(project);
      await writeFile(join(project, 'user.txt'), 'keep\n');
      const sut = await adapter();
      await assert.rejects(sut.inspectRepository(project), { code: 'not_git_repository' });
      assert.equal(existsSync(join(project, '.git')), false);
      assert.equal(await readFile(join(project, 'user.txt'), 'utf8'), 'keep\n');
    });

    it('S2-B02: репозиторий без коммитов не допускает запуск сессии', async () => {
      await initRepository(project, false);
      const sut = await adapter();
      await assert.rejects(sut.createWorkspace(createRequest()), { code: 'no_commits' });
      assert.equal(existsSync(workspace), false);
      assert.equal(git(project, 'for-each-ref', '--format=%(refname)', 'refs/heads/vs/boundary-task'), '');
    });

    it('S2-B03: грязный старт использует HEAD и сохраняет изменения основной копии', async () => {
      await initRepository(project);
      await writeFile(join(project, 'tracked.txt'), 'staged\n');
      git(project, 'add', 'tracked.txt');
      await writeFile(join(project, 'tracked.txt'), 'unstaged\n');
      await writeFile(join(project, 'untracked.txt'), 'private\n');
      const before = snapshot(project);
      const sut = await adapter();
      const result = await sut.createWorkspace(createRequest());
      assert.equal(result.baseSha, before.head);
      assert.ok((result.warnings).includes('dirty_tree'));
      assert.equal(await readFile(join(workspace, 'tracked.txt'), 'utf8'), 'base\n');
      assert.equal(existsSync(join(workspace, 'untracked.txt')), false);
      assert.deepEqual(snapshot(project), before);
      assert.equal(await readFile(join(project, 'untracked.txt'), 'utf8'), 'private\n');
      assert.equal(git(project, 'show', ':tracked.txt'), 'staged');
    });

    for (const kind of ['staged', 'unstaged', 'untracked'] as const) {
      it(`S2-B04/${kind}: применение блокируется с перечнем грязных файлов`, async () => {
        await initRepository(project);
        const sut = await adapter();
        const candidate = await preparedSession(sut);
        const file = kind === 'untracked' ? 'untracked.txt' : 'tracked.txt';
        await writeFile(join(project, file), 'local changes\n');
        if (kind === 'staged') git(project, 'add', file);
        const before = fullSnapshot();
        await assert.rejects(sut.applyWorkspace(applyRequest(candidate)), (error: unknown) => {
          const failure = error as { code: string; files: string[] };
          assert.equal(failure.code, 'dirty_tree');
          assert.ok(failure.files.includes(file));
          return true;
        });
        assert.deepEqual(fullSnapshot(), before);
        assert.equal(await readFile(join(project, file), 'utf8'), 'local changes\n');
        assert.equal(existsSync(join(project, 'session.txt')), false);
        assert.deepEqual(operationRefs(), []);
      });
    }

    it('S2-B05: detached HEAD разрешает worktree от SHA и оставление ветки', async () => {
      await initRepository(project);
      git(project, 'checkout', '--detach');
      const before = snapshot(project);
      const sut = await adapter();
      const result = await sut.createWorkspace(createRequest(before.head));
      assert.equal(result.baseSha, before.head);
      assert.equal(result.applyMode, 'keep_branch');
      assert.equal(git(workspace, 'rev-parse', 'HEAD'), before.head);
      assert.equal(git(workspace, 'branch', '--show-current'), 'vs/boundary-task');
      assert.deepEqual(snapshot(project), before);
      assert.equal(git(project, 'branch', '--show-current'), '');
    });

    it('S2-B06: применение при detached HEAD отклоняется без потери ветки', async () => {
      await initRepository(project);
      const sut = await adapter();
      const candidate = await preparedSession(sut);
      git(project, 'checkout', '--detach');
      const before = fullSnapshot();
      const sessionHead = git(workspace, 'rev-parse', 'HEAD');
      await assert.rejects(sut.applyWorkspace(applyRequest(candidate)), { code: 'detached_head' });
      assert.deepEqual(fullSnapshot(), before);
      assert.equal(git(workspace, 'rev-parse', 'vs/boundary-task'), sessionHead);
    });

    it('S2-B07: исчезнувшая базовая ветка требует выбора другой цели', async () => {
      await initRepository(project);
      const sut = await adapter();
      const candidate = await preparedSession(sut);
      git(project, 'checkout', '-b', 'replacement');
      git(project, 'branch', '-D', 'main');
      const before = fullSnapshot();
      const sessionHead = git(workspace, 'rev-parse', 'HEAD');
      await assert.rejects(sut.applyWorkspace(applyRequest(candidate)), { code: 'base_branch_missing' });
      assert.deepEqual(fullSnapshot(), before);
      assert.equal(git(workspace, 'rev-parse', 'HEAD'), sessionHead);
    });

    it('S2-B08: push воссоздаёт удалённую remote-ветку', async () => {
      await initRepository(project);
      const sut = await adapter();
      await committedSession(sut);
      const remote = join(sandbox, 'remote.git');
      git(sandbox, 'init', '--bare', remote);
      git(workspace, 'remote', 'add', 'origin', remote);
      git(workspace, 'push', 'origin', 'vs/boundary-task');
      git(sandbox, '--git-dir', remote, 'update-ref', '-d', 'refs/heads/vs/boundary-task');
      await sut.pushWorkspace({ workspacePath: workspace, remote: 'origin', branch: 'vs/boundary-task' });
      assert.equal(git(sandbox, '--git-dir', remote, 'rev-parse', 'refs/heads/vs/boundary-task'),
        git(workspace, 'rev-parse', 'HEAD'));
    });

    it('S2-B09: расходящиеся ветки не перезаписываются force-push', async () => {
      await initRepository(project);
      const sut = await adapter();
      await committedSession(sut);
      const remote = join(sandbox, 'remote.git');
      git(sandbox, 'init', '--bare', remote);
      git(workspace, 'remote', 'add', 'origin', remote);
      git(workspace, 'push', 'origin', 'vs/boundary-task');
      const other = join(sandbox, 'other');
      git(sandbox, 'clone', '--branch', 'vs/boundary-task', remote, other);
      await writeFile(join(other, 'other.txt'), 'remote changes\n');
      git(other, 'add', 'other.txt');
      git(other, 'commit', '-m', 'Изменение удалённой ветки');
      git(other, 'push', 'origin', 'vs/boundary-task');
      const remoteHead = git(other, 'rev-parse', 'HEAD');
      await writeFile(join(workspace, 'local.txt'), 'local changes\n');
      git(workspace, 'add', 'local.txt');
      git(workspace, 'commit', '-m', 'Расходящаяся локальная ветка');
      const localHead = git(workspace, 'rev-parse', 'HEAD');
      await assert.rejects(sut.pushWorkspace({ workspacePath: workspace, remote: 'origin', branch: 'vs/boundary-task' }),
        { code: 'non_fast_forward' });
      assert.equal(git(sandbox, '--git-dir', remote, 'rev-parse', 'refs/heads/vs/boundary-task'), remoteHead);
      assert.equal(git(workspace, 'rev-parse', 'HEAD'), localHead);
    });

    it('S2-B10: настоящий подмодуль вызывает предупреждение о неподдерживаемом формате', async () => {
      await initRepository(project);
      const dependency = join(sandbox, 'dependency');
      await initRepository(dependency);
      git(project, '-c', 'protocol.file.allow=always', 'submodule', 'add', dependency, 'dependency');
      git(project, 'commit', '-am', 'Добавление подмодуля');
      const before = snapshot(project);
      const sut = await adapter();
      assert.ok(((await sut.inspectRepository(project)).warnings).includes('submodules_unsupported'));
      assert.deepEqual(snapshot(project), before);
    });

    it('S2-B11: Git LFS в атрибутах вызывает предупреждение', async () => {
      await initRepository(project);
      await writeFile(join(project, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n');
      git(project, 'add', '.gitattributes');
      git(project, 'commit', '-m', 'Настройка LFS');
      const before = snapshot(project);
      const sut = await adapter();
      assert.ok(((await sut.inspectRepository(project)).warnings).includes('lfs_unsupported'));
      assert.deepEqual(snapshot(project), before);
    });

    it('S2-B12: конфликт остаётся внутри worktree, основная копия не меняется', async () => {
      await initRepository(project);
      const sut = await adapter();
      await startSession(sut);
      await writeFile(join(workspace, 'tracked.txt'), 'session version\n');
      git(workspace, 'commit', '-am', 'Версия сессии');
      await writeFile(join(project, 'tracked.txt'), 'base version\n');
      git(project, 'commit', '-am', 'Версия базовой ветки');
      const before = fullSnapshot();
      await assert.rejects(prepare(sut), (error: unknown) => {
        const failure = error as { code: string; files: string[] };
        assert.equal(failure.code, 'merge_conflict');
        assert.deepEqual(failure.files, ['tracked.txt']);
        return true;
      });
      assert.deepEqual(fullSnapshot(), before);
      assert.equal(await readFile(join(project, 'tracked.txt'), 'utf8'), 'base version\n');
      assert.equal(git(workspace, 'diff', '--name-only', '--diff-filter=U'), 'tracked.txt');
    });
  });

  describe('0B: основание Git — база, принадлежность, подготовка кандидата', () => {
    it('S2-B13: выбранная база отличается от HEAD основной копии (G6)', async () => {
      await initRepository(project);
      git(project, 'checkout', '-q', '-b', 'release');
      await writeFile(join(project, 'tracked.txt'), 'release\n');
      git(project, 'commit', '-qam', 'Релиз');
      const releaseSha = git(project, 'rev-parse', 'HEAD');
      git(project, 'checkout', '-q', 'main');
      await writeFile(join(project, 'main-only.txt'), 'main\n');
      git(project, 'add', 'main-only.txt');
      git(project, 'commit', '-qm', 'Только main');
      const before = snapshot(project);
      assert.notEqual(before.head, releaseSha);
      const sut = await adapterWithStore();
      const result = await sut.createWorkspace(createRequest('release'));
      assert.equal(result.baseSha, releaseSha, 'база — выбранная ветка, а не HEAD');
      assert.equal(git(workspace, 'rev-parse', 'HEAD'), releaseSha);
      assert.equal(await readFile(join(workspace, 'tracked.txt'), 'utf8'), 'release\n');
      assert.equal(existsSync(join(workspace, 'main-only.txt')), false);
      assert.equal(git(project, 'rev-parse', 'refs/vibestudio/boundary/base'), releaseSha);
      assert.deepEqual(snapshot(project), before);
      assert.equal(git(project, 'branch', '--show-current'), 'main');

      // Кандидат помнит выбранную базу; применять его в основную копию на другой ветке нельзя.
      await sessionCommit('session.txt', 'session\n');
      const candidate = await prepare(sut, 'prepare-1', 'release');
      assert.equal(candidate.expectedBaseSha, releaseSha);
      assert.equal(candidate.baseRef, 'release');
      await assert.rejects(sut.applyWorkspace(applyRequest(candidate)), { code: 'base_branch_not_checked_out' });
      assert.deepEqual(snapshot(project), before);
      assert.deepEqual(operationRefs(), []);
    });

    it('S2-B14: повтор createWorkspace по requestId идемпотентен, base-checkpoint не переписывается (G1/G6)', async () => {
      await initRepository(project);
      const sut = await adapterWithStore();
      const first = await sut.createWorkspace(createRequest());
      const base = git(project, 'rev-parse', 'refs/vibestudio/boundary/base');
      const worktrees = git(project, 'worktree', 'list', '--porcelain');
      assert.deepEqual(await sut.createWorkspace(createRequest()), first);
      assert.equal(git(project, 'worktree', 'list', '--porcelain'), worktrees);
      await rejectsWith(sut.createWorkspace({ ...createRequest(), branch: 'vs/another' }), 'request_conflict');

      // Новый requestId для той же сессии не затирает точку возврата и не создаёт второй workspace.
      await writeFile(join(project, 'moved.txt'), 'moved\n');
      git(project, 'add', 'moved.txt');
      git(project, 'commit', '-m', 'База сдвинулась');
      const second = join(sandbox, 'second worktree');
      await assert.rejects(sut.createWorkspace({
        ...identity(), requestId: 'create-2', workspacePath: second, branch: 'vs/boundary-second',
      }), (error: unknown) => typeof errorCode(error) === 'string');
      assert.equal(git(project, 'rev-parse', 'refs/vibestudio/boundary/base'), base);
      assert.equal(existsSync(second), false);
      assert.equal(git(project, 'for-each-ref', '--format=%(refname)', 'refs/heads/vs/boundary-second'), '');
    });

    it('S2-B15: принадлежность workspace проверяется, sessionId не выводится из имени ветки (G7)', async () => {
      await initRepository(project);
      const sut = await adapterWithStore();

      // Worktree создан вручную: сохранённой связи нет, имя ветки «vs/boundary-task» не заменяет её.
      git(project, 'worktree', 'add', '-b', 'vs/boundary-task', workspace, 'main');
      await sessionCommit('session.txt', 'session\n');
      const before = fullSnapshot();
      const workspaceHead = git(workspace, 'rev-parse', 'HEAD');
      await rejectsWith(sut.prepareWorkspace({ ...identity(), sessionId: 'boundary-task', requestId: 'prepare-1' }),
        'invalid_workspace');
      assert.deepEqual(fullSnapshot(), before);
      assert.equal(git(workspace, 'rev-parse', 'HEAD'), workspaceHead);
      await rm(workspace, { recursive: true, force: true });
      git(project, 'worktree', 'prune');
      git(project, 'branch', '-D', 'vs/boundary-task');

      // Workspace, созданный через порт, привязан к своей сессии и ветке.
      await startSession(sut);
      await sessionCommit('session.txt', 'session\n');
      await rejectsWith(sut.prepareWorkspace({ ...identity(), sessionId: 'someone-else', requestId: 'prepare-2' }),
        'invalid_workspace');
      await rejectsWith(sut.prepareWorkspace({ ...identity(), branch: 'vs/other', requestId: 'prepare-3' }),
        'invalid_workspace');

      // Workspace другого репозитория не принимается.
      const otherProject = join(sandbox, 'other project');
      const otherWorkspace = join(sandbox, 'other worktree');
      await initRepository(otherProject);
      await sut.createWorkspace({ ...identity(), projectPath: otherProject, workspacePath: otherWorkspace,
        requestId: 'create-other' });
      await rejectsWith(sut.prepareWorkspace({ ...identity(), workspacePath: otherWorkspace, requestId: 'prepare-4' }),
        'invalid_workspace');

      // Подменённый кандидат не применяется.
      const candidate = await prepare(sut, 'prepare-5');
      const mainBefore = fullSnapshot();
      await rejectsWith(sut.applyWorkspace(applyRequest({ ...candidate, sessionId: 'someone-else' })), 'invalid_workspace');
      assert.deepEqual(fullSnapshot(), mainBefore);
    });

    it('S2-B16: подготовка кандидата не меняет основную копию и идемпотентна по requestId', async () => {
      await initRepository(project);
      const sut = await adapterWithStore();
      await committedSession(sut);
      await sessionCommit('second.txt', 'second\n', 'Второй коммит сессии');
      const before = fullSnapshot();
      const candidate = await prepare(sut);
      assert.equal(candidate.expectedBaseSha, before.head);
      assert.equal(candidate.candidateSha, git(workspace, 'rev-parse', 'HEAD'));
      assert.equal(candidate.candidateTree, git(workspace, 'rev-parse', 'HEAD^{tree}'));
      assert.equal(candidate.sessionId, 'boundary');
      assert.equal(candidate.branch, 'vs/boundary-task');
      assert.equal(candidate.baseRef, 'main');
      assert.equal(candidate.workspacePath, workspace);
      assert.ok(candidate.repositoryId.length > 0);
      assert.ok(candidate.revisionId.length > 0);
      assert.deepEqual(fullSnapshot(), before);

      assert.deepEqual(await prepare(sut), candidate);
      const prepares = (await store.list()).filter((operation) => operation.kind === 'prepare');
      assert.equal(prepares.length, 1, 'повтор requestId не создаёт новую операцию подготовки');
      assert.deepEqual(fullSnapshot(), before);

      await writeFile(join(workspace, 'wip.txt'), 'draft\n');
      await assert.rejects(prepare(sut, 'prepare-2'), (error: unknown) => {
        const failure = error as { code: string; files: string[] };
        assert.equal(failure.code, 'dirty_tree');
        assert.ok(failure.files.includes('wip.txt'));
        return true;
      });
      assert.deepEqual(fullSnapshot(), before);
    });

    it('S2-B17: конфликт разрешается в workspace, затем кандидат готовится заново и применяется', async () => {
      await initRepository(project);
      const sut = await adapterWithStore();
      await startSession(sut);
      await writeFile(join(workspace, 'tracked.txt'), 'session version\n');
      git(workspace, 'commit', '-am', 'Версия сессии');
      await writeFile(join(project, 'tracked.txt'), 'base version\n');
      git(project, 'commit', '-am', 'Версия базовой ветки');
      const baseHead = git(project, 'rev-parse', 'HEAD');
      const before = fullSnapshot();

      await rejectsWith(prepare(sut), 'merge_conflict');
      assert.deepEqual(fullSnapshot(), before);
      assert.equal(git(workspace, 'diff', '--name-only', '--diff-filter=U'), 'tracked.txt');
      assert.ok(existsSync(join(workspace, git(workspace, 'rev-parse', '--git-path', 'MERGE_HEAD'))), 'слияние ждёт разрешения в workspace');

      await writeFile(join(workspace, 'tracked.txt'), 'resolved\n');
      git(workspace, 'add', 'tracked.txt');
      git(workspace, 'commit', '--no-edit');
      const candidate = await prepare(sut, 'prepare-2');
      assert.equal(candidate.expectedBaseSha, baseHead);
      assert.equal(candidate.candidateSha, git(workspace, 'rev-parse', 'HEAD'));
      assert.equal(git(workspace, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3, 'кандидат — завершённое слияние базы');
      assert.deepEqual(fullSnapshot(), before);

      const result = applied(await sut.applyWorkspace(applyRequest(candidate)));
      assertAppliedState(candidate, result.appliedSha);
      assert.equal(await readFile(join(project, 'tracked.txt'), 'utf8'), 'resolved\n');
    });
  });

  describe('0B: применение проверенного кандидата', () => {
    it('S2-B18: положительный squash — содержимое, единственный родитель, чистые индекс и файлы', async () => {
      await initRepository(project);
      const sut = await adapterWithStore();
      await startSession(sut);
      await sessionCommit('session.txt', 'session\n', 'Первый коммит сессии');
      await sessionCommit('nested/deep.txt', 'deep\n', 'Второй коммит сессии');
      await writeFile(join(workspace, 'tracked.txt'), 'session edit\n');
      git(workspace, 'commit', '-am', 'Правка tracked');
      const base = git(project, 'rev-parse', 'HEAD');
      const legacyRef = 'refs/vibestudio/boundary/pre-apply';
      git(project, 'update-ref', legacyRef, base);
      const candidate = await prepare(sut);
      const sessionHead = git(workspace, 'rev-parse', 'vs/boundary-task');

      const result = applied(await sut.applyWorkspace(applyRequest(candidate)));
      assertAppliedState(candidate, result.appliedSha);
      assert.equal(commitCount(), 2, 'три коммита сессии свёрнуты в один');
      assert.equal(await readFile(join(project, 'session.txt'), 'utf8'), 'session\n');
      assert.equal(await readFile(join(project, 'nested/deep.txt'), 'utf8'), 'deep\n');
      assert.equal(await readFile(join(project, 'tracked.txt'), 'utf8'), 'session edit\n');
      assert.equal(git(workspace, 'rev-parse', 'vs/boundary-task'), sessionHead, 'ветка сессии сохранена');

      assert.match(result.preApplyRef, /^refs\/vibestudio\/boundary\/operations\/[^/]+\/pre-apply$/);
      assert.ok(result.preApplyRef.includes(`/${result.operationId}/`));
      assert.equal(git(project, 'rev-parse', result.preApplyRef), base);
      assert.equal(git(project, 'rev-parse', legacyRef), base, 'ref старого формата сохраняется');
      assert.equal(git(project, 'rev-parse', 'refs/vibestudio/boundary/base'), base);
      const operations = (await store.list()).filter((operation) => operation.kind === 'apply');
      assert.equal(operations.length, 1);
      assert.equal(operations[0]?.operationId, result.operationId);
    });

    it('S2-B19: no_changes — без коммита, checkpoint и закрытия сессии', async () => {
      await initRepository(project);
      const sut = await adapterWithStore();
      await startSession(sut);
      await sessionCommit('temp.txt', 'temporary\n', 'Добавление');
      git(workspace, 'rm', '-q', 'temp.txt');
      git(workspace, 'commit', '-m', 'Откат добавления');
      const candidate = await prepare(sut);
      assert.equal(candidate.candidateTree, git(project, 'rev-parse', 'HEAD^{tree}'));
      const before = fullSnapshot();

      const result = await sut.applyWorkspace(applyRequest(candidate));
      assert.equal(result.status, 'no_changes');
      assert.ok(result.operationId.length > 0);
      assert.deepEqual(fullSnapshot(), before);
      assert.deepEqual(operationRefs(), []);
      assert.equal(commitCount(), 1);

      // Пустая операция не помечает сессию применённой: следующее изменение применяется обычно.
      await sessionCommit('later.txt', 'later\n');
      const next = await prepare(sut, 'prepare-2');
      const result2 = applied(await sut.applyWorkspace(applyRequest(next, 'apply-2')));
      assertAppliedState(next, result2.appliedSha);
    });

    it('S2-B20: повтор requestId возвращает ту же операцию без повторного применения', async () => {
      await initRepository(project);
      const sut = await adapterWithStore();
      const candidate = await preparedSession(sut);
      const first = applied(await sut.applyWorkspace(applyRequest(candidate)));
      const refs = vibestudioRefs();
      assert.deepEqual(await sut.applyWorkspace(applyRequest(candidate)), first);
      assert.equal(commitCount(), 2);
      assert.equal(vibestudioRefs(), refs);
      assert.equal((await store.list()).filter((operation) => operation.kind === 'apply').length, 1);

      // Последующий внешний коммит не превращает повтор в новое применение или отказ.
      const external = await externalCommit('external.txt', 'external\n');
      assert.deepEqual(await sut.applyWorkspace(applyRequest(candidate)), first);
      assert.equal(git(project, 'rev-parse', 'HEAD'), external);
      assert.equal(vibestudioRefs(), refs);

      // Тот же requestId с другим запросом — конфликт, а не подмена.
      await rejectsWith(sut.applyWorkspace(applyRequest(candidate, 'apply-1', { checksFingerprint: 'checks-2' })),
        'request_conflict');
      assert.equal(git(project, 'rev-parse', 'HEAD'), external);
    });

    it('S2-B21: после applied сессия закрыта для нового применения', async () => {
      await initRepository(project);
      const sut = await adapterWithStore();
      const candidate = await preparedSession(sut);
      applied(await sut.applyWorkspace(applyRequest(candidate)));
      const before = fullSnapshot();
      await rejectsWith(sut.applyWorkspace(applyRequest(candidate, 'apply-2')), 'session_applied');
      assert.deepEqual(fullSnapshot(), before);
      assert.equal(commitCount(), 2);
    });

    it('S2-B22: параллельные применения внутри приложения сериализуются (G3)', async () => {
      await initRepository(project);
      const sut = await adapterWithStore();
      const candidate = await preparedSession(sut);
      const settled = await Promise.allSettled([
        sut.applyWorkspace(applyRequest(candidate, 'apply-a')),
        sut.applyWorkspace(applyRequest(candidate, 'apply-b')),
      ]);
      const successes = settled.filter((item) => item.status === 'fulfilled' && item.value.status === 'applied');
      assert.equal(successes.length, 1, 'только один запрос создаёт применение');
      assert.equal(commitCount(), 2);
      assert.equal(operationRefs().length, 1);
      assertAppliedState(candidate, git(project, 'rev-parse', 'HEAD'));

    });

    it('S2-B23: изменение базы после подготовки отклоняется без скрытого слияния (G3)', async () => {
      await initRepository(project);
      const sut = await adapterWithStore();
      const candidate = await preparedSession(sut);
      const external = await externalCommit('external.txt', 'external\n');
      const before = fullSnapshot();
      const workspaceHead = git(workspace, 'rev-parse', 'HEAD');
      await rejectsWith(sut.applyWorkspace(applyRequest(candidate)), 'base_changed');
      assert.deepEqual(fullSnapshot(), before);
      assert.equal(git(workspace, 'rev-parse', 'HEAD'), workspaceHead, 'apply не вливает базу в workspace');
      assert.equal(existsSync(join(project, 'session.txt')), false);

      const fresh = await prepare(sut, 'prepare-2');
      assert.equal(fresh.expectedBaseSha, external);
      assert.notEqual(fresh.revisionId, candidate.revisionId);
      // Старый кандидат устарел и после повторной подготовки.
      await rejectsWith(sut.applyWorkspace(applyRequest(candidate, 'apply-2')), ['base_changed', 'candidate_changed']);
      assert.equal(git(project, 'rev-parse', 'HEAD'), external);

      const result = applied(await sut.applyWorkspace(applyRequest(fresh, 'apply-3')));
      assertAppliedState(fresh, result.appliedSha);
      assert.equal(await readFile(join(project, 'external.txt'), 'utf8'), 'external\n');
      assert.equal(await readFile(join(project, 'session.txt'), 'utf8'), 'session\n');
    });

    it('S2-B24: изменённый после подготовки workspace делает кандидата устаревшим', async () => {
      await initRepository(project);
      const sut = await adapterWithStore();
      const candidate = await preparedSession(sut);
      await sessionCommit('late.txt', 'late\n', 'Правка после подготовки');
      const before = fullSnapshot();
      const workspaceHead = git(workspace, 'rev-parse', 'HEAD');
      await rejectsWith(sut.applyWorkspace(applyRequest(candidate)), 'candidate_changed');
      assert.deepEqual(fullSnapshot(), before);
      assert.equal(git(workspace, 'rev-parse', 'HEAD'), workspaceHead);
      assert.equal(existsSync(join(project, 'session.txt')), false);
    });

    it('S2-B25: устаревшие проверки блокируют применение, явный bypass требует причины', async () => {
      await initRepository(project);
      const sut = await adapterWithStore();
      const candidate = await preparedSession(sut);
      const before = fullSnapshot();
      await rejectsWith(sut.applyWorkspace(applyRequest(candidate, 'apply-1', {
        verification: { status: 'passed', revisionId: 'other-revision', checksFingerprint: 'checks-1' },
      })), 'checks_stale');
      await rejectsWith(sut.applyWorkspace(applyRequest(candidate, 'apply-2', { checksFingerprint: 'checks-changed' })),
        'checks_stale');
      assert.deepEqual(fullSnapshot(), before);

      const result = applied(await sut.applyWorkspace(applyRequest(candidate, 'apply-3', {
        verification: { status: 'bypassed', reason: 'Проверки отключены пользователем',
          revisionId: candidate.revisionId, checksFingerprint: 'checks-1' },
      })));
      assertAppliedState(candidate, result.appliedSha);
    });

    it('S2-B26: предусловия основной копии проверяются до изменений и checkpoint', async () => {
      await initRepository(project);
      const sut = await adapterWithStore();
      const candidate = await preparedSession(sut);

      const before = fullSnapshot();
      await writeFile(join(project, '.git', 'MERGE_HEAD'), `${candidate.candidateSha}\n`);
      const withMerge = fullSnapshot();
      await rejectsWith(sut.applyWorkspace(applyRequest(candidate, 'apply-merge')), 'git_operation_in_progress');
      assert.deepEqual(fullSnapshot(), withMerge);
      await rm(join(project, '.git', 'MERGE_HEAD'));

      git(project, 'config', '--local', 'user.name', '');
      git(project, 'config', '--local', 'user.email', '');
      await rejectsWith(sut.applyWorkspace(applyRequest(candidate, 'apply-author')), 'author_missing');
      assert.deepEqual(fullSnapshot(), before);
      git(project, 'config', '--local', 'user.name', 'Spec Test');
      git(project, 'config', '--local', 'user.email', 'spec@example.invalid');

      git(project, 'checkout', '-q', '-b', 'other');
      const onOther = fullSnapshot();
      await rejectsWith(sut.applyWorkspace(applyRequest(candidate, 'apply-branch')), 'base_branch_not_checked_out');
      assert.deepEqual(fullSnapshot(), onOther);
      assert.deepEqual(operationRefs(), []);
    });
  });

  describe('0B: сбои применения и сверка (тестовый Store, не crash recovery приложения)', () => {
    /** Состояние основной копии после неуспешной попытки: ничего не потеряно и не применено наполовину. */
    function assertNotApplied(candidate: PreparedCandidate, attempt: Outcome): void {
      if (attempt.result) assert.notEqual(attempt.result.status, 'applied');
      else assert.equal(typeof errorCode(attempt.error), 'string', 'сбой должен быть доменной ошибкой, а не сырой ошибкой git');
      assert.equal(git(project, 'rev-parse', 'HEAD'), candidate.expectedBaseSha);
      assert.equal(git(project, 'diff'), '', 'файлы совпадают с индексом');
      assert.equal(git(project, 'diff', '--cached'), '', 'индекс не изменён');
      assert.equal(git(project, 'status', '--porcelain=v1', '--untracked-files=all'), '');
      assert.deepEqual(unfinishedGitState(), []);
    }

    async function applyOperation(): Promise<GitOperation> {
      const operations = (await store.list()).filter((operation) => operation.kind === 'apply');
      assert.equal(operations.length, 1, 'ровно одна операция применения');
      return operations[0]!;
    }

    it('S2-B27: ошибка коммита после checkpoint не оставляет частичного применения (G2)', async () => {
      await initRepository(project);
      const sut = await adapterWithStore({
        faultInjector: (point) => {
          if (point !== 'before_commit') return;
          git(project, 'config', '--local', 'user.name', '');
          git(project, 'config', '--local', 'user.email', '');
        },
      });
      const candidate = await preparedSession(sut);
      const attempt = await outcome(sut.applyWorkspace(applyRequest(candidate)));
      assertNotApplied(candidate, attempt);
      const operation = await applyOperation();
      assert.equal(git(project, 'rev-parse', `refs/vibestudio/boundary/operations/${operation.operationId}/pre-apply`),
        candidate.expectedBaseSha);
      const before = fullSnapshot();
      const reconciled = await sut.reconcileApply({ projectPath: project, operationId: operation.operationId });
      assert.equal(reconciled.status, 'interrupted');
      assert.deepEqual(fullSnapshot(), before, 'сверка ничего не сбрасывает и не чистит');
    });

    it('S2-B28: сбой обновления файлов (index.lock) даёт interrupted и не меняет основную копию (G2)', async () => {
      await initRepository(project);
      const sut = await adapterWithStore({
        faultInjector: async (point) => {
          if (point === 'before_files') await writeFile(join(project, '.git', 'index.lock'), '');
        },
      });
      const candidate = await preparedSession(sut);
      const attempt = await outcome(sut.applyWorkspace(applyRequest(candidate)));
      assertNotApplied(candidate, attempt);
      assert.equal(existsSync(join(project, 'session.txt')), false);
      const operation = await applyOperation();
      const before = fullSnapshot();
      const reconciled = await sut.reconcileApply({ projectPath: project, operationId: operation.operationId });
      assert.equal(reconciled.status, 'interrupted');
      assert.deepEqual(fullSnapshot(), before);
      assert.ok(existsSync(join(project, '.git', 'index.lock')), 'чужая блокировка не удаляется автоматически');
    });

    it('S2-B29: внешний коммит между проверкой и записью не перезаписывается (G3)', async () => {
      await initRepository(project);
      let external = '';
      const sut = await adapterWithStore({
        faultInjector: async (point) => {
          if (point === 'after_checkpoint') external = await externalCommit('external.txt', 'external\n');
        },
      });
      const candidate = await preparedSession(sut);
      const attempt = await outcome(sut.applyWorkspace(applyRequest(candidate)));
      assert.ok(external, 'точка after_checkpoint достигнута');
      if (attempt.result) assert.equal(attempt.result.status, 'interrupted');
      else assert.equal(errorCode(attempt.error), 'base_changed');
      assert.equal(git(project, 'rev-parse', 'HEAD'), external, 'внешний коммит остаётся вершиной ветки');
      assert.equal(await readFile(join(project, 'external.txt'), 'utf8'), 'external\n');
      assert.equal(existsSync(join(project, 'session.txt')), false);
      assert.equal(git(project, 'status', '--porcelain=v1', '--untracked-files=all'), '');
      assert.deepEqual(unfinishedGitState(), []);
      for (const line of operationRefs()) {
        assert.equal(line.split(' ')[1], candidate.expectedBaseSha, 'checkpoint хранит исходную базу');
      }
    });

    it('S2-B30: непересекающиеся правки пользователя во время применения сохраняются', async () => {
      await initRepository(project);
      await writeFile(join(project, 'other.txt'), 'other base\n');
      git(project, 'add', 'other.txt');
      git(project, 'commit', '-m', 'Второй файл базы');
      const sut = await adapterWithStore({
        faultInjector: async (point) => {
          if (point !== 'before_files') return;
          await writeFile(join(project, 'other.txt'), 'unstaged edit\n');
          await writeFile(join(project, 'late.txt'), 'untracked\n');
          await writeFile(join(project, 'staged.txt'), 'staged\n');
          git(project, 'add', 'staged.txt');
        },
      });
      const candidate = await preparedSession(sut);
      const attempt = await outcome(sut.applyWorkspace(applyRequest(candidate)));
      assert.equal(await readFile(join(project, 'other.txt'), 'utf8'), 'unstaged edit\n');
      assert.equal(await readFile(join(project, 'late.txt'), 'utf8'), 'untracked\n');
      assert.equal(await readFile(join(project, 'staged.txt'), 'utf8'), 'staged\n');
      assert.ok(git(project, 'diff', '--cached', '--name-only').split('\n').includes('staged.txt'), 'staged-файл остался в индексе');
      assert.equal(git(project, 'stash', 'list'), '');
      if (attempt.result?.status === 'applied') {
        assert.equal(git(project, 'rev-parse', 'HEAD^{tree}'), candidate.candidateTree);
        assert.equal(git(project, 'rev-parse', 'HEAD^'), candidate.expectedBaseSha);
      } else {
        assert.equal(git(project, 'rev-parse', 'HEAD'), candidate.expectedBaseSha);
      }
    });

    it('S2-B31: пересекающаяся правка пользователя во время применения не перезаписывается', async () => {
      await initRepository(project);
      const sut = await adapterWithStore({
        faultInjector: async (point) => {
          if (point === 'before_files') await writeFile(join(project, 'tracked.txt'), 'user edit\n');
        },
      });
      await startSession(sut);
      await writeFile(join(workspace, 'tracked.txt'), 'session edit\n');
      git(workspace, 'commit', '-am', 'Правка сессии');
      const candidate = await prepare(sut);
      const attempt = await outcome(sut.applyWorkspace(applyRequest(candidate)));
      if (attempt.result) assert.notEqual(attempt.result.status, 'applied');
      else assert.equal(typeof errorCode(attempt.error), 'string');
      assert.equal(await readFile(join(project, 'tracked.txt'), 'utf8'), 'user edit\n');
      assert.equal(git(project, 'rev-parse', 'HEAD'), candidate.expectedBaseSha);
      assert.equal(git(project, 'diff', '--cached'), '');
      assert.equal(git(project, 'stash', 'list'), '');
    });

    it('S2-B32: checkpoint операции не перезаписывается, новая попытка блокируется (G1)', async () => {
      await initRepository(project);
      let armed = true;
      const sut = await adapterWithStore({
        faultInjector: (point) => {
          if (armed && point === 'after_checkpoint') throw new SimulatedCrash(point);
        },
      });
      const candidate = await preparedSession(sut);
      const legacyRef = 'refs/vibestudio/boundary/pre-apply';
      git(project, 'update-ref', legacyRef, candidate.expectedBaseSha);
      await outcome(sut.applyWorkspace(applyRequest(candidate)));
      armed = false;
      const operation = await applyOperation();
      const checkpoint = `refs/vibestudio/boundary/operations/${operation.operationId}/pre-apply`;
      assert.equal(git(project, 'rev-parse', checkpoint), candidate.expectedBaseSha);
      const refs = vibestudioRefs();

      // Незавершённая операция блокирует новую попытку; существующие refs не меняются.
      await rejectsWith(sut.applyWorkspace(applyRequest(candidate, 'apply-2')), 'operation_in_progress');
      assert.equal(vibestudioRefs(), refs);
      assert.equal(git(project, 'rev-parse', legacyRef), candidate.expectedBaseSha, 'ref старого формата сохранён');
    });

    for (const [index, point] of FAULT_POINTS.entries()) {
      it(`S2-B33/${point}: падение в точке инъекции и сверка по фактическому состоянию Git`, async () => {
        await initRepository(project);
        let armed = false;
        const seen: GitFaultPoint[] = [];
        const sut = await adapterWithStore({
          faultInjector: (current) => {
            if (!armed) return;
            seen.push(current);
            if (current === point) throw new SimulatedCrash(point);
          },
        });
        const candidate = await preparedSession(sut);
        const legacyRef = 'refs/vibestudio/boundary/pre-apply';
        git(project, 'update-ref', legacyRef, candidate.expectedBaseSha);

        armed = true;
        const attempt = await outcome(sut.applyWorkspace(applyRequest(candidate)));
        armed = false;
        assert.deepEqual(seen, FAULT_POINTS.slice(0, index + 1), 'точки инъекции вызываются по одному разу в порядке фаз');
        if (attempt.result) assert.equal(attempt.result.status, 'interrupted');
        else assert.ok(attempt.error instanceof SimulatedCrash, 'адаптер не перехватывает падение процесса');

        // Независимый оракул: HEAD либо остался на базе, либо приведён к итоговому состоянию целиком.
        const head = git(project, 'rev-parse', 'HEAD');
        const operation = await applyOperation();
        const checkpoint = `refs/vibestudio/boundary/operations/${operation.operationId}/pre-apply`;
        const checkpoints = operationRefs();
        if (index < FAULT_POINTS.indexOf('after_checkpoint')) assert.deepEqual(checkpoints, []);
        else assert.equal(git(project, 'rev-parse', checkpoint), candidate.expectedBaseSha);
        assert.equal(git(project, 'rev-parse', legacyRef), candidate.expectedBaseSha, 'ref старого формата сохранён');
        let isApplied = false;
        if (head !== candidate.expectedBaseSha) {
          assertAppliedState(candidate, head);
          isApplied = true;
        } else {
          const indexTree = git(project, 'write-tree');
          assert.ok([git(project, 'rev-parse', 'HEAD^{tree}'), candidate.candidateTree].includes(indexTree),
            'индекс содержит либо базу, либо целого кандидата');
          assert.equal(git(project, 'diff'), '', 'файлы совпадают с индексом');
          assert.deepEqual(unfinishedGitState(), []);
        }

        const before = fullSnapshot();
        const reconciled = await sut.reconcileApply({ projectPath: project, operationId: operation.operationId });
        assert.deepEqual(fullSnapshot(), before, 'сверка не меняет HEAD, индекс, файлы и refs');
        if (isApplied) {
          assert.equal(reconciled.status, 'applied');
          assert.equal(reconciled.status === 'applied' ? reconciled.appliedSha : '', head);
        } else {
          assert.equal(reconciled.status, 'interrupted');
        }
        assert.deepEqual(await sut.reconcileApply({ projectPath: project, operationId: operation.operationId }), reconciled);

        // Повтор того же requestId не создаёт вторую операцию, второй коммит или второй checkpoint.
        const retry = await outcome(sut.applyWorkspace(applyRequest(candidate)));
        if (retry.result?.status === 'applied') assert.equal(retry.result.operationId, operation.operationId);
        assert.ok(commitCount() <= 2, 'не более одного нового коммита');
        assert.equal((await store.list()).filter((item) => item.kind === 'apply').length, 1);
        assert.ok(operationRefs().length <= 1);
        assert.equal(git(project, 'rev-parse', legacyRef), candidate.expectedBaseSha);
      });
    }
  });
}
