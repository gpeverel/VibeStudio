export type ProcessErrorCode = 'spawn_failed' | 'timeout' | 'drain_timeout' | 'output_limit' | 'stdin_failed' | 'unsupported_platform';

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
  exitCode: number | null;
  signal: string | null;
  error?: ProcessErrorCode;
  diagnostic?: string;
}
export interface ProcessRun {
  stdout: AsyncIterable<Uint8Array>;
  stderr: AsyncIterable<Uint8Array>;
  interrupt(): Promise<void>;
  kill(): Promise<void>;
  done: Promise<ProcessResult>;
  /** Идентичность только текущего владения; не пригодна для recovery после перезапуска. */
  readonly pid?: number;
}
export interface ProcessRunner { start(request: ProcessRequest): ProcessRun }
