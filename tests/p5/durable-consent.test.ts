import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSqliteStorage } from '../../src/adapters/store/index.ts';
import { createProjectCommandSnapshotPort } from '../../src/adapters/project-command-snapshot/index.ts';
import { createProjectCommandConsent } from '../../src/core/project-command-consent.ts';
import type { ProjectCommandRequest } from '../../src/core/ports/project-command-snapshot.ts';
import { ConsentStand } from '../helpers/consent.ts';
import { consentPersistence } from '../helpers/p5-consent.ts';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
function stand() {
  const files = new ConsentStand(); cleanups.push(() => files.cleanup());
  const path = join(files.root, 'durable.sqlite');
  const storage = openSqliteStorage(path); cleanups.push(() => storage.close());
  const executable = files.executable('node'); files.file('setup.js', 'console.log("first");');
  storage.store.commit({ projects: [{ id: 'project', canonicalPath: files.projectRoot, name: 'own project', defaultBranch: 'main', configVersion: 1,
    config: { setup: null, copyFiles: [], setupTimeoutMs: 1000 } }] });
  const request: ProjectCommandRequest = { projectId: 'project', projectRoot: files.projectRoot, operationId: 'setup:workspace', purpose: 'setup',
    command: { kind: 'direct', executable, args: ['setup.js'], inputFiles: [] }, cwd: files.projectRoot,
    permissions: { fileSystem: 'workspace-write', network: 'denied', elevated: false }, env: {} };
  const policy = createProjectCommandConsent(createProjectCommandSnapshotPort(), consentPersistence(storage.store));
  return { files, storage, path, request, policy };
}
describe('P5: согласие P4 в настоящей SQLite между экземплярами', () => {
  it('сохранённое согласие требует нового снимка; старый challenge не оживает', async () => {
    const s = stand(); const first = await s.policy.evaluate(s.request);
    if (first.status !== 'needs_consent') throw new Error(JSON.stringify(first));
    const allowed = await s.policy.confirm(first.challengeId); expect(allowed.status).toBe('allowed');
    s.storage.close(); const reopened = openSqliteStorage(s.path); cleanups.push(() => reopened.close());
    const real = createProjectCommandSnapshotPort(), capture = vi.fn(real.capture.bind(real));
    const next = createProjectCommandConsent({ capture }, consentPersistence(reopened.store));
    expect(await next.confirm(first.challengeId)).toMatchObject({ status: 'blocked', reason: 'unknown_challenge' });
    expect(capture).not.toHaveBeenCalled();
    expect(await next.evaluate(s.request)).toEqual(allowed); expect(capture).toHaveBeenCalledOnce();
  });
  it('отзыв сохраняется при повторном открытии БД и неизменных файлах', async () => {
    const s = stand(); const first = await s.policy.evaluate(s.request);
    if (first.status !== 'needs_consent') throw new Error('Нет challenge');
    const allowed = await s.policy.confirm(first.challengeId);
    if (allowed.status !== 'allowed') throw new Error('Нет согласия');
    s.storage.close(); const second = openSqliteStorage(s.path); cleanups.push(() => second.close());
    const revoke = createProjectCommandConsent(createProjectCommandSnapshotPort(), consentPersistence(second.store));
    expect(revoke.revoke(allowed.consentId)).toBe(true); second.close();
    const third = openSqliteStorage(s.path); cleanups.push(() => third.close());
    expect(third.store.getConsent(allowed.consentId)?.status).toBe('revoked');
    const next = createProjectCommandConsent(createProjectCommandSnapshotPort(), consentPersistence(third.store));
    expect(await next.evaluate(s.request)).toMatchObject({ status: 'needs_consent', reason: 'invalidated' });
  });
  it('новый экземпляр инвалидирует изменённый вход; возврат байтов не восстанавливает решение', async () => {
    const s = stand(); const first = await s.policy.evaluate(s.request);
    if (first.status !== 'needs_consent') throw new Error('Нет challenge');
    const allowed = await s.policy.confirm(first.challengeId);
    if (allowed.status !== 'allowed') throw new Error('Нет согласия');
    s.storage.close(); s.files.file('setup.js', 'console.log("other");');
    const second = openSqliteStorage(s.path); cleanups.push(() => second.close());
    const next = createProjectCommandConsent(createProjectCommandSnapshotPort(), consentPersistence(second.store));
    expect(await next.recheck(s.request)).toMatchObject({ status: 'needs_consent', reason: 'invalidated' });
    expect(second.store.getConsent(allowed.consentId)?.status).toBe('invalidated'); second.close();
    s.files.file('setup.js', 'console.log("first");');
    const third = openSqliteStorage(s.path); cleanups.push(() => third.close());
    expect(await createProjectCommandConsent(createProjectCommandSnapshotPort(), consentPersistence(third.store)).recheck(s.request))
      .toMatchObject({ status: 'needs_consent', reason: 'invalidated' });
  });
  it('неизвестный снимок после restart отзывает сохранённый допуск', async () => {
    const s = stand(); const first = await s.policy.evaluate(s.request);
    if (first.status !== 'needs_consent') throw new Error('Нет challenge');
    const allowed = await s.policy.confirm(first.challengeId);
    if (allowed.status !== 'allowed') throw new Error('Нет согласия');
    s.storage.close(); unlinkSync(s.files.path('setup.js'));
    const nextStorage = openSqliteStorage(s.path); cleanups.push(() => nextStorage.close());
    const next = createProjectCommandConsent(createProjectCommandSnapshotPort(), consentPersistence(nextStorage.store));
    expect(await next.recheck(s.request)).toMatchObject({ status: 'blocked', reason: 'missing_input' });
    expect(nextStorage.store.getConsent(allowed.consentId)?.status).toBe('invalidated');
  });
});
