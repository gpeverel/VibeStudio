import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import type { ProcessResult, ProcessRun } from '../../../src/core/ports/process-runner.ts';

/** Только собственный CONTROL.txt стенда; произвольные shell-строки не разбираются. */
export const M4_READ_COMMAND = '/bin/cat -- CONTROL.txt';
const COMMANDS = new Set([M4_READ_COMMAND,
  ...['/bin/zsh', '/bin/bash', '/bin/sh'].flatMap(shell =>
    ['-c', '-lc'].map(flag => `${shell} ${flag} '${M4_READ_COMMAND}'`))]);
export const M4_READ_LIMITS = Object.freeze({ lineBytes: 65_536, totalBytes: 1_048_576, items: 256 });
type Reason = 'observed' | 'pending' | 'invalid_jsonl' | 'output_limit' | 'stream_incomplete'
  | 'completion_unconfirmed' | 'binding_mismatch' | 'read_missing' | 'read_failed' | 'ambiguous_read';
export interface M4CommandReadReview {
  basis: 'cli_jsonl_command_result';
  verdict: 'passed' | 'failed' | 'unconfirmed';
  reason: Reason;
}
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Прозрачное наблюдение одного уже созданного процесса, без запуска/Stop и второго читателя.
 * Сырые строки живут только в ограниченной памяти. Экспорт не содержит command/output/id/marker.
 * Подтверждает сообщённый CLI результат команды, а не syscalls или effective policy.
 * Подключается только к M4; R2 и production parser не меняются. */
export class M4CommandCapture {
  readonly run: ProcessRun;
  #marker: string;
  #thread: string | undefined;
  #turn = false;
  #terminal = false;
  #failure: Reason | undefined;
  #decoder = new TextDecoder('utf-8', { fatal: true });
  #line = '';
  #lineBytes = 0;
  #totalBytes = 0;
  #stdoutEnded = false;
  #stderrEnded = false;
  #result: ProcessResult | undefined;
  #items = new Map<string, { type: string; commandHash?: string; completed?: string }>();
  #reads: ('passed' | 'failed')[] = [];

  constructor(run: ProcessRun, marker: string) {
    if (!marker || marker.length > 256 || /[\r\n\0]/.test(marker)) throw new Error('Некорректная метка M4.');
    this.#marker = marker;
    const done = run.done.then(result => { this.#result = result; return result; }, error => {
      this.#fail('completion_unconfirmed'); throw error;
    });
    // Потребитель может начать читать потоки до ожидания done.
    void done.catch(() => {});
    this.run = { stdout: this.#observe(run.stdout, true), stderr: this.#observe(run.stderr, false),
      done, interrupt: () => run.interrupt(), kill: () => run.kill(),
      ...(run.pid === undefined ? {} : { pid: run.pid }) };
  }

  #fail(reason: Reason): void { this.#failure ??= reason; this.#line = ''; }

  async *#observe(stream: AsyncIterable<Uint8Array>, stdout: boolean): AsyncIterable<Uint8Array> {
    let ended = false;
    try {
      for await (const chunk of stream) {
        if (stdout) this.#feed(chunk);
        yield chunk;
      }
      ended = true;
      if (stdout) {
        if (!this.#failure) {
          try { this.#line += this.#decoder.decode(); this.#consume(); }
          catch { this.#fail('invalid_jsonl'); }
        }
        this.#stdoutEnded = true;
      } else this.#stderrEnded = true;
    } finally { if (!ended) this.#fail('stream_incomplete'); }
  }

  #feed(chunk: Uint8Array): void {
    if (this.#failure) return;
    this.#totalBytes += chunk.byteLength;
    if (this.#totalBytes > M4_READ_LIMITS.totalBytes) { this.#fail('output_limit'); return; }
    let offset = 0;
    while (offset < chunk.length && !this.#failure) {
      const newline = chunk.indexOf(10, offset);
      const end = newline === -1 ? chunk.length : newline;
      const part = chunk.subarray(offset, end);
      this.#lineBytes += part.length;
      if (this.#lineBytes > M4_READ_LIMITS.lineBytes) { this.#fail('output_limit'); return; }
      try {
        this.#line += this.#decoder.decode(part, { stream: true });
        if (newline !== -1) { this.#line += this.#decoder.decode(); this.#consume(); }
      } catch { this.#fail('invalid_jsonl'); }
      offset = end + 1;
    }
  }

  #consume(): void {
    const line = this.#line; this.#line = ''; this.#lineBytes = 0;
    if (!line.trim()) return;
    const value = object(JSON.parse(line));
    if (!value || typeof value.type !== 'string' || this.#terminal) { this.#fail('invalid_jsonl'); return; }
    if (value.type === 'thread.started') {
      if (this.#thread || typeof value.thread_id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.thread_id)) {
        this.#fail('invalid_jsonl'); return;
      }
      this.#thread = value.thread_id; return;
    }
    if (!this.#thread) { this.#fail('invalid_jsonl'); return; }
    if (value.type === 'turn.started' && !this.#turn) { this.#turn = true; return; }
    if (!this.#turn) { this.#fail('invalid_jsonl'); return; }
    if (value.type === 'turn.completed') { this.#terminal = true; return; }
    if (!['item.started', 'item.updated', 'item.completed'].includes(value.type)) { this.#fail('invalid_jsonl'); return; }
    const item = object(value.item);
    if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 256
      || typeof item.type !== 'string' || item.type.length > 64) {
      this.#fail('invalid_jsonl'); return;
    }
    const previous = this.#items.get(item.id);
    if (previous && previous.type !== item.type) { this.#fail('invalid_jsonl'); return; }
    if (item.type === 'command_execution' && typeof item.command !== 'string') { this.#fail('invalid_jsonl'); return; }
    const commandHash = item.type === 'command_execution'
      ? createHash('sha256').update(item.command as string).digest('hex') : undefined;
    if (previous?.commandHash !== undefined && previous.commandHash !== commandHash) { this.#fail('invalid_jsonl'); return; }
    if (!previous && this.#items.size >= M4_READ_LIMITS.items) { this.#fail('output_limit'); return; }
    const digest = value.type === 'item.completed' ? createHash('sha256').update(JSON.stringify(item)).digest('hex') : undefined;
    if (previous?.completed) {
      if (previous.completed !== digest) this.#fail('invalid_jsonl');
      return;
    }
    this.#items.set(item.id, { type: item.type, ...(commandHash ? { commandHash } : {}), ...(digest ? { completed: digest } : {}) });
    if (!digest || item.type !== 'command_execution' || typeof item.command !== 'string' || !COMMANDS.has(item.command)) return;
    if (typeof item.aggregated_output !== 'string' || typeof item.exit_code !== 'number' || !Number.isInteger(item.exit_code)
      || !['completed', 'failed'].includes(item.status as string)) { this.#fail('invalid_jsonl'); return; }
    this.#reads.push(item.status === 'completed' && item.exit_code === 0 && item.aggregated_output === this.#marker + '\n' ? 'passed' : 'failed');
  }

  review(marker: string, threadId: string | undefined): M4CommandReadReview {
    const result = (reason: Reason, verdict: M4CommandReadReview['verdict'] = 'unconfirmed'): M4CommandReadReview =>
      ({ basis: 'cli_jsonl_command_result', verdict, reason });
    if (this.#failure) return result(this.#failure);
    if (!this.#stdoutEnded || !this.#stderrEnded || !this.#result) return result('pending');
    const done = this.#result; const completion = done.completion;
    if (done.error || done.exitCode !== 0 || done.signal !== null || !this.#terminal
      || completion.process.state !== 'exited' || completion.process.exitCode !== 0 || completion.process.signal !== null
      || completion.stdout !== 'ended' || completion.stderr !== 'ended' || completion.wait !== 'settled'
      || completion.issues.length || completion.signals.some(signal => signal.status === 'failed')) return result('completion_unconfirmed');
    if (marker !== this.#marker || threadId !== this.#thread) return result('binding_mismatch');
    if (this.#reads.length === 0) return result('read_missing');
    if (this.#reads.length !== 1) return result('ambiguous_read');
    return this.#reads[0] === 'passed' ? result('observed', 'passed') : result('read_failed', 'failed');
  }
}
