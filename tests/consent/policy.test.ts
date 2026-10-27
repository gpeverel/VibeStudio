import { describe, expect, it, vi } from 'vitest';
import { createProjectCommandConsent } from '../../src/core/project-command-consent.ts';
import type { ProjectCommandRequest } from '../../src/core/ports/project-command-snapshot.ts';
import type { ProjectCommandCoverage, ProjectCommandSnapshot } from '../../src/shared/project-command-consent.ts';

const coverage: ProjectCommandCoverage = {
  profile: 'project-command-v1',
  inputs: [{ path: 'scripts/check.js', kind: 'file', digest: 'a'.repeat(64) }],
  limitations: ['runtime_dependencies_not_attested', 'system_toolchain_not_attested', 'filesystem_race_after_capture'],
};
function known(version = 'a'): ProjectCommandSnapshot {
  return { status: 'known', fingerprint: version.repeat(64), coverage: structuredClone(coverage) };
}
function request(): ProjectCommandRequest {
  return {
    projectId: 'own-project', projectRoot: '/synthetic/project', operationId: 'check-unit-tests', purpose: 'test',
    command: { kind: 'direct', executable: '/synthetic/node', args: ['scripts/check.js'], inputFiles: ['scripts/check.js'] },
    cwd: '/synthetic/project', permissions: { fileSystem: 'workspace-write', network: 'denied', elevated: false },
    env: { TEST_MODE: 'unit' },
  };
}

const contextChanges: [string, (input: ProjectCommandRequest) => ProjectCommandRequest][] = [
  ['проект', input => ({ ...input, projectId: 'another-project' })],
  ['корень проекта', input => ({ ...input, projectRoot: '/synthetic/other' })],
  ['назначение', input => ({ ...input, purpose: 'setup' })],
  ['операция', input => ({ ...input, operationId: 'another-operation' })],
  ['cwd', input => ({ ...input, cwd: '/synthetic/project/nested' })],
  ['команда', input => ({ ...input, command: { kind: 'direct', executable: '/synthetic/other-node', args: ['scripts/check.js'], inputFiles: ['scripts/check.js'] } })],
  ['argv', input => ({ ...input, command: { ...input.command, args: ['scripts/check.js', '--changed'] } })],
  ['файловые права', input => ({ ...input, permissions: { ...input.permissions, fileSystem: 'unrestricted' } })],
  ['сеть', input => ({ ...input, permissions: { ...input.permissions, network: 'allowed' } })],
  ['повышение прав', input => ({ ...input, permissions: { ...input.permissions, elevated: true } })],
  ['окружение', input => ({ ...input, env: { ...input.env, TEST_MODE: 'integration' } })],
];

describe('P4: доверенная политика конкретного согласия', () => {
  it('выдаёт согласие только после подтверждения и допускает неизменный повтор', async () => {
    const capture = vi.fn(async () => known());
    const policy = createProjectCommandConsent({ capture });
    const input = request();
    const first = await policy.evaluate(input);
    expect(first).toMatchObject({ status: 'needs_consent', reason: 'not_granted', coverage });
    if (first.status !== 'needs_consent') throw new Error('Ожидался запрос согласия');
    const approved = await policy.confirm(first.challengeId);
    expect(approved).toMatchObject({ status: 'allowed', fingerprint: 'a'.repeat(64), coverage });
    expect(capture).toHaveBeenCalledTimes(2);
    expect(await policy.evaluate(input)).toEqual(approved);
    expect(await policy.recheck(input)).toEqual(approved);
    expect(capture).toHaveBeenCalledTimes(4);
  });

  it('перепроверка без подтверждения сама не создаёт согласие', async () => {
    const policy = createProjectCommandConsent({ capture: async () => known() });
    expect(await policy.recheck(request())).toMatchObject({ status: 'needs_consent', reason: 'not_granted' });
  });

  it('повторно читает входы при confirm и отклоняет изменившийся challenge', async () => {
    let version = 'a';
    const policy = createProjectCommandConsent({ capture: async () => known(version) });
    const first = await policy.evaluate(request());
    if (first.status !== 'needs_consent') throw new Error('Ожидался запрос согласия');
    version = 'b';
    expect(await policy.confirm(first.challengeId)).toMatchObject({ status: 'blocked', reason: 'stale_challenge' });
    version = 'a';
    expect((await policy.confirm(first.challengeId)).status).toBe('blocked');
    expect((await policy.recheck(request())).status).toBe('needs_consent');
  });

  it('наблюдённая смена входа отзывает согласие даже после возврата исходных байтов', async () => {
    let version = 'a';
    const policy = createProjectCommandConsent({ capture: async () => known(version) });
    const input = request();
    const first = await policy.evaluate(input);
    if (first.status !== 'needs_consent') throw new Error('Ожидался запрос согласия');
    expect((await policy.confirm(first.challengeId)).status).toBe('allowed');
    version = 'b';
    expect(await policy.recheck(input)).toMatchObject({ status: 'needs_consent', reason: 'invalidated' });
    version = 'a';
    expect((await policy.recheck(input)).status).toBe('needs_consent');
  });

  it.each(['missing_input', 'unreadable_input', 'ambiguous_manifest', 'unknown_dependency', 'unstable_input'] as const)(
    'отзывает старое согласие при %s; восстановление доступности не является подтверждением', async reason => {
      let snapshot = known();
      const policy = createProjectCommandConsent({ capture: async () => snapshot });
      const input = request();
      const first = await policy.evaluate(input);
      if (first.status !== 'needs_consent') throw new Error('Ожидался запрос согласия');
      expect((await policy.confirm(first.challengeId)).status).toBe('allowed');
      snapshot = { status: 'blocked', reason, coverage };
      expect(await policy.recheck(input)).toMatchObject({ status: 'blocked', reason, coverage });
      snapshot = known();
      expect((await policy.recheck(input)).status).toBe('needs_consent');
    },
  );

  it('отзывает согласие явно и не принимает неизвестный challenge', async () => {
    const policy = createProjectCommandConsent({ capture: async () => known() });
    const first = await policy.evaluate(request());
    if (first.status !== 'needs_consent') throw new Error('Ожидался запрос согласия');
    const approved = await policy.confirm(first.challengeId);
    if (approved.status !== 'allowed') throw new Error('Ожидалось подтверждённое согласие');
    policy.revoke(approved.consentId);
    expect((await policy.recheck(request())).status).toBe('needs_consent');
    expect(await policy.confirm('foreign-challenge')).toMatchObject({ status: 'blocked', reason: 'unknown_challenge' });
  });

  it('согласие и challenge не переносятся в новый экземпляр политики', async () => {
    const port = { capture: async () => known() };
    const firstPolicy = createProjectCommandConsent(port);
    const first = await firstPolicy.evaluate(request());
    if (first.status !== 'needs_consent') throw new Error('Ожидался запрос согласия');
    expect((await firstPolicy.confirm(first.challengeId)).status).toBe('allowed');
    const restarted = createProjectCommandConsent(port);
    expect(await restarted.confirm(first.challengeId)).toMatchObject({ status: 'blocked', reason: 'unknown_challenge' });
    expect((await restarted.recheck(request())).status).toBe('needs_consent');
  });

  it.each(contextChanges)('не переносит согласие при изменении условия «%s», даже при прежнем digest', async (_label, mutate) => {
    const policy = createProjectCommandConsent({ capture: async () => known() });
    const first = await policy.evaluate(request());
    if (first.status !== 'needs_consent') throw new Error('Ожидался запрос согласия');
    expect((await policy.confirm(first.challengeId)).status).toBe('allowed');
    expect((await policy.recheck(mutate(request()))).status).toBe('needs_consent');
  });

  it('порядок ключей env не меняет смысл уже согласованного окружения', async () => {
    const policy = createProjectCommandConsent({ capture: async () => known() });
    const input = { ...request(), env: { MODE: 'test', COLOR: '0' } };
    const first = await policy.evaluate(input);
    if (first.status !== 'needs_consent') throw new Error('Ожидался запрос согласия');
    const approved = await policy.confirm(first.challengeId);
    expect(approved.status).toBe('allowed');
    expect(await policy.recheck({ ...input, env: { COLOR: '0', MODE: 'test' } })).toEqual(approved);
  });

  it('изменение исходного объекта после evaluate не подменяет показанный пользователю запрос', async () => {
    const env = { MODE: 'before' };
    const args = ['scripts/check.js'];
    const input = { ...request(), env, command: { kind: 'direct' as const, executable: '/synthetic/node', args, inputFiles: ['scripts/check.js'] } };
    const observed: ProjectCommandRequest[] = [];
    const policy = createProjectCommandConsent({ capture: async current => { observed.push(current); return known(); } });
    const pending = policy.evaluate(input);
    env.MODE = 'after';
    args.push('another-script.js');
    const first = await pending;
    if (first.status !== 'needs_consent') throw new Error('Ожидался запрос согласия');
    expect((await policy.confirm(first.challengeId)).status).toBe('allowed');
    expect(observed).toHaveLength(2);
    for (const captured of observed) {
      expect(captured.env).toEqual({ MODE: 'before' });
      expect(captured.command.args).toEqual(['scripts/check.js']);
    }
    expect((await policy.recheck(input)).status).toBe('needs_consent');
  });

  it.each((['setup', 'test'] as const).flatMap(source =>
    (['push', 'publish', 'destructive'] as const).map(purpose => ({ source, purpose })),
  ))('согласие $source не разрешает назначение $purpose', async ({ source, purpose }) => {
    const capture = vi.fn(async () => known());
    const policy = createProjectCommandConsent({ capture });
    const first = await policy.evaluate({ ...request(), purpose: source });
    if (first.status !== 'needs_consent') throw new Error('Ожидался запрос согласия');
    expect((await policy.confirm(first.challengeId)).status).toBe('allowed');
    expect(await policy.recheck({ ...request(), purpose })).toMatchObject({ status: 'blocked', reason: 'separate_authorization_required' });
  });

  it('approved/verified, доверие проекту и широкий Bash не создают согласие', async () => {
    const capture = vi.fn(async () => known());
    const policy = createProjectCommandConsent({ capture });
    const forged = { ...request(), approved: true, verified: true, ready: true, trustedProject: true, allowBash: true };
    expect(await policy.evaluate(forged)).toMatchObject({ status: 'blocked', reason: 'invalid_request' });
    expect(capture).not.toHaveBeenCalled();
  });

  it.each(['fileSystem', 'network'] as const)('отклоняет неверный тип права %s до чтения', async field => {
    const capture = vi.fn(async () => known());
    const policy = createProjectCommandConsent({ capture });
    const original = request();
    const malformed = { ...original, permissions: { ...original.permissions, [field]: [original.permissions[field]] } };
    expect(await policy.evaluate(malformed as unknown as ProjectCommandRequest)).toMatchObject({ status: 'blocked', reason: 'invalid_request' });
    expect(capture).not.toHaveBeenCalled();
  });

  it('отзыв во время чтения не позволяет позднему снимку восстановить согласие', async () => {
    let release: (snapshot: ProjectCommandSnapshot) => void = () => { throw new Error('Снимок ещё не ожидается'); };
    let signalStarted: () => void = () => { throw new Error('Ожидание ещё не создано'); };
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    let pause = false;
    const policy = createProjectCommandConsent({ capture: async () => {
      if (!pause) return known();
      signalStarted();
      return new Promise<ProjectCommandSnapshot>(resolve => { release = resolve; });
    } });
    const first = await policy.evaluate(request());
    if (first.status !== 'needs_consent') throw new Error('Ожидался запрос согласия');
    const approved = await policy.confirm(first.challengeId);
    if (approved.status !== 'allowed') throw new Error('Ожидалось подтверждённое согласие');
    pause = true;
    const pending = policy.recheck(request());
    await started;
    expect(policy.revoke(approved.consentId)).toBe(true);
    release(known());
    expect(await pending).toMatchObject({ status: 'blocked', reason: 'stale_challenge' });
    pause = false;
    expect((await policy.recheck(request())).status).toBe('needs_consent');
  });

  it('два одновременных подтверждения одного вопроса дают ровно одно согласие', async () => {
    const policy = createProjectCommandConsent({ capture: async () => known() });
    const first = await policy.evaluate(request());
    if (first.status !== 'needs_consent') throw new Error('Ожидался запрос согласия');
    const results = await Promise.all([policy.confirm(first.challengeId), policy.confirm(first.challengeId)]);
    expect(results.filter(result => result.status === 'allowed')).toHaveLength(1);
    expect(results.filter(result => result.status === 'blocked')).toEqual([
      expect.objectContaining({ status: 'blocked', reason: 'unknown_challenge' }),
    ]);
  });

  it('отзыв другой операции не инвалидирует неизменную проверку в ожидании чтения', async () => {
    let pending = false;
    let release!: () => void;
    let enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const firstInput = request();
    const secondInput = { ...request(), operationId: 'independent-check' };
    const policy = createProjectCommandConsent({ capture: async input => {
      if (pending && input.operationId === firstInput.operationId) { enter(); await held; }
      return known();
    } });
    const first = await policy.evaluate(firstInput);
    const second = await policy.evaluate(secondInput);
    if (first.status !== 'needs_consent' || second.status !== 'needs_consent') throw new Error('Ожидались вопросы');
    const firstGrant = await policy.confirm(first.challengeId);
    const secondGrant = await policy.confirm(second.challengeId);
    if (firstGrant.status !== 'allowed' || secondGrant.status !== 'allowed') throw new Error('Ожидались согласия');
    pending = true;
    const checking = policy.recheck(firstInput);
    await entered;
    expect(policy.revoke(secondGrant.consentId)).toBe(true);
    release();
    expect(await checking).toEqual(firstGrant);
    expect((await policy.recheck(secondInput)).status).toBe('needs_consent');
  });

  it.each(['args', 'inputFiles'] as const)('отклоняет разреженный массив %s до чтения', async field => {
    const capture = vi.fn(async () => known());
    const policy = createProjectCommandConsent({ capture });
    const command = { kind: 'direct' as const, executable: '/synthetic/node', args: ['scripts/check.js'], inputFiles: [] as string[] };
    command[field] = new Array<string>(1);
    expect(await policy.evaluate({ ...request(), command })).toMatchObject({ status: 'blocked', reason: 'invalid_request' });
    expect(capture).not.toHaveBeenCalled();
  });

  it.each<ProjectCommandCoverage>([
    { ...coverage, inputs: new Array<ProjectCommandCoverage['inputs'][number]>(1) },
    { ...coverage, limitations: new Array<ProjectCommandCoverage['limitations'][number]>(1) },
    { ...coverage, inputs: [{ path: 'optional', kind: 'configuration', digest: null }] },
  ])('не принимает known с неполной областью покрытия %#', async malformed => {
    const policy = createProjectCommandConsent({ capture: async () => ({
      status: 'known', fingerprint: 'a'.repeat(64), coverage: malformed,
    }) });
    expect(await policy.evaluate(request())).toMatchObject({ status: 'blocked', reason: 'snapshot_failed' });
  });

  it('исключение чтения даёт закрытый отказ без текста секрета и пути', async () => {
    const secret = 'P4_SECRET_MUST_NOT_APPEAR';
    const policy = createProjectCommandConsent({ capture: async () => { throw new Error(`/private/${secret}: EACCES`); } });
    const result = await policy.evaluate({ ...request(), env: { PRIVATE_TOKEN: secret } });
    expect(result).toMatchObject({ status: 'blocked', reason: 'snapshot_failed' });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain('/private/');
  });
});
