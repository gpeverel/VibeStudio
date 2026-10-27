import { mkdirSync, rmSync, statSync, symlinkSync, utimesSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createProjectCommandSnapshotPort, nodeSnapshotFs } from '../../src/adapters/project-command-snapshot/index.ts';
import type { SnapshotFs } from '../../src/adapters/project-command-snapshot/index.ts';
import { createProjectCommandConsent } from '../../src/core/project-command-consent.ts';
import type { ProjectCommandConsentPolicy } from '../../src/core/project-command-consent.ts';
import type { ProjectCommandRequest, ProjectCommandSnapshotPort } from '../../src/core/ports/project-command-snapshot.ts';
import { ConsentStand } from '../helpers/consent.ts';

const stands: ConsentStand[] = [];
afterEach(() => { for (const stand of stands.splice(0)) stand.cleanup(); });
function setup(): ConsentStand {
  const stand = new ConsentStand(); stands.push(stand);
  for (const name of ['node', 'npm', 'bash']) stand.executable(`tools/${name}`, `synthetic ${name} identity\n`);
  stand.file('scripts/check.js', 'console.log("first");\n');
  stand.file('scripts/other.js', 'console.log("other");\n');
  stand.scripts({ test: 'node scripts/check.js' });
  return stand;
}
function input(stand: ConsentStand): ProjectCommandRequest {
  return {
    projectId: 'own-project', projectRoot: stand.projectRoot, operationId: 'unit-tests', purpose: 'test',
    command: { kind: 'npm-script', script: 'test', args: [] }, cwd: stand.projectRoot,
    permissions: { fileSystem: 'workspace-write', network: 'denied', elevated: false },
    env: { PATH: stand.path('tools'), NODE_ENV: 'test' },
  };
}
async function known(port: ProjectCommandSnapshotPort, request: ProjectCommandRequest) {
  const snapshot = await port.capture(request);
  expect(snapshot.status, JSON.stringify(snapshot)).toBe('known');
  if (snapshot.status !== 'known') throw new Error(`Снимок не установлен: ${snapshot.reason}`);
  return snapshot;
}
async function grant(policy: ProjectCommandConsentPolicy, request: ProjectCommandRequest) {
  const first = await policy.evaluate(request);
  expect(first.status, JSON.stringify(first)).toBe('needs_consent');
  if (first.status !== 'needs_consent') throw new Error('Ожидался запрос согласия');
  const approved = await policy.confirm(first.challengeId);
  expect(approved.status, JSON.stringify(approved)).toBe('allowed');
  if (approved.status !== 'allowed') throw new Error('Ожидалось подтверждённое согласие');
  return approved;
}

const conditions: [string, (request: ProjectCommandRequest, stand: ConsentStand) => ProjectCommandRequest][] = [
  ['проект', request => ({ ...request, projectId: 'other-project' })],
  ['операция', request => ({ ...request, operationId: 'other-operation' })],
  ['назначение', request => ({ ...request, purpose: 'build' })],
  ['argv', request => ({ ...request, command: { ...request.command, args: ['--changed'] } })],
  ['cwd', (request, stand) => { mkdirSync(stand.path('nested')); return { ...request, cwd: stand.path('nested') }; }],
  ['файловые права', request => ({ ...request, permissions: { ...request.permissions, fileSystem: 'unrestricted' } })],
  ['сеть', request => ({ ...request, permissions: { ...request.permissions, network: 'allowed' } })],
  ['повышение прав', request => ({ ...request, permissions: { ...request.permissions, elevated: true } })],
  ['существенное окружение', request => ({ ...request, env: { ...request.env, NODE_ENV: 'production' } })],
];

describe('P4: снимок проекта и политика работают вместе', () => {
  it('повторяет согласованную команду при прежних входах, показывая точные пределы покрытия', async () => {
    const stand = setup();
    const port = createProjectCommandSnapshotPort();
    const request = input(stand);
    const snapshot = await known(port, request);
    expect(snapshot.coverage.inputs.map(entry => entry.path)).toEqual(expect.arrayContaining([
      'package.json', 'scripts/check.js', 'tools/node', 'tools/npm', '.npmrc', 'package-lock.json', 'npm-shrinkwrap.json',
    ]));
    expect(snapshot.coverage.inputs.find(entry => entry.path === '.npmrc')).toMatchObject({ digest: null });
    expect(snapshot.coverage.limitations).toEqual(expect.arrayContaining([
      'runtime_dependencies_not_attested', 'system_toolchain_not_attested', 'filesystem_race_after_capture',
    ]));
    const policy = createProjectCommandConsent(port);
    const approved = await grant(policy, request);
    expect(await policy.recheck(request)).toEqual(approved);
    expect(await policy.evaluate(request)).toEqual(approved);
  });

  it('изменение тела npm script при прежнем имени команды инвалидирует согласие', async () => {
    const stand = setup();
    const request = input(stand);
    const policy = createProjectCommandConsent(createProjectCommandSnapshotPort());
    await grant(policy, request);
    stand.scripts({ test: 'node scripts/other.js' });
    expect(await policy.recheck(request)).toMatchObject({ status: 'needs_consent', reason: 'invalidated' });
  });

  it('изменение байтов entrypoint с прежними size/mtime инвалидирует согласие', async () => {
    const stand = setup();
    const path = stand.path('scripts/check.js');
    utimesSync(path, 1_000_000, 1_000_000);
    const before = statSync(path);
    const request = input(stand);
    const policy = createProjectCommandConsent(createProjectCommandSnapshotPort());
    await grant(policy, request);
    stand.replaceKeepingTimes('scripts/check.js', 'console.log("later");\n');
    expect(statSync(path).size).toBe(before.size);
    expect(statSync(path).mtimeMs).toBe(before.mtimeMs);
    expect(await policy.recheck(request)).toMatchObject({ status: 'needs_consent', reason: 'invalidated' });
  });

  it('отслеживает известный вызываемый npm script и его файловый вход', async () => {
    const stand = setup();
    stand.scripts({ test: 'npm run child', child: 'node scripts/check.js' });
    const request = input(stand);
    const policy = createProjectCommandConsent(createProjectCommandSnapshotPort());
    await grant(policy, request);
    stand.file('scripts/check.js', 'console.log("child changed");\n');
    expect(await policy.recheck(request)).toMatchObject({ status: 'needs_consent', reason: 'invalidated' });
    await grant(policy, request);
    stand.scripts({ test: 'npm run child', child: 'node scripts/other.js' });
    expect(await policy.recheck(request)).toMatchObject({ status: 'needs_consent', reason: 'invalidated' });
  });

  it.each(['pretest', 'posttest'])('добавление неявного lifecycle %s инвалидирует согласие', async lifecycle => {
    const stand = setup();
    const request = input(stand);
    const policy = createProjectCommandConsent(createProjectCommandSnapshotPort());
    await grant(policy, request);
    stand.scripts({ test: 'node scripts/check.js', [lifecycle]: 'node scripts/other.js' });
    expect(await policy.recheck(request)).toMatchObject({ status: 'needs_consent', reason: 'invalidated' });
  });

  it('правка между вопросом пользователю и confirm требует нового решения', async () => {
    const stand = setup();
    const request = input(stand);
    const policy = createProjectCommandConsent(createProjectCommandSnapshotPort());
    const challenge = await policy.evaluate(request);
    if (challenge.status !== 'needs_consent') throw new Error('Ожидался запрос согласия');
    stand.file('scripts/check.js', 'console.log("after prompt");\n');
    expect(await policy.confirm(challenge.challengeId)).toMatchObject({ status: 'blocked', reason: 'stale_challenge' });
    expect((await policy.recheck(request)).status).toBe('needs_consent');
  });

  it('пропажа входа отзывает согласие; восстановление файла не оживляет его', async () => {
    const stand = setup();
    const request = input(stand);
    const policy = createProjectCommandConsent(createProjectCommandSnapshotPort());
    await grant(policy, request);
    rmSync(stand.path('scripts/check.js'));
    expect(await policy.recheck(request)).toMatchObject({ status: 'blocked', reason: 'missing_input' });
    stand.file('scripts/check.js', 'console.log("first");\n');
    expect((await policy.recheck(request)).status).toBe('needs_consent');
  });

  it.each(conditions)('fingerprint и допуск меняются вместе с условием «%s»', async (_label, change) => {
    const stand = setup();
    const request = input(stand);
    const port = createProjectCommandSnapshotPort();
    const policy = createProjectCommandConsent(port);
    const approved = await grant(policy, request);
    const changed = change(request, stand);
    expect((await known(port, changed)).fingerprint).not.toBe(approved.fingerprint);
    expect((await policy.recheck(changed)).status).toBe('needs_consent');
  });

  it('изменение executable и его байтов учитывается отдельно от имени npm script', async () => {
    const stand = setup();
    const port = createProjectCommandSnapshotPort();
    const request: ProjectCommandRequest = { ...input(stand), command: {
      kind: 'direct', executable: stand.path('tools/node'), args: ['scripts/check.js'], inputFiles: [],
    } };
    const first = await known(port, request);
    stand.executable('tools/node', 'changed synthetic executable\n');
    expect((await known(port, request)).fingerprint).not.toBe(first.fingerprint);
    stand.executable('tools/another/node', 'changed synthetic executable\n');
    const renamed: ProjectCommandRequest = { ...request, command: {
      kind: 'direct', executable: stand.path('tools/another/node'), args: ['scripts/check.js'], inputFiles: [],
    } };
    expect((await known(port, renamed)).fingerprint).not.toBe((await known(port, request)).fingerprint);
  });

  it('перенос идентичного проекта в другой корень меняет fingerprint', async () => {
    const first = setup();
    const second = setup();
    const port = createProjectCommandSnapshotPort();
    expect((await known(port, input(first))).fingerprint).not.toBe((await known(port, input(second))).fingerprint);
  });

  it('порядок ключей env и один mtime не меняют fingerprint; порядок argv меняет', async () => {
    const stand = setup();
    const port = createProjectCommandSnapshotPort();
    const request = input(stand);
    const first = await known(port, request);
    utimesSync(stand.path('scripts/check.js'), 1_000_000, 1_000_000);
    const reordered = { ...request, env: { NODE_ENV: 'test', PATH: stand.path('tools') } };
    expect((await known(port, reordered)).fingerprint).toBe(first.fingerprint);
    const a = { ...request, command: { ...request.command, args: ['one', 'two'] } };
    const b = { ...request, command: { ...request.command, args: ['two', 'one'] } };
    expect((await known(port, a)).fingerprint).not.toBe((await known(port, b)).fingerprint);
  });

  it.each(['.npmrc', 'package-lock.json', 'npm-shrinkwrap.json'])('появление и изменение %s учитывается снимком', async name => {
    const stand = setup();
    const port = createProjectCommandSnapshotPort();
    const request = input(stand);
    const first = await known(port, request);
    stand.file(name, name === '.npmrc' ? 'audit=false\n' : '{"lockfileVersion":3}');
    const second = await known(port, request);
    expect(second.fingerprint).not.toBe(first.fingerprint);
    stand.file(name, name === '.npmrc' ? 'audit=true\n' : '{"lockfileVersion":2}');
    expect((await known(port, request)).fingerprint).not.toBe(second.fingerprint);
  });

  it('переданные npm argv добавляют известные node --test entrypoints в снимок', async () => {
    const stand = setup();
    stand.scripts({ test: 'node --test scripts/check.js' });
    const request: ProjectCommandRequest = { ...input(stand), command: { kind: 'npm-script', script: 'test', args: ['scripts/other.js'] } };
    const port = createProjectCommandSnapshotPort();
    const first = await known(port, request);
    expect(first.coverage.inputs).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'scripts/other.js' })]));
    stand.file('scripts/other.js', 'console.log("forwarded changed");\n');
    expect((await known(port, request)).fingerprint).not.toBe(first.fingerprint);
  });

  it('дополнительные явно известные direct inputFiles участвуют в снимке', async () => {
    const stand = setup();
    const request: ProjectCommandRequest = { ...input(stand), command: {
      kind: 'direct', executable: stand.path('tools/node'), args: ['scripts/check.js'], inputFiles: ['scripts/other.js'],
    } };
    const port = createProjectCommandSnapshotPort();
    const first = await known(port, request);
    stand.file('scripts/other.js', 'console.log("dependency changed");\n');
    expect((await known(port, request)).fingerprint).not.toBe(first.fingerprint);
  });

  it.each(['bash scripts/top.sh', './scripts/top.sh', 'own-check'])(
    'известный вызов из shell-entrypoint учитывается для %s', async command => {
      const stand = setup();
      stand.executable('scripts/top.sh', `#!${stand.path('tools/bash')}\nset -eu\nbash scripts/child.sh\n`);
      stand.executable('node_modules/.bin/own-check', `#!${stand.path('tools/bash')}\nbash scripts/child.sh\n`);
      stand.file('scripts/child.sh', 'node scripts/check.js\n');
      stand.scripts({ test: command });
      const request = input(stand);
      const port = createProjectCommandSnapshotPort();
      const first = await known(port, request);
      expect(first.coverage.inputs).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'scripts/child.sh' })]));
      stand.file('scripts/child.sh', 'node scripts/other.js\n');
      expect((await known(port, request)).fingerprint).not.toBe(first.fingerprint);
    },
  );

  it('изменение цели внутренней symlink учитывается даже при одинаковых байтах', async () => {
    const stand = setup();
    stand.file('scripts/same.js', 'console.log("first");\n');
    symlinkSync(stand.path('scripts/check.js'), stand.path('scripts/linked.js'));
    stand.scripts({ test: 'node scripts/linked.js' });
    const port = createProjectCommandSnapshotPort();
    const first = await known(port, input(stand));
    rmSync(stand.path('scripts/linked.js')); symlinkSync(stand.path('scripts/same.js'), stand.path('scripts/linked.js'));
    expect((await known(port, input(stand))).fingerprint).not.toBe(first.fingerprint);
  });

  it('прямой bash использует встроенный echo без внешнего файла в PATH', async () => {
    const stand = setup();
    stand.file('scripts/top.sh', 'echo hello\n');
    const request: ProjectCommandRequest = { ...input(stand), command: {
      kind: 'direct', executable: stand.path('tools/bash'), args: ['scripts/top.sh'], inputFiles: [],
    } };
    const snapshot = await known(createProjectCommandSnapshotPort(), request);
    expect(snapshot.coverage.inputs.map(entry => entry.path)).toEqual(['scripts/top.sh', 'tools/bash']);
  });

  it('строковый env-ключ __proto__ не теряется при создании снимка', async () => {
    const stand = setup();
    const port = createProjectCommandSnapshotPort();
    const request = input(stand);
    const first = await known(port, { ...request, env: { ...request.env, ['__proto__']: 'first' } });
    const second = await known(port, { ...request, env: { ...request.env, ['__proto__']: 'second' } });
    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  it('изменение известного shebang-интерпретатора инвалидирует снимок', async () => {
    const stand = setup();
    stand.executable('scripts/top.sh', `#!${stand.path('tools/bash')}\nnode scripts/check.js\n`);
    stand.scripts({ test: './scripts/top.sh' });
    const port = createProjectCommandSnapshotPort();
    const first = await known(port, input(stand));
    expect(first.coverage.inputs).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'tools/bash' })]));
    stand.executable('tools/bash', 'changed interpreter bytes\n');
    expect((await known(port, input(stand))).fingerprint).not.toBe(first.fingerprint);
  });

  it('сохраняет секретные env/argv только внутри fingerprint, не в диагностике', async () => {
    const stand = setup();
    const secret = 'P4_PRIVATE_VALUE_12345';
    const request: ProjectCommandRequest = { ...input(stand), env: { ...input(stand).env, PRIVATE_TOKEN: secret },
      command: { kind: 'npm-script', script: 'test', args: [secret] } };
    const port = createProjectCommandSnapshotPort();
    const snapshot = await known(port, request);
    expect(JSON.stringify(snapshot)).not.toContain(secret);
    expect(JSON.stringify(snapshot)).not.toContain(stand.root);
    expect((await known(port, { ...request, env: { ...request.env, PRIVATE_TOKEN: 'changed-secret' } })).fingerprint).not.toBe(snapshot.fingerprint);
    const blocked = await port.capture({ ...request, env: { ...request.env, BASH_ENV: secret } });
    expect(blocked).toMatchObject({ status: 'blocked', reason: 'unsupported_command' });
    expect(JSON.stringify(blocked)).not.toContain(secret);
  });
});

describe('P4: неполные и неоднозначные снимки блокируются', () => {
  it.each([
    ['повтор scripts', '{"scripts":{"test":"node scripts/check.js"},"scripts":{"test":"node scripts/other.js"}}'],
    ['повтор test', '{"scripts":{"test":"node scripts/check.js","test":"node scripts/other.js"}}'],
    ['повтор декодированного ключа', '{"scripts":{"test":"node scripts/check.js","te\\u0073t":"node scripts/other.js"}}'],
    ['повреждённый JSON', '{"scripts":'],
    ['нестроковый script', '{"scripts":{"test":true}}'],
  ])('отклоняет %s', async (_label, manifest) => {
    const stand = setup(); stand.file('package.json', manifest);
    expect(await createProjectCommandSnapshotPort().capture(input(stand))).toMatchObject({ status: 'blocked', reason: 'ambiguous_manifest' });
  });

  it('цикл именованных scripts не создаёт частичный разрешающий снимок', async () => {
    const stand = setup(); stand.scripts({ test: 'npm run child', child: 'npm run test' });
    expect(await createProjectCommandSnapshotPort().capture(input(stand))).toMatchObject({ status: 'blocked', reason: 'dependency_cycle' });
  });

  it('неизвестная команда не считается отсутствующей зависимостью с разрешением', async () => {
    const stand = setup(); stand.scripts({ test: 'tool-that-does-not-exist' });
    expect(await createProjectCommandSnapshotPort().capture(input(stand))).toMatchObject({ status: 'blocked', reason: 'unknown_dependency' });
  });

  it('недоступный известный вход возвращает unreadable_input без сырого сообщения', async () => {
    const stand = setup();
    const fs: SnapshotFs = { ...nodeSnapshotFs, open: async (path, flags) => {
      if (path === stand.path('scripts/check.js')) throw Object.assign(new Error('P4_PRIVATE_EACCES'), { code: 'EACCES' });
      return nodeSnapshotFs.open(path, flags);
    } };
    const result = await createProjectCommandSnapshotPort({ fs }).capture(input(stand));
    expect(result).toMatchObject({ status: 'blocked', reason: 'unreadable_input' });
    expect(JSON.stringify(result)).not.toContain('P4_PRIVATE_EACCES');
  });

  it('каталог вместо entrypoint возвращает non_regular_input', async () => {
    const stand = setup(); rmSync(stand.path('scripts/check.js')); mkdirSync(stand.path('scripts/check.js'));
    expect(await createProjectCommandSnapshotPort().capture(input(stand))).toMatchObject({ status: 'blocked', reason: 'non_regular_input' });
  });

  it('символическая ссылка за корень проекта возвращает outside_project', async () => {
    const stand = setup(); const external = setup();
    rmSync(stand.path('scripts/check.js')); symlinkSync(external.path('scripts/check.js'), stand.path('scripts/check.js'));
    expect(await createProjectCommandSnapshotPort().capture(input(stand))).toMatchObject({ status: 'blocked', reason: 'outside_project' });
  });

  it('неоднозначный относительный PATH не разрешает поиск другого executable', async () => {
    const stand = setup();
    expect(await createProjectCommandSnapshotPort().capture({ ...input(stand), env: { PATH: './tools' } }))
      .toMatchObject({ status: 'blocked', reason: 'ambiguous_path' });
  });

  it('ограничение размера script даёт типизированный отказ', async () => {
    const stand = setup();
    expect(await createProjectCommandSnapshotPort({ limits: { scriptBytes: 4 } }).capture(input(stand)))
      .toMatchObject({ status: 'blocked', reason: 'limit_exceeded' });
  });

  it('неизвестные вызовы в shell-файле дают отказ', async () => {
    const stand = setup();
    stand.file('scripts/top.sh', 'node "$SCRIPT"\n');
    stand.scripts({ test: 'bash scripts/top.sh' });
    expect(await createProjectCommandSnapshotPort().capture(input(stand))).toMatchObject({ status: 'blocked', reason: 'unsupported_command' });
  });

  it('цикл shell-файлов блокируется', async () => {
    const stand = setup();
    stand.file('scripts/top.sh', 'bash scripts/child.sh\n');
    stand.file('scripts/child.sh', 'bash scripts/top.sh\n');
    stand.scripts({ test: 'bash scripts/top.sh' });
    expect(await createProjectCommandSnapshotPort().capture(input(stand))).toMatchObject({ status: 'blocked', reason: 'dependency_cycle' });
  });

  it('npm ci без отключения неизвестных dependency lifecycle не получает согласие', async () => {
    const stand = setup(); stand.file('package-lock.json', '{"lockfileVersion":3}');
    const request: ProjectCommandRequest = { ...input(stand), purpose: 'setup', command: {
      kind: 'direct', executable: stand.path('tools/npm'), args: ['ci'], inputFiles: [],
    } };
    const port = createProjectCommandSnapshotPort();
    expect(await port.capture(request)).toMatchObject({ status: 'blocked', reason: 'unknown_dependency' });
    const limited: ProjectCommandRequest = { ...request, command: { ...request.command, args: ['ci', '--ignore-scripts'] } };
    const snapshot = await known(port, limited);
    expect(snapshot.coverage.inputs).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'package-lock.json' })]));
  });

  it.each([
    'script-shell=./scripts/custom.sh\n', 'onload-script=./scripts/custom.js\n',
    '"script-shell"=./scripts/custom.sh\n', 'prefix=./nested\n', 'workspace=nested\n',
    'userconfig=./nested/.npmrc\n',
  ])(
    'проектная npm-конфигурация не подменяет исполнитель: %s', async content => {
      const stand = setup(); stand.file('.npmrc', content);
      expect(await createProjectCommandSnapshotPort().capture(input(stand))).toMatchObject({ status: 'blocked', reason: 'unsupported_command' });
    },
  );

  it.each(['npm_config_prefix', 'NPM_CONFIG_WORKSPACE', 'npm_config_userconfig'])(
    'окружение %s не выбирает неподтверждённые входы npm', async name => {
      const stand = setup();
      const request = { ...input(stand), env: { ...input(stand).env, [name]: './nested' } };
      expect(await createProjectCommandSnapshotPort().capture(request)).toMatchObject({ status: 'blocked', reason: 'unsupported_command' });
    },
  );

  it('импортируемая bash-функция не подменяет найденный исполняемый файл', async () => {
    const stand = setup();
    stand.file('scripts/top.sh', 'node scripts/check.js\n');
    stand.scripts({ test: 'bash scripts/top.sh' });
    const request = { ...input(stand), env: { ...input(stand).env, 'BASH_FUNC_node%%': '() { bash scripts/hidden.sh; }' } };
    const result = await createProjectCommandSnapshotPort().capture(request);
    expect(result).toMatchObject({ status: 'blocked', reason: 'unsupported_command' });
    expect(JSON.stringify(result)).not.toContain('hidden.sh');
  });

  it('размер shell-файла не отключает анализ известных дочерних вызовов', async () => {
    const stand = setup();
    stand.executable('scripts/top.sh', `#!${stand.path('tools/bash')}\nbash scripts/missing.sh\n`);
    const request: ProjectCommandRequest = { ...input(stand), command: {
      kind: 'direct', executable: stand.path('scripts/top.sh'), args: [], inputFiles: [],
    } };
    expect(await createProjectCommandSnapshotPort({ limits: { scriptBytes: 16 } }).capture(request))
      .toMatchObject({ status: 'blocked', reason: 'limit_exceeded' });
  });

  it.each(['#!/usr/bin/env /bin/bash', '#!/bin/bash -l', '#!/usr/bin/env bash --rcfile hidden'])(
    'неподдержанный shebang не становится непрозрачным разрешённым файлом: %s', async header => {
      const stand = setup();
      stand.executable('scripts/top.sh', `${header}\nbash scripts/missing.sh\n`);
      stand.scripts({ test: './scripts/top.sh' });
      expect(await createProjectCommandSnapshotPort().capture(input(stand)))
        .toMatchObject({ status: 'blocked', reason: 'unsupported_command' });
    },
  );

  it('git external diff не выдаётся за подтверждённую обычную проверку', async () => {
    const stand = setup(); stand.scripts({ test: 'git diff --ext-diff' });
    expect(await createProjectCommandSnapshotPort().capture(input(stand))).toMatchObject({ status: 'blocked', reason: 'unknown_dependency' });
  });

  it.each(['git push', 'npm publish', 'rm -rf ./data'])('назначение test не скрывает опасную команду %s', async body => {
    const stand = setup(); stand.scripts({ test: body });
    expect(await createProjectCommandSnapshotPort().capture(input(stand))).toMatchObject({ status: 'blocked', reason: 'unsupported_command' });
  });
});
