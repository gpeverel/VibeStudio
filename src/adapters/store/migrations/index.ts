import { migration0001 } from './0001-initial.ts';
import type { Migration } from './types.ts';

export type { Migration } from './types.ts';
export { ACTIVE_TURN_STATUSES, APPLICATION_ID } from './0001-initial.ts';

/** Нумерованный список без пропусков. Применённую миграцию не редактируют: добавляется следующая. */
export const MIGRATIONS: readonly Migration[] = [migration0001];
