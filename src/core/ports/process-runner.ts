import type { ProcessCompletion, ProcessCompletionIssueCode } from '../../shared/agent.ts';
export type { ProcessCompletion, ProcessCompletionIssue, ProcessCompletionIssueCode, ProcessSignalResult, ProcessStreamState } from '../../shared/agent.ts';

export type ProcessErrorCode = ProcessCompletionIssueCode;

export interface ProcessRequest {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  stdin: string;
  timeoutMs?: number;
  stopGraceMs?: number;
  drainTimeoutMs?: number;
  maxQueueBytes?: number;
}
export interface ProcessResult {
  /** Совместимые проекции completion.process; null сам по себе не подтверждает exit. */
  exitCode: number | null;
  signal: string | null;
  /** Первая причина для прежних потребителей; все причины находятся в completion.issues. */
  error?: ProcessErrorCode;
  diagnostic?: string;
  readonly completion: ProcessCompletion;
}
export interface ProcessRun {
  stdout: AsyncIterable<Uint8Array>;
  stderr: AsyncIterable<Uint8Array>;
  /** Идемпотентный мягкий Stop с эскалацией; результат отправки сохраняется в done. */
  interrupt(): Promise<void>;
  /** Сигнал только собственному запуску/группе, без гарантии остановки detached-потомков. */
  kill(): Promise<void>;
  /** Конечное ожидание: разрешение по deadline не доказывает выход или штатный EOF.
   * Терминальный снимок не меняется после поздних событий или повторного Stop. */
  done: Promise<ProcessResult>;
  /** Идентичность только текущего владения; не пригодна для recovery после перезапуска. */
  readonly pid?: number;
}
export interface ProcessRunner { start(request: ProcessRequest): ProcessRun }
