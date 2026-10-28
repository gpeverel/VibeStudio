import type { ProjectCommandPurpose, ProjectCommandSnapshot } from '../../shared/project-command-consent.ts';

/** Внутреннее описание от доверенной композиции приложения, не DTO renderer.
 * Относительные пути direct (executable с путём, файловые args и inputFiles)
 * разрешаются от request.cwd. Bare-имя executable ищется по правилам адаптера. */
export type ProjectCommand =
  | { readonly kind: 'direct'; readonly executable: string; readonly args: readonly string[];
      /** Известные дополнительные входы. Список не утверждает полноту runtime imports. */
      readonly inputFiles: readonly string[] }
  | { readonly kind: 'npm-script'; readonly script: string; readonly args: readonly string[] };

export interface ProjectCommandRequest {
  readonly projectId: string;
  readonly projectRoot: string;
  /** Стабильный ID именованной операции приложения; не имя shell-команды. */
  readonly operationId: string;
  readonly purpose: ProjectCommandPurpose;
  readonly command: ProjectCommand;
  /** Абсолютный рабочий каталог внутри projectRoot; база относительных direct-путей. */
  readonly cwd: string;
  readonly permissions: {
    readonly fileSystem: 'read-only' | 'workspace-write' | 'unrestricted';
    readonly network: 'denied' | 'allowed';
    readonly elevated: boolean;
  };
  /** Полное существенное окружение будущего запуска, включая PATH/настройки интерпретатора.
   * Не сериализуется в решения/диагностику. Неизвестное наследуемое env не подразумевается. */
  readonly env: Readonly<Record<string, string>>;
}

export interface ProjectCommandSnapshotPort {
  /** Не запускает команды. Fingerprint связывает весь request и байты известных входов.
   * Каждый вызов читает заново; неизвестный вход возвращает blocked, не пустой known.
   * Адаптер отвечает за канонические пути, ограничения чтения и безопасные ошибки. */
  capture(request: ProjectCommandRequest): Promise<ProjectCommandSnapshot>;
}
