import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createProjectCommandSnapshotPort } from '../../src/adapters/project-command-snapshot/index.ts';
import { createProjectCommandConsent } from '../../src/core/project-command-consent.ts';
import type { ProjectCommandRequest } from '../../src/core/ports/project-command-snapshot.ts';
import { ConsentStand } from '../helpers/consent.ts';

const stands: ConsentStand[] = [];
afterEach(() => { for (const stand of stands.splice(0)) stand.cleanup(); });

function nodeWrapper(): { stand: ConsentStand; request: ProjectCommandRequest } {
  const stand = new ConsentStand();
  stands.push(stand);
  stand.executable('tools/bash');
  stand.executable('tools/node', `#!${stand.path('tools/bash')}\n./scripts/child.sh\n`);
  stand.executable('scripts/child.sh', `#!${stand.path('tools/bash')}\necho before\n`);
  stand.file('scripts/main.js', 'console.log("main");\n');
  return { stand, request: {
    projectId: 'own-project', projectRoot: stand.projectRoot, operationId: 'wrapper-check', purpose: 'test',
    command: { kind: 'direct', executable: 'node', args: ['scripts/main.js'], inputFiles: [] },
    cwd: stand.projectRoot,
    permissions: { fileSystem: 'workspace-write', network: 'denied', elevated: false },
    env: { PATH: stand.path('tools') },
  } };
}

function graphFixture(): { stand: ConsentStand; request: ProjectCommandRequest } {
  const fixture = nodeWrapper();
  for (const name of ['node', 'npm', 'sh', 'runtime/bash']) fixture.stand.executable(`tools/${name}`);
  fixture.stand.executable('scripts/child.sh', `#!${fixture.stand.path('tools/runtime/bash')}\necho before\n`);
  fixture.stand.file('scripts/main.sh', 'echo main\n');
  fixture.stand.scripts({ test: 'node scripts/main.js' });
  return fixture;
}

describe('P4: исполняемые обёртки входят в известный граф', () => {
  it('учитывает известный дочерний script проектного executable с именем node', async () => {
    const { request } = nodeWrapper();
    const snapshot = await createProjectCommandSnapshotPort().capture(request);
    expect(snapshot.status, JSON.stringify(snapshot)).toBe('known');
    expect(snapshot.coverage.inputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'tools/node' }),
      expect.objectContaining({ path: 'tools/bash' }),
      expect.objectContaining({ path: 'scripts/child.sh' }),
      expect.objectContaining({ path: 'scripts/main.js' }),
    ]));
  });

  it('изменение дочернего script node-обёртки отзывает прежнее согласие', async () => {
    const { stand, request } = nodeWrapper();
    const policy = createProjectCommandConsent(createProjectCommandSnapshotPort());
    const challenge = await policy.evaluate(request);
    expect(challenge.status, JSON.stringify(challenge)).toBe('needs_consent');
    if (challenge.status !== 'needs_consent') throw new Error('Ожидался запрос согласия');
    const consent = await policy.confirm(challenge.challengeId);
    expect(consent.status, JSON.stringify(consent)).toBe('allowed');
    expect(await policy.recheck(request)).toEqual(consent);
    stand.file('scripts/child.sh', `#!${stand.path('tools/bash')}\necho changed\n`);
    expect(await policy.recheck(request)).toMatchObject({ status: 'needs_consent', reason: 'invalidated' });
  });

  it.each(['npm', 'sh', 'bash'])('обходит проектную обёртку %s и инвалидирует согласие при изменении её входа', async name => {
    const { stand, request: base } = graphFixture();
    stand.executable(`tools/${name}`, `#!${stand.path('tools/runtime/bash')}\n./scripts/child.sh\n`);
    const request: ProjectCommandRequest = { ...base, command: {
      kind: 'direct', executable: name, args: name === 'npm' ? ['run', 'test'] : ['scripts/main.sh'], inputFiles: [],
    } };
    const policy = createProjectCommandConsent(createProjectCommandSnapshotPort());
    const challenge = await policy.evaluate(request);
    expect(challenge.status, JSON.stringify(challenge)).toBe('needs_consent');
    expect(challenge.coverage.inputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: `tools/${name}` }),
      expect.objectContaining({ path: 'scripts/child.sh' }),
    ]));
    if (challenge.status !== 'needs_consent') throw new Error('Ожидался запрос согласия');
    expect((await policy.confirm(challenge.challengeId)).status).toBe('allowed');
    stand.file('scripts/child.sh', `#!${stand.path('tools/runtime/bash')}\necho changed\n`);
    expect(await policy.recheck(request)).toMatchObject({ status: 'needs_consent', reason: 'invalidated' });
  });

  it('выбранный npm script также учитывает проектную обёртку npm', async () => {
    const { stand, request: base } = graphFixture();
    stand.executable('tools/npm', `#!${stand.path('tools/runtime/bash')}\n./scripts/child.sh\n`);
    const request: ProjectCommandRequest = { ...base, command: { kind: 'npm-script', script: 'test', args: [] } };
    const port = createProjectCommandSnapshotPort();
    const first = await port.capture(request);
    expect(first.status, JSON.stringify(first)).toBe('known');
    expect(first.coverage.inputs).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'scripts/child.sh' })]));
    stand.file('scripts/child.sh', `#!${stand.path('tools/runtime/bash')}\necho changed\n`);
    const second = await port.capture(request);
    expect(second.status, JSON.stringify(second)).toBe('known');
    if (first.status !== 'known' || second.status !== 'known') throw new Error('Ожидались известные снимки');
    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  it('следует через проектный shebang-интерпретатор до его известного дочернего script', async () => {
    const { stand, request: base } = graphFixture();
    stand.executable('scripts/entry.sh', `#!${stand.path('tools/bash')}\necho entry\n`);
    stand.executable('tools/bash', `#!${stand.path('tools/runtime/bash')}\n./scripts/child.sh\n`);
    const request: ProjectCommandRequest = { ...base, command: {
      kind: 'direct', executable: './scripts/entry.sh', args: [], inputFiles: [],
    } };
    const port = createProjectCommandSnapshotPort();
    const first = await port.capture(request);
    expect(first.status, JSON.stringify(first)).toBe('known');
    expect(first.coverage.inputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'tools/runtime/bash' }),
      expect.objectContaining({ path: 'scripts/child.sh' }),
    ]));
    stand.file('scripts/child.sh', `#!${stand.path('tools/runtime/bash')}\necho changed\n`);
    const second = await port.capture(request);
    expect(second.status, JSON.stringify(second)).toBe('known');
    if (first.status !== 'known' || second.status !== 'known') throw new Error('Ожидались известные снимки');
    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  it('цикл вызова из node-обёртки блокирует снимок', async () => {
    const { stand, request } = graphFixture();
    stand.executable('tools/node', `#!${stand.path('tools/runtime/bash')}\n./scripts/child.sh\n`);
    stand.file('scripts/child.sh', `#!${stand.path('tools/runtime/bash')}\nnode scripts/main.js\n`);
    expect(await createProjectCommandSnapshotPort().capture(request)).toMatchObject({
      status: 'blocked', reason: 'dependency_cycle',
    });
  });

  it('цикл shebang-интерпретаторов блокирует снимок', async () => {
    const { stand, request: base } = graphFixture();
    stand.executable('tools/first', `#!${stand.path('tools/second')}\n`);
    stand.executable('tools/second', `#!${stand.path('tools/first')}\n`);
    const request: ProjectCommandRequest = { ...base, command: {
      kind: 'direct', executable: './tools/first', args: [], inputFiles: [],
    } };
    expect(await createProjectCommandSnapshotPort().capture(request)).toMatchObject({
      status: 'blocked', reason: 'dependency_cycle',
    });
  });

  it('длинная цепочка shebang-интерпретаторов ограничена глубиной', async () => {
    const { stand, request: base } = graphFixture();
    for (let index = 0; index < 5; index++) {
      stand.executable(`tools/layer-${index}`, `#!${stand.path(`tools/layer-${index + 1}`)}\n`);
    }
    stand.executable('tools/layer-5');
    const request: ProjectCommandRequest = { ...base, command: {
      kind: 'direct', executable: './tools/layer-0', args: [], inputFiles: [],
    } };
    expect(await createProjectCommandSnapshotPort({ limits: { maxDepth: 3 } }).capture(request)).toMatchObject({
      status: 'blocked', reason: 'limit_exceeded',
    });
  });

  it('относительный путь node не скрывает явно названный argv-entrypoint', async () => {
    const { stand, request: base } = graphFixture();
    const request: ProjectCommandRequest = { ...base, command: {
      kind: 'direct', executable: './tools/node', args: ['scripts/main.js'], inputFiles: [],
    } };
    const port = createProjectCommandSnapshotPort();
    const first = await port.capture(request);
    expect(first.status, JSON.stringify(first)).toBe('known');
    expect(first.coverage.inputs).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'scripts/main.js' })]));
    stand.file('scripts/main.js', 'console.log("changed");\n');
    const second = await port.capture(request);
    expect(second.status, JSON.stringify(second)).toBe('known');
    if (first.status !== 'known' || second.status !== 'known') throw new Error('Ожидались известные снимки');
    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  it.each(['absolute', 'env'])('не принимает неподдержанную оболочку в shebang (%s)', async form => {
    const { stand, request: base } = graphFixture();
    stand.executable('tools/zsh');
    stand.executable('tools/env');
    const interpreter = form === 'absolute' ? stand.path('tools/zsh') : `${stand.path('tools/env')} zsh`;
    stand.executable('scripts/entry.sh', `#!${interpreter}\n./scripts/child.sh\n`);
    const request: ProjectCommandRequest = { ...base, command: {
      kind: 'direct', executable: './scripts/entry.sh', args: [], inputFiles: [],
    } };
    expect(await createProjectCommandSnapshotPort().capture(request)).toMatchObject({
      status: 'blocked', reason: 'unknown_dependency',
    });
  });

  it('явный script с python shebang сохраняет границу runtime-зависимостей и учитывает собственные байты', async () => {
    const { stand, request: base } = graphFixture();
    stand.executable('tools/python3');
    stand.executable('scripts/entry.py', `#!${stand.path('tools/python3')}\nprint("before")\n`);
    const request: ProjectCommandRequest = { ...base, command: {
      kind: 'direct', executable: './scripts/entry.py', args: [], inputFiles: [],
    } };
    const port = createProjectCommandSnapshotPort();
    const first = await port.capture(request);
    expect(first.status, JSON.stringify(first)).toBe('known');
    expect(first.coverage.limitations).toContain('runtime_dependencies_not_attested');
    expect(first.coverage.inputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'scripts/entry.py' }),
      expect.objectContaining({ path: 'tools/python3' }),
    ]));
    stand.file('scripts/entry.py', `#!${stand.path('tools/python3')}\nprint("changed")\n`);
    const second = await port.capture(request);
    expect(second.status, JSON.stringify(second)).toBe('known');
    if (first.status !== 'known' || second.status !== 'known') throw new Error('Ожидались известные снимки');
    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  it('имя проектного файла toolchain:runner не превращает его в системный непрозрачный вход', async () => {
    const { stand, request: base } = graphFixture();
    stand.executable('toolchain:runner', `#!${stand.path('tools/runtime/bash')}\n./scripts/child.sh\n`);
    const request: ProjectCommandRequest = { ...base, command: {
      kind: 'direct', executable: './toolchain:runner', args: [], inputFiles: [],
    } };
    const snapshot = await createProjectCommandSnapshotPort().capture(request);
    expect(snapshot.status, JSON.stringify(snapshot)).toBe('known');
    expect(snapshot.coverage.inputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'toolchain:runner' }),
      expect.objectContaining({ path: 'scripts/child.sh' }),
      expect.objectContaining({ path: 'tools/runtime/bash' }),
    ]));
  });

  it('изменение дочернего script файла toolchain:runner инвалидирует согласие', async () => {
    const { stand, request: base } = graphFixture();
    stand.executable('toolchain:runner', `#!${stand.path('tools/runtime/bash')}\n./scripts/child.sh\n`);
    const request: ProjectCommandRequest = { ...base, command: {
      kind: 'direct', executable: './toolchain:runner', args: [], inputFiles: [],
    } };
    const policy = createProjectCommandConsent(createProjectCommandSnapshotPort());
    const challenge = await policy.evaluate(request);
    expect(challenge.status, JSON.stringify(challenge)).toBe('needs_consent');
    if (challenge.status !== 'needs_consent') throw new Error('Ожидался запрос согласия');
    const consent = await policy.confirm(challenge.challengeId);
    expect(consent.status, JSON.stringify(consent)).toBe('allowed');
    stand.file('scripts/child.sh', `#!${stand.path('tools/runtime/bash')}\necho changed\n`);
    expect(await policy.recheck(request)).toMatchObject({ status: 'needs_consent', reason: 'invalidated' });
  });

  it('внешний alias на проектный script обходится по реальной принадлежности файла', async () => {
    const { stand, request: base } = graphFixture();
    const entry = stand.executable('scripts/entry.sh', `#!${stand.path('tools/runtime/bash')}\n./scripts/child.sh\n`);
    // Ссылка также принадлежит собственному временному стенду, но лежит за границей projectRoot.
    const alias = join(stand.root, 'external-entry');
    symlinkSync(entry, alias);
    const request: ProjectCommandRequest = { ...base, command: {
      kind: 'direct', executable: alias, args: [], inputFiles: [],
    } };
    const policy = createProjectCommandConsent(createProjectCommandSnapshotPort());
    const challenge = await policy.evaluate(request);
    expect(challenge.status, JSON.stringify(challenge)).toBe('needs_consent');
    expect(challenge.coverage.inputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'scripts/child.sh' }),
      expect.objectContaining({ path: 'tools/runtime/bash' }),
    ]));
    if (challenge.status !== 'needs_consent') throw new Error('Ожидался запрос согласия');
    const consent = await policy.confirm(challenge.challengeId);
    expect(consent.status, JSON.stringify(consent)).toBe('allowed');
    stand.file('scripts/child.sh', `#!${stand.path('tools/runtime/bash')}\necho changed\n`);
    expect(await policy.recheck(request)).toMatchObject({ status: 'needs_consent', reason: 'invalidated' });
  });

  it('одинаковые имена внешних alias не создают ложный цикл разных проектных файлов', async () => {
    const { stand, request: base } = graphFixture();
    mkdirSync(join(stand.root, 'first'));
    mkdirSync(join(stand.root, 'second'));
    const firstAlias = join(stand.root, 'first', 'bash');
    const secondAlias = join(stand.root, 'second', 'bash');
    const firstInterpreter = stand.executable('scripts/first-interpreter', `#!${secondAlias}\necho first\n`);
    const secondInterpreter = stand.executable('scripts/second-interpreter');
    symlinkSync(firstInterpreter, firstAlias);
    symlinkSync(secondInterpreter, secondAlias);
    stand.executable('scripts/entry.sh', `#!${firstAlias}\necho entry\n`);
    const request: ProjectCommandRequest = { ...base, command: {
      kind: 'direct', executable: './scripts/entry.sh', args: [], inputFiles: [],
    } };
    const snapshot = await createProjectCommandSnapshotPort().capture(request);
    expect(snapshot.status, JSON.stringify(snapshot)).toBe('known');
    const interpreters = snapshot.coverage.inputs.filter(input => input.path === 'toolchain:bash');
    expect(interpreters).toHaveLength(2);
    expect(interpreters[0]?.digest).not.toBe(interpreters[1]?.digest);
  });

  it('реальный цикл проектных файлов через разные внешние alias остаётся запрещённым', async () => {
    const { stand, request: base } = graphFixture();
    const firstAlias = join(stand.root, 'first-alias');
    const secondAlias = join(stand.root, 'second-alias');
    const first = stand.executable('scripts/first-interpreter', `#!${secondAlias}\n`);
    const second = stand.executable('scripts/second-interpreter', `#!${firstAlias}\n`);
    symlinkSync(first, firstAlias);
    symlinkSync(second, secondAlias);
    const request: ProjectCommandRequest = { ...base, command: {
      kind: 'direct', executable: firstAlias, args: [], inputFiles: [],
    } };
    expect(await createProjectCommandSnapshotPort().capture(request)).toMatchObject({
      status: 'blocked', reason: 'dependency_cycle',
    });
  });

  it('смешанный регистр inline npm_config не скрывает подмену исполняемой оболочки', async () => {
    const { stand, request: base } = graphFixture();
    stand.executable('tools/zsh');
    stand.scripts({
      test: 'NpM_cOnFiG_script_shell=./tools/zsh npm run child',
      child: 'node scripts/main.js',
    });
    const request: ProjectCommandRequest = { ...base, command: { kind: 'npm-script', script: 'test', args: [] } };
    expect(await createProjectCommandSnapshotPort().capture(request)).toMatchObject({
      status: 'blocked', reason: 'unsupported_command',
    });
  });

  it.each([
    { name: 'npm', args: ['publish'] },
    { name: 'git', args: ['push', 'origin', 'main'] },
    { name: 'bash', args: ['-c', './scripts/child.sh'] },
    { name: 'rm', args: ['scripts/main.js'] },
  ])('относительный путь $name не обходит запрет неподдержанной операции', async ({ name, args }) => {
    const { stand, request: base } = graphFixture();
    stand.executable(`tools/${name}`);
    const request: ProjectCommandRequest = { ...base, command: {
      kind: 'direct', executable: `./tools/${name}`, args, inputFiles: [],
    } };
    expect(await createProjectCommandSnapshotPort().capture(request)).toMatchObject({
      status: 'blocked', reason: 'unsupported_command',
    });
  });

  it.each(['python3.12', 'pypy3', 'nodejs', 'perl'])('не трактует интерпретатор %s как непрозрачную обычную утилиту', async name => {
    const { stand, request: base } = graphFixture();
    stand.executable(`tools/${name}`);
    stand.file('scripts/entry', 'fixture content, never executed\n');
    const request: ProjectCommandRequest = { ...base, command: {
      kind: 'direct', executable: name, args: ['scripts/entry'], inputFiles: [],
    } };
    expect(await createProjectCommandSnapshotPort().capture(request)).toMatchObject({
      status: 'blocked', reason: 'unknown_dependency',
    });
  });

  it.each((['zsh', 'python3'] as const).flatMap(name =>
    (['bare', 'absolute', 'relative'] as const).map(form => ({ name, form })),
  ))('не выдаёт known неподдержанному интерпретатору $name ($form)', async ({ name, form }) => {
    const { stand, request: base } = graphFixture();
    stand.executable(`tools/${name}`);
    stand.file('scripts/main.py', 'print("fixture, never executed")\n');
    const executable = form === 'bare' ? name : form === 'absolute' ? stand.path(`tools/${name}`) : `./tools/${name}`;
    const request: ProjectCommandRequest = { ...base, command: {
      kind: 'direct', executable,
      args: name === 'zsh' ? ['-c', './scripts/child.sh'] : ['scripts/main.py'], inputFiles: [],
    } };
    expect(await createProjectCommandSnapshotPort().capture(request)).toMatchObject({
      status: 'blocked', reason: 'unknown_dependency',
    });
  });
});
