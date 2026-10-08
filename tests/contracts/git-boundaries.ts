/** Предлагаемый тестовый контракт этапа 2; имена API не заданы SPEC.md. */
export type GitWarning = 'dirty_tree' | 'submodules_unsupported' | 'lfs_unsupported';

export interface GitBoundaryAdapter {
  inspectRepository(projectPath: string): Promise<{
    head: string;
    warnings: GitWarning[];
  }>;
  createWorkspace(request: {
    projectPath: string;
    workspacePath: string;
    sessionId: string;
    branch: string;
    baseRef: string;
  }): Promise<{
    baseSha: string;
    warnings: GitWarning[];
    applyMode: 'apply' | 'keep_branch';
  }>;
  applyWorkspace(request: {
    projectPath: string;
    workspacePath: string;
    baseRef: string;
  }): Promise<unknown>;
  pushWorkspace(request: {
    workspacePath: string;
    remote: string;
    branch: string;
  }): Promise<unknown>;
}

/**
 * Ошибки адаптера имеют code; dirty_tree также содержит files: string[].
 * Коды: not_git_repository, no_commits, dirty_tree, detached_head,
 * base_branch_missing, merge_conflict, non_fast_forward.
 * createGitAdapter() экспортируется из src/adapters/git/index.ts.
 */
export type CreateGitAdapter = () => GitBoundaryAdapter | Promise<GitBoundaryAdapter>;
