/**
 * Тесты проверяют производственный порт `src/core/ports/git.ts`; отдельного дубля контракта нет.
 * createGitAdapter() экспортируется из src/adapters/git/index.ts и принимает необязательные
 * `store` (GitOperationStore) и `faultInjector` для воспроизведения сбоев.
 */
import type { GitAdapterOptions, GitPort, GitWarning } from '../../src/core/ports/git.ts';

export type { GitWarning };
export type GitBoundaryAdapter = GitPort;
export type CreateGitAdapter = (options?: GitAdapterOptions) => GitBoundaryAdapter | Promise<GitBoundaryAdapter>;
