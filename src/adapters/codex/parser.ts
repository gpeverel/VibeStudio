import { TextDecoder } from 'node:util';
import type { AgentDiagnostic, AgentErrorReason, AgentRunResult, AgentUsage, NormalizedPayload } from '../../core/ports/agent.ts';
import { isCodexThreadId } from './profile.ts';

export const DEFAULT_CODEX_PARSER_LIMITS = {
  maxLineBytes: 1_048_576,
  maxDiagBytes: 16_384,
  maxStateBytes: 2_097_152,
  maxMessages: 1024,
};
export interface CodexParserOptions {
  maxLineBytes?: number;
  maxDiagBytes?: number;
  maxStateBytes?: number;
  maxMessages?: number;
  /** Resume: thread.started обязан вернуть именно этот ID, иначе история не продолжена. */
  expectedThreadId?: string;
  /** Типы item, недопустимые для профиля (например, выполнение команд при shell_forbidden). */
  forbiddenItems?: readonly string[];
  /** Новый профиль не может молча принять неизвестный item как безопасный инструмент.
   * Это обнаружение по событию, не предотвращение эффектов; legacy default сохраняется. */
  rejectUnknownItems?: boolean;
}
type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** Типы item, которые Codex описывает как вызов инструмента (codex-rs/exec/src/exec_events.rs, main). */
const TOOL_ITEMS = ['command_execution', 'file_change', 'mcp_tool_call', 'collab_tool_call', 'web_search'] as const;
const IGNORED_ITEMS = ['reasoning', 'todo_list'];
const KNOWN_EVENTS = ['thread.started', 'turn.started', 'turn.completed', 'turn.failed', 'item.started', 'item.updated', 'item.completed', 'error'];

/** Классификация по тексту сообщения CLI. Сам текст не сохраняется: он может содержать секреты. */
function classify(message: unknown): AgentErrorReason {
  const text = typeof message === 'string' ? message.toLowerCase() : '';
  if (/unauthori[sz]ed|\b401\b|not logged in|log ?in again|invalid api key|authentication|token.{0,24}(expired|invalid)/.test(text)) return 'not_authenticated';
  if (/rate.?limit|\b429\b|usage limit|too many requests|quota/.test(text)) return 'rate_limit';
  if (/overloaded|\b529\b|\b503\b|at capacity/.test(text)) return 'overloaded';
  if (/network|connection|timed? ?out|\bdns\b|econn|offline|\b504\b|\b408\b/.test(text)) return 'network';
  if (/invalid request|bad request|\b400\b|model.{0,40}(not found|not supported|does not exist)/.test(text)) return 'invalid_request';
  return 'unknown';
}
const errorResult = (reason: AgentErrorReason, detail: string): AgentRunResult =>
  reason === 'rate_limit' ? { kind: 'limit' } : { kind: 'error', reason, detail };

/** JSONL `codex exec --json` без процесса. result — кандидат, не доказательство success. */
export class CodexStreamParser {
  readonly diagnostics: AgentDiagnostic[] = [];
  result: AgentRunResult | undefined;
  error: { reason: AgentErrorReason; detail: string } | undefined;
  /** CLI-ID диалога из thread.started; не ID приложения и не ID хода. */
  threadId: string | undefined;
  private decoder = new TextDecoder('utf-8', { fatal: true });
  private line = '';
  private lineBytes = 0;
  private diagBytes = 0;
  private stateBytes = 0;
  private ended = false;
  private texts = new Map<string, string>();
  private finalText: string | undefined;
  private tools = new Set<string>();
  private finishedTools = new Set<string>();
  private lastError: AgentErrorReason | undefined;
  private readonly limits: typeof DEFAULT_CODEX_PARSER_LIMITS;
  private readonly expectedThreadId: string | undefined;
  private readonly forbidden: ReadonlySet<string>;
  private readonly rejectUnknownItems: boolean;

  constructor(options: CodexParserOptions = {}) {
    this.expectedThreadId = options.expectedThreadId;
    this.forbidden = new Set(options.forbiddenItems ?? []);
    this.rejectUnknownItems = options.rejectUnknownItems === true;
    this.limits = { ...DEFAULT_CODEX_PARSER_LIMITS };
    for (const name of Object.keys(this.limits) as (keyof typeof DEFAULT_CODEX_PARSER_LIMITS)[]) {
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
    const events = this.line.trim() ? this.consumeLine() : [];
    // Поток закончился без terminal turn.*: ошибка CLI сохраняет свою причину, иначе это missing_result.
    if (!this.error && !this.result && this.lastError) this.result = errorResult(this.lastError, 'CLI сообщил об ошибке до завершения хода');
    return this.error ? [] : events;
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
    if (this.result && KNOWN_EVENTS.includes(value.type)) {
      this.fail('protocol_incompatible', 'Событие после терминального результата'); return [];
    }
    const events = this.normalize(value, value.type);
    if (this.error) return [];
    if (this.texts.size + this.tools.size + this.finishedTools.size > this.limits.maxMessages || this.stateBytes > this.limits.maxStateBytes) {
      this.fail('output_limit', 'Превышен бюджет состояния парсера'); return [];
    }
    return events;
  }

  private normalize(value: JsonObject, type: string): NormalizedPayload[] {
    switch (type) {
      case 'thread.started': return this.threadStarted(value);
      case 'turn.started':
        if (!this.threadId) this.fail('protocol_incompatible', 'Событие до thread.started');
        return [];
      case 'turn.completed': return this.turnCompleted(value);
      case 'turn.failed': return this.turnFailed(value);
      case 'item.started': case 'item.updated': case 'item.completed': return this.item(object(value.item), type === 'item.completed');
      case 'error': {
        const message = object(value)?.message;
        if (typeof message !== 'string') { this.fail('protocol_incompatible', 'Повреждённое событие error'); return []; }
        this.lastError = classify(message);
        this.diagnostic('cli_error', `CLI сообщил об ошибке (${this.lastError}); текст скрыт`);
        return [];
      }
      default:
        this.diagnostic('unknown_event', 'Неизвестное событие CLI'); return [];
    }
  }

  private threadStarted(value: JsonObject): NormalizedPayload[] {
    if (this.threadId) { this.fail('protocol_incompatible', 'Повторный thread.started'); return []; }
    if (!isCodexThreadId(value.thread_id)) { this.fail('protocol_incompatible', 'В thread.started отсутствует корректный идентификатор диалога'); return []; }
    if (this.expectedThreadId !== undefined && value.thread_id.toLowerCase() !== this.expectedThreadId.toLowerCase()) {
      this.fail('protocol_incompatible', 'CLI вернул другой идентификатор диалога: история запрошенного диалога не продолжена'); return [];
    }
    this.threadId = value.thread_id;
    return [{ type: 'run_started', agentSessionId: value.thread_id }];
  }

  private text(id: string, text: string): NormalizedPayload[] {
    if (!this.texts.has(id)) this.stateBytes += Buffer.byteLength(id);
    const previous = this.texts.get(id) ?? '';
    this.stateBytes += Buffer.byteLength(text) - Buffer.byteLength(previous);
    this.texts.set(id, text);
    this.finalText = text;
    if (previous === text) return [];
    if (text.startsWith(previous)) return [{ type: 'text', messageId: id, mode: 'delta', text: text.slice(previous.length) }];
    return [{ type: 'text', messageId: id, mode: 'snapshot', text }];
  }

  private item(item: JsonObject | undefined, completed: boolean): NormalizedPayload[] {
    if (!item || typeof item.id !== 'string' || !item.id.length || typeof item.type !== 'string') {
      this.fail('protocol_incompatible', 'Повреждённый элемент item'); return [];
    }
    if (!this.threadId) { this.fail('protocol_incompatible', 'Событие до thread.started'); return []; }
    if (this.forbidden.has(item.type)) {
      this.fail('runtime_inventory_mismatch', `Профиль не допускает элемент ${(TOOL_ITEMS as readonly string[]).includes(item.type) ? item.type : 'недопустимого типа'}`); return [];
    }
    if (item.type === 'agent_message') {
      if (typeof item.text !== 'string') { this.fail('protocol_incompatible', 'Повреждённое сообщение agent_message'); return []; }
      return this.text(item.id, item.text);
    }
    if ((TOOL_ITEMS as readonly string[]).includes(item.type)) return this.tool(item, item.id, item.type, completed);
    if (IGNORED_ITEMS.includes(item.type)) return [];
    if (item.type === 'error') { this.diagnostic('cli_error_item', 'CLI сообщил об ошибке элемента; текст скрыт'); return []; }
    if (this.rejectUnknownItems) {
      this.fail('runtime_inventory_unknown', 'Неизвестный тип элемента CLI: политика профиля не подтверждена'); return [];
    }
    this.diagnostic('unknown_item', 'Неизвестный тип элемента CLI');
    return [];
  }

  private tool(item: JsonObject, id: string, tool: string, completed: boolean): NormalizedPayload[] {
    const events: NormalizedPayload[] = [];
    if (!this.tools.has(id)) {
      this.tools.add(id);
      this.stateBytes += Buffer.byteLength(id + tool);
      // Вход (команда, аргументы, вывод) не сохраняется: он может содержать секреты.
      events.push({ type: 'tool_started', toolCallId: id, tool, inputPreview: '[вход скрыт]' });
    }
    if (completed && !this.finishedTools.has(id)) {
      this.finishedTools.add(id);
      this.stateBytes += Buffer.byteLength(id);
      const status = typeof item.status === 'string' ? item.status : undefined;
      const exitFailed = tool === 'command_execution' && typeof item.exit_code === 'number' && item.exit_code !== 0;
      const isError = status === 'failed' || status === 'declined' || exitFailed || (tool === 'mcp_tool_call' && object(item.error) !== undefined);
      events.push({ type: 'tool_finished', toolCallId: id, isError });
      if (tool === 'command_execution' && status === 'declined') {
        events.push({ type: 'permission_denied', tool, inputPreview: '[вход скрыт]', reason: 'CLI отклонил выполнение', scope: 'unknown', source: 'unknown' });
      }
    }
    return events;
  }

  private turnCompleted(value: JsonObject): NormalizedPayload[] {
    const usage = object(value.usage);
    const input = count(usage?.input_tokens);
    const output = count(usage?.output_tokens);
    const cached = count(usage?.cached_input_tokens);
    const written = usage?.cache_write_input_tokens === undefined ? undefined : count(usage.cache_write_input_tokens);
    if (input === undefined || output === undefined || cached === undefined
      || (usage?.cache_write_input_tokens !== undefined && written === undefined)
      || (usage?.reasoning_output_tokens !== undefined && count(usage.reasoning_output_tokens) === undefined)) {
      this.fail('protocol_incompatible', 'Повреждённый обязательный turn.completed'); return [];
    }
    if (!this.threadId) { this.fail('protocol_incompatible', 'turn.completed до thread.started'); return []; }
    // Единственный источник usage; reasoning_output_tokens не имеет поля AgentUsage и не суммируется.
    // inputTokens передаётся как сообщено CLI и может включать cacheReadTokens: не складывать.
    const total = (): AgentUsage => ({ inputTokens: input, outputTokens: output, cacheReadTokens: cached, ...(written !== undefined ? { cacheCreationTokens: written } : {}) });
    // Событие и результат не делят объект: мутация одного не меняет другое.
    this.result = { kind: 'success', ...(this.finalText !== undefined ? { text: this.finalText } : {}), usage: total() };
    return [{ type: 'usage', mode: 'snapshot', usage: total() }];
  }

  private turnFailed(value: JsonObject): NormalizedPayload[] {
    const failure = object(value.error);
    if (!failure || typeof failure.message !== 'string') { this.fail('protocol_incompatible', 'Повреждённый обязательный turn.failed'); return []; }
    this.result = errorResult(classify(failure.message), 'CLI сообщил об ошибке хода');
    return [];
  }
}
