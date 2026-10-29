import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createProductionComposition } from '../../src/main/composition.ts';
import { createIpcHandlers } from '../../src/main/ipc.ts';
import type { ApiResult } from '../../src/shared/solo.ts';

function value<T>(result: ApiResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

it('production composition исполняет только согласованный собственный setup и восстанавливает его без повтора', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'solo-production-')));
  const project = join(root, 'project'), data = join(root, 'data');
  await mkdir(project);
  const git = (args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
    { cwd: project, timeout: 10_000, stdio: 'pipe' });
  git(['init', '-b', 'main']);
  await writeFile(join(project, 'package.json'), JSON.stringify({ private: true, scripts: { setup: 'node ./setup.cjs' } }));
  await writeFile(join(project, 'setup.cjs'), 'require("node:fs").appendFileSync("setup-effects.txt", "setup\\n");\n');
  git(['add', '.']);
  git(['-c', 'user.name=P5 Fixture', '-c', 'user.email=p5@example.invalid', 'commit', '-m', 'fixture']);
  // Никакие пользовательские команды и агенты здесь не запускаются: файлы стенда созданы выше.
  let app = await createProductionComposition(data);
  try {
    const source = {};
    const ipc = createIpcHandlers({ engine: app.engine, authorize: origin => origin === source, selectProject: async () => project });
    const selected = value(await ipc.selectProject(source, { requestId: randomUUID() }))!;
    expect(selected.setup).toBe('npm run setup');
    const created = value(await ipc.createSession(source, { requestId: randomUUID(), projectId: selected.id, cli: 'codex' }));
    await app.engine.waitForIdle();
    const sessionId = created.sessionId!;
    const session = value(await ipc.getSession(source, { sessionId }));
    expect(session.status).toBe('needs_consent');
    const decision = session.setup.decision;
    expect(decision?.status).toBe('needs_consent');
    if (decision?.status !== 'needs_consent') throw new Error(JSON.stringify(decision));
    const request = { requestId: randomUUID(), sessionId, challengeId: decision.challengeId };
    value(await ipc.confirmSetup(source, request));
    await app.engine.waitForIdle();
    const prepared = value(await ipc.getSession(source, { sessionId }));
    expect(prepared).toMatchObject({ status: 'ready', setup: { state: 'completed', completion: { process: { state: 'exited', exitCode: 0 } } } });
    const marker = join(data, 'workspaces', sessionId, 'setup-effects.txt');
    expect(await readFile(marker, 'utf8')).toBe('setup\n');
    value(await ipc.confirmSetup(source, request));
    await app.engine.waitForIdle();
    expect(await readFile(marker, 'utf8')).toBe('setup\n');
    const cursor = app.engine.readEvents({ sessionId, after: 0, limit: 200 }).nextCursor;
    await app.engine.shutdown(); app.close();
    app = await createProductionComposition(data);
    const restored = app.engine.getSession({ sessionId });
    expect(restored).toMatchObject({ status: 'ready', setup: { state: 'completed', decision: { status: 'allowed' } }, actions: { send: true } });
    expect(app.engine.readEvents({ sessionId, after: 0, limit: 200 }).nextCursor).toBeGreaterThanOrEqual(cursor);
    expect(await readFile(marker, 'utf8')).toBe('setup\n');
  } finally {
    await app.engine.shutdown(); app.close();
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
