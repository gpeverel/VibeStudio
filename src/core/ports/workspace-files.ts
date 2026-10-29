import type { ProjectRecord, WorkspaceRecord } from './store.ts';

export type WorkspaceFilesErrorCode =
  | 'invalid_project' | 'invalid_session_id' | 'workspace_exists' | 'unsafe_workspace_path'
  | 'invalid_copy_rule' | 'copy_source_missing' | 'copy_forbidden_path' | 'copy_symlink'
  | 'copy_tracked' | 'copy_not_ignored' | 'copy_collision' | 'copy_limit_exceeded' | 'copy_failed';

/** Доменный отказ порта. Сообщение называет причину, но не содержит содержимого файлов. */
export class WorkspaceFilesError extends Error {
  readonly code: WorkspaceFilesErrorCode;
  /** Номер правила copyFiles (с 0), если отказ относится к нему. */
  readonly rule: number | undefined;
  /** Ошибка отката копирования, если она была; исходная причина остаётся в cause. */
  readonly cleanupFailure: string | undefined;

  constructor(code: WorkspaceFilesErrorCode, message: string, options: { rule?: number; cause?: unknown; cleanupFailure?: string } = {}) {
    super(message, { cause: options.cause });
    this.name = 'WorkspaceFilesError';
    this.code = code;
    this.rule = options.rule;
    this.cleanupFailure = options.cleanupFailure;
  }
}

export interface WorkspaceFiles {
  /** Канонизация, чтение явной конфигурации и проверка репозитория, без scripts. */
  inspectProject(path: string): Promise<Omit<ProjectRecord, 'id'>>;
  /** Путь внутри собственного корня приложения; без создания worktree/ветки. */
  allocatePath(sessionId: string): string;
  copyFiles(project: ProjectRecord, workspace: WorkspaceRecord): Promise<void>;
  inspect(workspace: WorkspaceRecord): Promise<'present' | 'missing' | 'uncertain'>;
}
