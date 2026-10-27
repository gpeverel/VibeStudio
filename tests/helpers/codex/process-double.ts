import { PassThrough } from 'node:stream';
import { vi } from 'vitest';
import type { ProcessCompletion, ProcessRequest, ProcessResult, ProcessRun, ProcessRunner } from '../../../src/core/ports/process-runner.ts';

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export const cleanCompletion = (patch: Partial<ProcessCompletion> = {}): ProcessCompletion => ({
  process: { state: 'exited', exitCode: 0, signal: null }, stdout: 'ended', stderr: 'ended',
  signals: [], wait: 'settled', issues: [], descendants: 'not_guaranteed', ...patch,
});
export const processResult = (completion = cleanCompletion()): ProcessResult => ({
  exitCode: completion.process.state === 'exited' ? completion.process.exitCode : null,
  signal: completion.process.state === 'exited' ? completion.process.signal : null,
  completion,
});

/** Управляемые потоки и Promise; системных сигналов и запуска CLI здесь нет. */
export function processDouble() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const result = deferred<ProcessResult>();
  const launched = deferred<ProcessRequest>();
  const interrupt = vi.fn(async () => {});
  const kill = vi.fn(async () => {});
  const run: ProcessRun = { stdout, stderr, done: result.promise, interrupt, kill };
  const start = vi.fn((request: ProcessRequest) => { launched.resolve(request); return run; });
  const runner: ProcessRunner = { start };
  return { stdout, stderr, result, launched, interrupt, kill, run, start, runner };
}
