export type GitWarning = 'dirty_tree' | 'submodules_unsupported' | 'lfs_unsupported';

export type GitErrorCode =
  | 'git_unavailable' | 'git_failed' | 'not_git_repository' | 'no_commits'
  | 'invalid_reference' | 'invalid_branch' | 'invalid_session_id' | 'invalid_request'
  | 'dirty_tree' | 'detached_head' | 'base_branch_missing' | 'base_branch_not_checked_out'
  | 'invalid_workspace' | 'merge_conflict' | 'base_changed' | 'candidate_changed'
  | 'checks_stale' | 'operation_in_progress' | 'operation_not_found' | 'request_conflict'
  | 'session_applied' | 'commit_failed' | 'author_missing' | 'signing_required'
  | 'unsupported_repository' | 'git_operation_in_progress' | 'non_fast_forward' | 'push_failed';

/** Ошибки домена доступны ядру без зависимости от адаптера. */
export class GitError extends Error {
  readonly code: GitErrorCode;
  readonly files: string[];

  constructor(code: GitErrorCode, message: string, files: string[] = [], cause?: unknown) {
    super(message, { cause });
    this.name = 'GitError';
    this.code = code;
    this.files = files;
  }
}

export interface WorkspaceIdentity {
  projectPath: string;
  workspacePath: string;
  sessionId: string;
  branch: string;
  baseRef: string;
}
export interface CreateWorkspaceRequest extends WorkspaceIdentity { requestId: string }
export interface PrepareWorkspaceRequest extends WorkspaceIdentity { requestId: string }
export interface CreateWorkspaceResult {
  baseSha: string;
  warnings: GitWarning[];
  applyMode: 'apply' | 'keep_branch';
}
export interface PreparedCandidate extends WorkspaceIdentity {
  repositoryId: string;
  revisionId: string;
  expectedBaseSha: string;
  candidateSha: string;
  candidateTree: string;
}

/** Свидетельство проверок предоставляет доверенный вызывающий слой, не renderer. */
export type CandidateVerification = {
  revisionId: string;
  checksFingerprint: string;
} & ({ status: 'passed' } | { status: 'bypassed'; reason: string });
export interface ApplyWorkspaceRequest {
  requestId: string;
  candidate: PreparedCandidate;
  verification: CandidateVerification;
  checksFingerprint: string;
}
export type GitApplyPhase = 'intent_saved' | 'checkpoint_created' | 'commit_created'
  | 'files_updated' | 'ref_updated' | 'completed';
export type ApplyWorkspaceResult =
  | { status: 'applied'; operationId: string; appliedSha: string; preApplyRef: string }
  | { status: 'no_changes'; operationId: string }
  | { status: 'interrupted'; operationId: string; phase: GitApplyPhase; diagnostic: string };

/** Фаза описывает подтверждённый шаг; сбой между эффектом и записью требует сверки. */
export interface GitOperation {
  kind: 'create' | 'prepare' | 'apply';
  operationId: string;
  requestId: string;
  repositoryId: string;
  fingerprint: string;
  phase: GitApplyPhase;
  identity: WorkspaceIdentity;
  candidate?: PreparedCandidate;
  verification?: CandidateVerification;
  result?: ApplyWorkspaceResult;
  workspaceResult?: CreateWorkspaceResult;
  plannedSha?: string;
  preApplyRef?: string;
  error?: { code: GitErrorCode; message: string; files: string[] };
}

/** В 0B допускается память. Реальная durable-реализация и её приёмка — этап 1. */
export interface GitOperationStore {
  get(requestId: string): Promise<GitOperation | undefined>;
  save(operation: GitOperation): Promise<void>;
  list(): Promise<GitOperation[]>;
}
export type GitFaultPoint = 'after_intent'
  | 'before_checkpoint' | 'after_checkpoint' | 'before_commit' | 'after_commit'
  | 'before_files' | 'after_files' | 'before_ref' | 'after_ref'
  | 'before_result' | 'after_result';
export interface GitAdapterOptions {
  store?: GitOperationStore;
  faultInjector?: (point: GitFaultPoint, operation: Readonly<GitOperation>) => void | Promise<void>;
}
export interface ReconcileApplyRequest { projectPath: string; operationId: string }
export interface GitPort {
  inspectRepository(projectPath: string): Promise<{ head: string; warnings: GitWarning[] }>;
  createWorkspace(request: CreateWorkspaceRequest): Promise<CreateWorkspaceResult>;
  prepareWorkspace(request: PrepareWorkspaceRequest): Promise<PreparedCandidate>;
  applyWorkspace(request: ApplyWorkspaceRequest): Promise<ApplyWorkspaceResult>;
  reconcileApply(request: ReconcileApplyRequest): Promise<ApplyWorkspaceResult>;
  pushWorkspace(request: { workspacePath: string; remote: string; branch: string }): Promise<void>;
}
