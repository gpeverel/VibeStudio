import { TextDecoder } from 'node:util';
import type { AgentErrorReason } from '../../core/ports/agent.ts';
import type { ProcessResult } from '../../core/ports/process-runner.ts';
import type { InteractiveProcessRun } from '../process-runner/interactive.ts';

export type JsonObject = Record<string, unknown>;
export const object = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
export class RpcError extends Error {
  constructor(readonly reason: AgentErrorReason, detail: string) { super(detail); }
}
export type RpcMethod = 'initialize' | 'config/read' | 'thread/start' | 'thread/resume' | 'thread/inject_items'
  | 'turn/start' | 'turn/interrupt';

/** Ограниченный JSONL-RPC. Сырые ответы конфигурации и ошибки CLI не попадают в диагностику. */
export class CodexRpc {
  readonly closed: Promise<ProcessResult>;
  error: RpcError | undefined;
  private next = 0;
  private ended = false;
  private writes: Promise<void> = Promise.resolve();
  private pending = new Map<number, { resolve(value: JsonObject): void; reject(cause: RpcError): void }>();
  constructor(readonly run: InteractiveProcessRun, onNotification: (message: JsonObject) => void,
    readonly maxBytes = 4_194_304, readonly maxLineBytes = 1_048_576) {
    const fail = (reason: AgentErrorReason, detail: string): void => {
      this.error ??= new RpcError(reason, detail);
      for (const pending of this.pending.values()) pending.reject(this.error);
      this.pending.clear();
      void run.kill().catch(() => { this.error ??= new RpcError('signal_failed', 'Не удалось остановить app-server'); });
    };
    const stdout = (async () => {
      const decoder = new TextDecoder('utf-8', { fatal: true }); let line = ''; let bytes = 0;
      const consume = (text: string): void => {
        if (!text.trim()) return;
        const message = object(JSON.parse(text));
        if (!message) throw new Error('shape');
        if (typeof message.method === 'string') {
          // Ни approvals, ни dynamic tools клиент не исполняет. Профиль never не должен их запрашивать.
          if (Object.hasOwn(message, 'id')) throw new Error('server_request');
          onNotification(message); return;
        }
        if (typeof message.id !== 'number' || !this.pending.has(message.id)) throw new Error('response_id');
        const pending = this.pending.get(message.id)!; this.pending.delete(message.id);
        if (message.error !== undefined) {
          pending.reject(new RpcError('protocol_incompatible', 'app-server отклонил запрос RPC')); return;
        }
        const result = object(message.result);
        if (!result) { pending.reject(new RpcError('protocol_incompatible', 'Некорректный ответ RPC')); throw new Error('result'); }
        pending.resolve(result);
      };
      try {
        for await (const chunk of run.stdout) {
          bytes += chunk.byteLength;
          if (bytes > maxBytes) { fail('output_limit', 'Превышен объём ответа app-server'); break; }
          line += decoder.decode(chunk, { stream: true });
          let newline: number;
          while ((newline = line.indexOf('\n')) !== -1) {
            const row = line.slice(0, newline); line = line.slice(newline + 1);
            if (Buffer.byteLength(row) > maxLineBytes) { fail('output_limit', 'Превышен размер сообщения RPC'); return; }
            consume(row);
          }
          if (Buffer.byteLength(line) > maxLineBytes) { fail('output_limit', 'Превышен размер сообщения RPC'); break; }
        }
        line += decoder.decode(); if (line.trim()) consume(line);
      } catch { fail('protocol_incompatible', 'Повреждённый поток, неожиданный запрос или событие app-server'); }
    })();
    const stderr = (async () => {
      let bytes = 0;
      try { for await (const chunk of run.stderr) { bytes += chunk.byteLength; if (bytes > 65_536) { fail('output_limit', 'Превышен объём диагностики app-server'); break; } } }
      catch { fail('stream_failed', 'Не удалось прочитать диагностику app-server'); }
    })();
    this.closed = Promise.all([stdout, stderr, run.done]).then(([, , result]) => {
      this.ended = true;
      for (const pending of this.pending.values()) pending.reject(this.error ?? new RpcError('missing_result', 'app-server завершился до ответа RPC'));
      this.pending.clear(); return result;
    });
  }
  private send(value: JsonObject): Promise<void> {
    if (this.ended || this.error) return Promise.reject(this.error ?? new RpcError('missing_result', 'Соединение RPC закрыто'));
    const text = JSON.stringify(value) + '\n';
    if (Buffer.byteLength(text) > this.maxLineBytes) return Promise.reject(new RpcError('output_limit', 'Превышен размер запроса RPC'));
    const result = this.writes.then(() => this.run.send(text)); this.writes = result.catch(() => undefined); return result;
  }
  notifyInitialized(): Promise<void> { return this.send({ method: 'initialized', params: {} }); }
  call(method: RpcMethod, params: JsonObject): Promise<JsonObject> {
    if (this.pending.size >= 8) return Promise.reject(new RpcError('output_limit', 'Превышен лимит ожидающих запросов RPC'));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      void this.send({ id, method, params }).catch(() => {
        this.pending.delete(id); reject(new RpcError('spawn_failed', 'Не удалось отправить запрос app-server'));
      });
    });
  }
}
