import { TextDecoder } from 'node:util';
import type { AgentDiagnostic, AgentErrorReason, AgentRunResult, AgentUsage, NormalizedPayload } from '../../core/ports/agent.ts';

export const DEFAULT_PARSER_LIMITS = {
  maxLineBytes: 1_048_576,
  maxDiagBytes: 16_384,
  maxStateBytes: 2_097_152,
  maxMessages: 1024,
};
export interface ParserOptions {
  maxLineBytes?: number;
  maxDiagBytes?: number;
  maxStateBytes?: number;
  maxMessages?: number;
  expectedSessionId?: string;
}
type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

function usage(value: unknown): AgentUsage {
  const source = object(value) ?? {};
  return {
    inputTokens: number(source.input_tokens),
    outputTokens: number(source.output_tokens),
    cacheReadTokens: number(source.cache_read_input_tokens),
    cacheCreationTokens: number(source.cache_creation_input_tokens),
  };
}

/** JSONL и нормализация без процесса. result — кандидат, не доказательство success. */
export class ClaudeStreamParser {
  readonly diagnostics: AgentDiagnostic[] = [];
  result: AgentRunResult | undefined;
  error: { reason: AgentErrorReason; detail: string } | undefined;
  private decoder = new TextDecoder('utf-8', { fatal: true });
  private line = '';
  private lineBytes = 0;
  private diagBytes = 0;
  private stateBytes = 0;
  private ended = false;
  private activeMessage = '';
  private texts = new Map<string, string>();
  private tools = new Set<string>();
  private finishedTools = new Set<string>();
  private usages = new Map<string, AgentUsage>();
  private lastUsage = '';
  private assistantError: AgentErrorReason | undefined;
  private limits: typeof DEFAULT_PARSER_LIMITS;

  constructor(private readonly options: ParserOptions = {}) {
    this.limits = { ...DEFAULT_PARSER_LIMITS };
    for (const name of Object.keys(this.limits) as (keyof typeof DEFAULT_PARSER_LIMITS)[]) {
      if (options[name] !== undefined) this.limits[name] = options[name];
    }
    for (const value of Object.values(this.limits)) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new Error('Лимит парсера должен быть положительным конечным целым');
    }
  }

  private fail(reason: AgentErrorReason, detail: string): void { this.error ??= { reason, detail }; }
  private diagnostic(code: string, detail: string): void {
    const size = Buffer.byteLength(code + detail);
    if (this.diagBytes + size > this.limits.maxDiagBytes) return;
    this.diagBytes += size;
    this.diagnostics.push({ code, detail });
  }

  feed(chunk: Uint8Array): NormalizedPayload[] {
    const events: NormalizedPayload[] = [];
    if (this.ended || this.error) return events;
    let offset = 0;
    while (offset < chunk.length && !this.error) {
      const newline = chunk.indexOf(10, offset);
      const end = newline === -1 ? chunk.length : newline;
      const part = chunk.subarray(offset, end);
      this.lineBytes += part.length;
      if (this.lineBytes > this.limits.maxLineBytes) {
        this.fail('output_limit', 'Превышен размер строки JSONL');
        break;
      }
      try { this.line += this.decoder.decode(part, { stream: true }); }
      catch { this.fail('protocol_incompatible', 'Некорректный UTF-8'); break; }
      if (newline !== -1) {
        try { this.line += this.decoder.decode(); }
        catch { this.fail('protocol_incompatible', 'Оборванный UTF-8'); break; }
        events.push(...this.consumeLine());
      }
      offset = end + 1;
    }
    return events;
  }

  /** Возвращает события последней полной JSON-строки без завершающего LF. */
  end(): NormalizedPayload[] {
    if (this.ended) return [];
    this.ended = true;
    if (this.error) return [];
    try { this.line += this.decoder.decode(); }
    catch { this.fail('protocol_incompatible', 'Оборванный UTF-8'); return []; }
    return this.line.trim() ? this.consumeLine() : [];
  }

  private consumeLine(): NormalizedPayload[] {
    const line = this.line;
    this.line = '';
    this.lineBytes = 0;
    if (!line.trim()) return [];
    let value: JsonObject | undefined;
    try { value = object(JSON.parse(line)); }
    catch { this.fail('protocol_incompatible', 'Повреждённая или оборванная строка JSONL'); return []; }
    if (!value || typeof value.type !== 'string') {
      this.fail('protocol_incompatible', 'У события отсутствует тип'); return [];
    }
    if (typeof value.session_id === 'string' && this.options.expectedSessionId && value.session_id !== this.options.expectedSessionId) {
      this.fail('protocol_incompatible', 'CLI вернул другой идентификатор диалога'); return [];
    }
    if (this.result && (['result', 'assistant', 'user', 'stream_event'].includes(value.type)
      || (value.type === 'system' && value.subtype === 'init'))) {
      this.fail('protocol_incompatible', 'Событие после терминального результата'); return [];
    }
    const events = this.normalize(value);
    if (this.texts.size + this.tools.size + this.usages.size + this.finishedTools.size > this.limits.maxMessages || this.stateBytes > this.limits.maxStateBytes) {
      this.fail('output_limit', 'Превышен бюджет состояния парсера'); return [];
    }
    return events;
  }

  private text(id: string, text: string, mode: 'delta' | 'snapshot'): NormalizedPayload[] {
    if (!this.texts.has(id)) this.stateBytes += Buffer.byteLength(id);
    const previous = this.texts.get(id) ?? '';
    const next = mode === 'delta' ? previous + text : text;
    this.stateBytes += mode === 'delta' ? Buffer.byteLength(text) : Buffer.byteLength(next) - Buffer.byteLength(previous);
    this.texts.set(id, next);
    if (mode === 'delta') return text ? [{ type: 'text', messageId: id, mode, text }] : [];
    if (previous === next) return [];
    if (next.startsWith(previous)) return [{ type: 'text', messageId: id, mode: 'delta', text: next.slice(previous.length) }];
    return [{ type: 'text', messageId: id, mode: 'snapshot', text }];
  }

  private tool(block: JsonObject): NormalizedPayload[] {
    if (typeof block.id !== 'string' || typeof block.name !== 'string') {
      this.fail('protocol_incompatible', 'Некорректный вызов инструмента'); return [];
    }
    if (this.tools.has(block.id)) return [];
    this.tools.add(block.id);
    this.stateBytes += Buffer.byteLength(block.id + block.name);
    return [{ type: 'tool_started', toolCallId: block.id, tool: block.name, inputPreview: '[вход скрыт]' }];
  }

  private usageEvent(id: string, current: AgentUsage): NormalizedPayload[] {
    const previous = this.usages.get(id) ?? {};
    const merged = { ...previous };
    for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens'] as const) {
      if (current[key] !== undefined) merged[key] = current[key];
    }
    if (JSON.stringify(previous) === JSON.stringify(merged)) return [];
    if (!this.usages.has(id)) this.stateBytes += Buffer.byteLength(id);
    this.usages.set(id, merged);
    const total: AgentUsage = {};
    for (const item of this.usages.values()) {
      for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens'] as const) {
        if (item[key] !== undefined) total[key] = (total[key] ?? 0) + item[key];
      }
    }
    return this.usageSnapshot(total);
  }

  private usageSnapshot(total: AgentUsage): NormalizedPayload[] {
    const signature = JSON.stringify(total);
    if (signature === this.lastUsage) return [];
    this.lastUsage = signature;
    return [{ type: 'usage', mode: 'snapshot', usage: total }];
  }

  private errorReason(category: unknown, status?: unknown): AgentErrorReason {
    if (category === 'authentication_failed' || category === 'oauth_org_not_allowed' || status === 401 || status === 403) return 'not_authenticated';
    if (category === 'rate_limit' || status === 429) return 'rate_limit';
    if (category === 'overloaded' || status === 529) return 'overloaded';
    if (category === 'invalid_request' || category === 'model_not_found' || status === 400 || status === 404) return 'invalid_request';
    if (status === 408 || status === 504) return 'network';
    return 'unknown';
  }

  private normalize(value: JsonObject): NormalizedPayload[] {
    switch (value.type) {
      case 'system':
        if (value.subtype === 'init' && typeof value.session_id === 'string') return [{ type: 'run_started', agentSessionId: value.session_id }];
        if (value.subtype === 'api_retry') return [{ type: 'retry', attempt: number(value.attempt), reason: this.errorReason(value.error, value.error_status) }];
        this.diagnostic('unknown_system', 'Неизвестное системное событие'); return [];
      case 'stream_event': return this.partial(object(value.event));
      case 'assistant': {
        this.assistantError = typeof value.error === 'string' ? this.errorReason(value.error) : undefined;
        const message = object(value.message);
        if (!message || typeof message.id !== 'string' || !Array.isArray(message.content)) {
          this.fail('protocol_incompatible', 'Некорректное сообщение assistant'); return [];
        }
        const events: NormalizedPayload[] = [];
        let snapshot = '';
        for (const raw of message.content) {
          const block = object(raw);
          if (block?.type === 'text' && typeof block.text === 'string') snapshot += block.text;
          if (block?.type === 'tool_use') events.push(...this.tool(block));
        }
        if (snapshot) events.push(...this.text(message.id, snapshot, 'snapshot'));
        events.push(...this.usageEvent(message.id, usage(message.usage)));
        return events;
      }
      case 'user': {
        const content = object(value.message)?.content;
        if (!Array.isArray(content)) return [];
        const events: NormalizedPayload[] = [];
        for (const raw of content) {
          const block = object(raw);
          if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string' && !this.finishedTools.has(block.tool_use_id)) {
            this.finishedTools.add(block.tool_use_id);
            this.stateBytes += Buffer.byteLength(block.tool_use_id);
            events.push({ type: 'tool_finished', toolCallId: block.tool_use_id, isError: block.is_error === true });
          }
        }
        return events;
      }
      case 'result': return this.terminal(value);
      case 'rate_limit_event': {
        const info = object(value.rate_limit_info);
        if (!info || typeof info.status !== 'string') { this.diagnostic('unknown_rate_limit', 'Неизвестный формат лимита'); return []; }
        const seconds = number(info.resetsAt);
        const resetAt = seconds !== undefined && seconds < 8.64e12 ? new Date(seconds * 1000).toISOString() : undefined;
        return [{ type: 'rate_limit', status: info.status, ...(resetAt ? { resetAt } : {}) }];
      }
      default:
        this.diagnostic('unknown_event', 'Неизвестное событие CLI'); return [];
    }
  }

  private partial(event: JsonObject | undefined): NormalizedPayload[] {
    if (!event) { this.fail('protocol_incompatible', 'Некорректное частичное событие'); return []; }
    switch (event.type) {
      case 'message_start': {
        const message = object(event.message);
        if (!message || typeof message.id !== 'string') { this.fail('protocol_incompatible', 'Нет ID сообщения'); return []; }
        this.activeMessage = message.id;
        return this.usageEvent(message.id, usage(message.usage));
      }
      case 'content_block_start': {
        const block = object(event.content_block);
        if (block?.type === 'tool_use') return this.tool(block);
        if (block?.type === 'text' && typeof block.text === 'string' && this.activeMessage) return this.text(this.activeMessage, block.text, 'delta');
        return [];
      }
      case 'content_block_delta': {
        const delta = object(event.delta);
        if (delta?.type === 'text_delta') {
          if (!this.activeMessage || typeof delta.text !== 'string') { this.fail('protocol_incompatible', 'Дельта без сообщения'); return []; }
          return this.text(this.activeMessage, delta.text, 'delta');
        }
        return [];
      }
      case 'message_delta': return this.activeMessage ? this.usageEvent(this.activeMessage, usage(event.usage)) : [];
      case 'message_stop': this.activeMessage = ''; return [];
      case 'content_block_stop': case 'ping': return [];
      default: this.diagnostic('unknown_partial', 'Неизвестное частичное событие'); return [];
    }
  }

  private terminal(value: JsonObject): NormalizedPayload[] {
    if (typeof value.subtype !== 'string' || typeof value.is_error !== 'boolean') {
      this.fail('protocol_incompatible', 'Повреждённый обязательный result'); return [];
    }
    const total = { ...usage(value.usage), costUsd: number(value.total_cost_usd), durationMs: number(value.duration_ms) };
    if (value.terminal_reason === 'aborted_streaming' || value.terminal_reason === 'aborted_tools') {
      this.result = { kind: 'interrupted' };
    } else if (value.subtype === 'success' && value.is_error === true) {
      const reason = value.api_error_status !== undefined ? this.errorReason(undefined, value.api_error_status) : this.assistantError ?? 'unknown';
      this.result = reason === 'rate_limit' ? { kind: 'limit', usage: total }
        : { kind: 'error', reason, detail: 'CLI сообщил об ошибке API' };
    } else if (value.subtype === 'success' && value.is_error === false && typeof value.result === 'string' && !this.assistantError
      && (value.terminal_reason === undefined || value.terminal_reason === null || value.terminal_reason === 'completed')) {
      this.result = { kind: 'success', text: value.result, usage: total };
    } else if (value.subtype === 'error_max_turns' && value.is_error) {
      this.result = { kind: 'max_turns', usage: total };
    } else if (value.subtype === 'error_max_budget_usd' && value.is_error) {
      this.result = { kind: 'limit', usage: total };
    } else if (value.is_error && ['error_during_execution', 'error_max_structured_output_retries'].includes(value.subtype)) {
      this.result = this.assistantError === 'rate_limit' ? { kind: 'limit', usage: total }
        : { kind: 'error', reason: this.assistantError ?? 'unknown', detail: 'CLI завершился ошибкой выполнения' };
    } else {
      this.fail('protocol_incompatible', 'Несогласованный или неизвестный result'); return [];
    }
    const events = this.usageSnapshot(total);
    if (Array.isArray(value.permission_denials)) {
      for (const raw of value.permission_denials) {
        const denial = object(raw);
        if (typeof denial?.tool_name === 'string') events.push({
          type: 'permission_denied', tool: denial.tool_name, inputPreview: '[вход скрыт]',
          reason: 'CLI отклонил разрешение', scope: 'unknown', source: 'unknown',
        });
      }
    }
    return events;
  }
}
