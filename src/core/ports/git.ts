export type GitWarning = 'dirty_tree' | 'submodules_unsupported' | 'lfs_unsupported';

export interface CreateWorkspaceRequest {
  projectPath: string;
  workspacePath: string;
  sessionId: string;
  branch: string;
  baseRef: string;
}

export interface ApplyWorkspaceRequest {
  projectPath: string;
  workspacePath: string;
  baseRef: string;
  sessionId?: string;
}

export interface GitPort {
  inspectRepository(projectPath: string): Promise<{ head: string; warnings: GitWarning[] }>;
  createWorkspace(request: CreateWorkspaceRequest): Promise<{
    baseSha: string;
    warnings: GitWarning[];
    applyMode: 'apply' | 'keep_branch';
  }>;
  applyWorkspace(request: ApplyWorkspaceRequest): Promise<{ appliedSha: string; preApplyRef: string }>;
  pushWorkspace(request: { workspacePath: string; remote: string; branch: string }): Promise<void>;
}
