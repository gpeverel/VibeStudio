import type { ProjectRecord, WorkspaceRecord } from './store.ts';
export interface WorkspaceFiles {
  /** Канонизация, чтение явной конфигурации и проверка репозитория, без scripts. */
  inspectProject(path: string): Promise<Omit<ProjectRecord, 'id'>>;
  /** Путь внутри собственного корня приложения; без создания worktree/ветки. */
  allocatePath(sessionId: string): string;
  copyFiles(project: ProjectRecord, workspace: WorkspaceRecord): Promise<void>;
  inspect(workspace: WorkspaceRecord): Promise<'present' | 'missing' | 'uncertain'>;
}
