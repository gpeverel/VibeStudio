import { createHash, randomUUID } from 'node:crypto';
import type { Store } from '../../src/core/ports/store.ts';
import type { ConsentPersistence } from '../../src/core/project-command-consent.ts';

export const digest = (text: string) => createHash('sha256').update(text).digest('hex');
export function consentPersistence(store: Store): ConsentPersistence {
  return {
    find: operationId => store.findConsent(operationId), get: id => store.getConsent(id),
    save: record => { store.commit({ consents: [record] }); }, digest,
    nextId: randomUUID, now: () => new Date().toISOString(),
  };
}
