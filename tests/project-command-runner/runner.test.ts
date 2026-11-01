import { existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProcessRunner } from '../../src/adapters/process-runner/index.ts';
import { createProjectCommandRunner, MAX_COMMAND_TIMEOUT_MS } from '../../src/adapters/project-command-runner/index.ts';
import { createProjectCommandSnapshotPort } from '../../src/adapters/project-command-snapshot/index.ts';
import type { ProcessRequest, ProcessRun, ProcessRunner } from '../../src/core/ports/process-runner.ts';
import type { ProjectCommandRequest } from '../../src/core/ports/project-command-snapshot.ts';
import { createProjectCommandConsent } from '../../src/core/project-command-consent.ts';
import type { ProjectCommandConsentDecision } from '../../src/shared/project-command-consent.ts';
import { ConsentStand } from '../helpers/consent.ts';

const stands: ConsentStand[] = [];
afterEach(() => { for (const stand of stands.splice(0)) stand.cleanup(); });

function stand(): ConsentStand {
  const own = new ConsentStand();
  stands.push(own);
  return own;
}

const coverage = { profile: 'project-command-v1', inputs: [], limitations: [] } as const;
const allowed: ProjectCommandConsentDecision = { status: 'allowed', consentId: 'consent-1', fingerprint: 'a'.repeat(64), coverage };
const authorizationFor = (recheck: (request: ProjectCommandRequest) => Promise<ProjectCommandConsentDecision>) =>
  ({ consentId: 'consent-1', fingerprint: 'a'.repeat(64), recheck });

function recordingRunner(): { runner: ProcessRunner; started: ProcessRequest[] } {
  const started: ProcessRequest[] = [];
  const run = { stdout: (async function* () { /* пусто */ })(), stderr: (async function* () { /* пусто */ })() } as unknown as ProcessRun;
  return { started, runner: { start: request => { started.push(request); return run; } } };
}

function request(own: ConsentStand, overrides: Partial<ProjectCommandRequest> = {}): ProjectCommandRequest {
  return {
    projectId: 'project-1', projectRoot: own.projectRoot, operationId: 'setup:project-1', purpose: 'setup',
    command: { kind: 'npm-script', script: 'setup', args: ['--flag'] }, cwd: own.projectRoot,
    permissions: { fileSystem: 'workspace-write', network: 'denied', elevated: false },
    env: { PATH: '/synthetic/bin', NODE_ENV: 'test' }, ...overrides,
  };
}

describe('ProjectCommandRunner: исполнитель именованной команды', () => {
  it('перепроверяет тот же замороженный запрос и запускает процесс с теми же командой, cwd и окружением', async () => {
    const own = stand();
    const { runner, started } = recordingRunner();
    const input = request(own);
    const seen: ProjectCommandRequest[] = [];
    const result = await createProjectCommandRunner({ runner }).start(input, authorizationFor(async checked => {
      seen.push(checked);
      return allowed;
    }), 10_000);

    expect(result.status).toBe('started');
    expect(seen).toHaveLength(1);
    expect(Object.isFrozen(seen[0])).toBe(true);
    expect(Object.isFrozen(seen[0]?.env)).toBe(true);
    // Тот же объект, а не копия: доверенный колбэк сравнивает его с запросом, который получит процесс.
    expect(seen[0]).toBe(input);
    expect(started).toEqual([{
      executable: 'npm', args: ['run', 'setup', '--', '--flag'], cwd: own.projectRoot,
      env: { PATH: '/synthetic/bin', NODE_ENV: 'test' }, stdin: '', timeoutMs: 10_000,
    }]);
  });

  it('прямая команда запускается как есть: executable и argv без shell и без добавлений', async () => {
    const own = stand();
    const { runner, started } = recordingRunner();
    const input = request(own, { command: { kind: 'direct', executable: '/synthetic/bin/node', args: ['scripts/a.js'], inputFiles: ['scripts/a.js'] } });
    await createProjectCommandRunner({ runner }).start(input, authorizationFor(async () => allowed), 5_000);
    expect(started[0]).toMatchObject({ executable: '/synthetic/bin/node', args: ['scripts/a.js'] });
  });

  it('не запускает процесс без актуального согласия и возвращает типизированное решение', async () => {
    const own = stand();
    const { runner, started } = recordingRunner();
    const start = (decision: ProjectCommandConsentDecision) =>
      createProjectCommandRunner({ runner }).start(request(own), authorizationFor(async () => decision), 10_000);

    for (const decision of [
      { status: 'needs_consent', reason: 'invalidated', challengeId: 'c', fingerprint: 'b'.repeat(64), coverage },
      { status: 'blocked', reason: 'unknown_dependency', coverage },
    ] as const) {
      expect(await start(decision)).toEqual({ status: 'blocked', decision });
    }
    // Допуск чужого согласия или другого снимка не принимается.
    expect(await start({ ...allowed, consentId: 'чужое' })).toMatchObject({ status: 'blocked', decision: { reason: 'stale_challenge' } });
    expect(await start({ ...allowed, fingerprint: 'c'.repeat(64) })).toMatchObject({ status: 'blocked', decision: { reason: 'stale_challenge' } });
    expect(started).toEqual([]);
  });

  it('ошибка перепроверки не превращается в разрешение', async () => {
    const own = stand();
    const { runner, started } = recordingRunner();
    await expect(createProjectCommandRunner({ runner }).start(request(own), authorizationFor(async () => {
      throw new Error('синтетический сбой снимка');
    }), 10_000)).rejects.toThrowError('синтетический сбой снимка');
    expect(started).toEqual([]);
  });

  it.each(['push', 'publish', 'destructive'] as const)('назначение %s требует отдельного разрешения и не доходит до перепроверки', async purpose => {
    const own = stand();
    const { runner, started } = recordingRunner();
    const recheck = vi.fn(async () => allowed);
    const result = await createProjectCommandRunner({ runner }).start(request(own, { purpose }), authorizationFor(recheck), 10_000);
    expect(result).toMatchObject({ status: 'blocked', decision: { status: 'blocked', reason: 'separate_authorization_required' } });
    expect(recheck).not.toHaveBeenCalled();
    expect(started).toEqual([]);
  });

  it('cwd вне проекта (в том числе через symlink) и недопустимый предел времени блокируются до перепроверки', async () => {
    const own = stand();
    const outside = stand();
    symlinkSync(outside.projectRoot, own.path('escape'));
    mkdirSync(own.path('inside'));
    const { runner, started } = recordingRunner();
    const recheck = vi.fn(async () => allowed);
    const sut = createProjectCommandRunner({ runner });

    expect(await sut.start(request(own, { cwd: own.path('escape') }), authorizationFor(recheck), 10_000))
      .toMatchObject({ status: 'blocked', decision: { reason: 'outside_project' } });
    expect(await sut.start(request(own, { cwd: own.path('нет-такого') }), authorizationFor(recheck), 10_000))
      .toMatchObject({ status: 'blocked', decision: { reason: 'outside_project' } });
    for (const timeout of [0, -1, 1.5, MAX_COMMAND_TIMEOUT_MS + 1, Number.NaN, Infinity]) {
      expect(await sut.start(request(own), authorizationFor(recheck), timeout))
        .toMatchObject({ status: 'blocked', decision: { reason: 'invalid_request' } });
    }
    expect(recheck).not.toHaveBeenCalled();
    expect(started).toEqual([]);
    expect(await sut.start(request(own, { cwd: own.path('inside') }), authorizationFor(async () => allowed), 10_000))
      .toMatchObject({ status: 'started' });
  });

  it('запрос замораживается на месте: ни вызывающий, ни колбэк не меняют его между проверкой и запуском', async () => {
    const own = stand();
    const { runner, started } = recordingRunner();
    const input = request(own, { env: { PATH: '/synthetic/bin' } });
    await createProjectCommandRunner({ runner }).start(input, authorizationFor(async checked => {
      expect(() => { (checked.env as Record<string, string>).PATH = '/подмена'; }).toThrowError(TypeError);
      expect(() => { (checked.command.args as string[]).push('--extra'); }).toThrowError(TypeError);
      return allowed;
    }), 10_000);
    expect(() => { (input as { cwd: string }).cwd = '/подмена'; }).toThrowError(TypeError);
    expect(started[0]).toMatchObject({ env: { PATH: '/synthetic/bin' }, cwd: own.projectRoot });
  });
});

describe('ProjectCommandRunner: вложенная неизменяемость', () => {
  it('частично замороженный запрос (только верхний объект) замораживается глубоко до перепроверки', async () => {
    const own = stand();
    const { runner, started } = recordingRunner();
    const input = Object.freeze(request(own, { env: { PATH: '/synthetic/bin' } }));
    expect(Object.isFrozen(input.env)).toBe(false);
    expect(Object.isFrozen(input.command)).toBe(false);

    await createProjectCommandRunner({ runner }).start(input, authorizationFor(async checked => {
      expect(() => { (checked.env as Record<string, string>).PATH = '/подмена'; }).toThrowError(TypeError);
      expect(() => { (checked.command.args as string[]).push('--extra'); }).toThrowError(TypeError);
      expect(() => { (checked.permissions as { network: string }).network = 'allowed'; }).toThrowError(TypeError);
      return allowed;
    }), 10_000);
    expect(Object.isFrozen(input.env) && Object.isFrozen(input.command) && Object.isFrozen(input.command.args)).toBe(true);
    expect(started[0]).toMatchObject({ env: { PATH: '/synthetic/bin' }, args: ['run', 'setup', '--', '--flag'] });
  });
});

describe('ProjectCommandRunner с настоящими снимком P4, политикой и ProcessRunner', () => {
  function project(): ConsentStand {
    const own = stand();
    // Собственные синтетические «инструменты»: npm записывает argv и рабочий каталог, ничего не устанавливая.
    // Shebang на абсолютный node: окружение запуска содержит только каталог tools.
    own.executable('tools/npm', `#!${process.execPath}\nrequire('node:fs').writeFileSync(require('node:path').join(process.cwd(), 'ran.txt'), process.argv.slice(2).join('\\n') + '\\n');\n`);
    own.executable('tools/node', 'synthetic node identity, never executed\n');
    own.file('scripts/setup.js', 'console.log("setup v1");\n');
    own.scripts({ setup: 'node scripts/setup.js' });
    return own;
  }
  const environment = (own: ConsentStand) => ({ PATH: own.path('tools') });
  const setupRequest = (own: ConsentStand): ProjectCommandRequest => request(own, {
    command: { kind: 'npm-script', script: 'setup', args: [] }, env: environment(own),
  });

  it('согласованный setup выполняется ровно как показано, а изменение script до запуска блокирует процесс', async () => {
    const own = project();
    const policy = createProjectCommandConsent(createProjectCommandSnapshotPort());
    const sut = createProjectCommandRunner({ runner: createProcessRunner() });
    const input = setupRequest(own);

    const challenge = await policy.evaluate(input);
    expect(challenge.status, JSON.stringify(challenge)).toBe('needs_consent');
    if (challenge.status !== 'needs_consent') return;
    const approved = await policy.confirm(challenge.challengeId);
    expect(approved.status).toBe('allowed');
    if (approved.status !== 'allowed') return;
    const authorization = { consentId: approved.consentId, fingerprint: approved.fingerprint, recheck: (checked: ProjectCommandRequest) => policy.recheck(checked) };

    const started = await sut.start(input, authorization, 20_000);
    expect(started.status).toBe('started');
    if (started.status !== 'started') return;
    const result = await started.run.done;
    expect(result.completion.process).toMatchObject({ state: 'exited', exitCode: 0 });
    expect(readFileSync(own.path('ran.txt'), 'utf8')).toBe('run\nsetup\n');

    // Тело известного script изменилось после согласия: процесс не запускается.
    const marker = readFileSync(own.path('ran.txt'), 'utf8');
    own.file('ran.txt', 'очищено');
    own.file('scripts/setup.js', 'console.log("setup v2");\n');
    const blocked = await sut.start(input, authorization, 20_000);
    expect(blocked).toMatchObject({ status: 'blocked', decision: { status: 'needs_consent', reason: 'invalidated' } });
    expect(readFileSync(own.path('ran.txt'), 'utf8')).toBe('очищено');
    expect(marker).toBe('run\nsetup\n');
  });

  it('несогласованная команда и подделанное разрешение не запускают процесс', async () => {
    const own = project();
    const policy = createProjectCommandConsent(createProjectCommandSnapshotPort());
    const sut = createProjectCommandRunner({ runner: createProcessRunner() });
    const input = setupRequest(own);

    // Согласие не выдавалось; поддельный consentId из renderer не помогает.
    const forged = { consentId: 'consent-подделка', fingerprint: 'a'.repeat(64), recheck: (checked: ProjectCommandRequest) => policy.recheck(checked) };
    expect(await sut.start(input, forged, 20_000)).toMatchObject({ status: 'blocked', decision: { status: 'needs_consent' } });
    // Рекурсивный «разрешающий» колбэк чужого запроса не принимается: нужен allowed для той же пары consentId и fingerprint.
    expect(await sut.start(input, { ...forged, recheck: async () => ({ ...allowed, consentId: 'consent-1' }) }, 20_000))
      .toMatchObject({ status: 'blocked', decision: { reason: 'stale_challenge' } });
    expect(existsSync(own.path('ran.txt'))).toBe(false);
  });
});
