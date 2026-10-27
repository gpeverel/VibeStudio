import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CodexStreamParser } from '../../src/adapters/codex/parser.ts';
import type { NormalizedPayload } from '../../src/shared/agent.ts';
import { fragments } from '../helpers/codex/stand.ts';

// Все входы synthetic; тесты не являются свидетельствами реальной CLI.
const fixture = (name: string) => readFileSync(new URL(`../fixtures/codex/synthetic-${name}.jsonl`, import.meta.url));
const THREAD = '019a0000-0000-7000-8000-000000000001';
const started = { type: 'thread.started', thread_id: THREAD };
const completed = { type: 'turn.completed', usage: { input_tokens: 20, cached_input_tokens: 7, output_tokens: 5 } };
const jsonl = (...events: unknown[]) => Buffer.from(events.map(event => JSON.stringify(event)).join('\n') + '\n');
function parse(chunks: Uint8Array[]) {
  const parser = new CodexStreamParser();
  const events: NormalizedPayload[] = [];
  for (const chunk of chunks) events.push(...parser.feed(chunk));
  events.push(...parser.end());
  return { parser, events };
}
function rendered(events: NormalizedPayload[]): string {
  const messages = new Map<string, string>();
  for (const event of events) if (event.type === 'text') {
    messages.set(event.messageId, event.mode === 'delta' ? (messages.get(event.messageId) ?? '') + event.text : event.text);
  }
  return [...messages.values()].join('\n');
}
function expectProtocolError(bytes: Uint8Array) {
  const { parser } = parse([bytes]);
  expect(parser.error?.reason ?? (parser.result?.kind === 'error' ? parser.result.reason : undefined)).toBe('protocol_incompatible');
  expect(parser.result?.kind).not.toBe('success');
}

describe('Codex: синтетический JSONL, собственные события и идентификаторы', () => {
  it('ID приходит из thread.started, usage абсолютный, доллары не выдуманы', () => {
    const { parser, events } = parse([fixture('success')]);
    expect(parser.error).toBeUndefined();
    expect(events[0]).toEqual({ type: 'run_started', agentSessionId: THREAD });
    expect(rendered(events)).toBe('Привет, мир 🌍');
    expect(parser.result).toMatchObject({ kind: 'success', text: 'Привет, мир 🌍', usage: { inputTokens: 20, outputTokens: 5, cacheReadTokens: 7 } });
    const usage = events.filter(e => e.type === 'usage');
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ mode: 'snapshot', usage: { inputTokens: 20, outputTokens: 5, cacheReadTokens: 7 } });
    expect(usage[0]?.usage.costUsd).toBeUndefined();
    expect(events.some(e => e.type === 'run_finished')).toBe(false); // Только адаптер знает exit/EOF.
  });

  for (const name of ['success', 'updates', 'tools']) {
    it(`${name}: любые байтовые границы дают тот же результат`, () => {
      const bytes = fixture(name);
      const expected = parse([bytes]);
      expect(expected.parser.error).toBeUndefined();
      for (const size of [1, 2, 3, 7, 13, 31, 127]) {
        const actual = parse(fragments(bytes, size));
        expect(actual.events, `chunk=${size}`).toEqual(expected.events);
        expect(actual.parser.result).toEqual(expected.parser.result);
        expect(actual.parser.error).toBeUndefined();
      }
    });
  }

  it('started/updated/completed и повтор завершённого item не удваивают текст', () => {
    const { parser, events } = parse([fixture('updates')]);
    expect(parser.error).toBeUndefined();
    expect(rendered(events)).toBe('Привет, мир 🌍');
    expect(parser.result).toMatchObject({ kind: 'success', text: 'Привет, мир 🌍' });
    expect(events.filter(e => e.type === 'usage')).toHaveLength(1);
  });

  it('разные сообщения сохраняют свои item ID', () => {
    const { events } = parse([jsonl(started,
      { type: 'item.completed', item: { id: 'one', type: 'agent_message', text: 'Первое' } },
      { type: 'item.completed', item: { id: 'two', type: 'agent_message', text: 'Второе' } }, completed)]);
    expect(rendered(events)).toBe('Первое\nВторое');
    expect(new Set(events.filter(e => e.type === 'text').map(e => e.messageId)).size).toBe(2);
  });

  it('ошибка команды не выдаётся за permission denial, сырой ввод/вывод скрыты', () => {
    const { events, parser } = parse([fixture('tools')]);
    expect(parser.error).toBeUndefined();
    const begin = events.find(e => e.type === 'tool_started');
    expect(begin).toMatchObject({ toolCallId: 'item_1', tool: 'command_execution' });
    expect(events.find(e => e.type === 'tool_finished')).toMatchObject({ toolCallId: 'item_1', isError: true });
    expect(events.some(e => e.type === 'permission_denied')).toBe(false);
    expect(JSON.stringify({ events, diagnostics: parser.diagnostics })).not.toContain('SECRET-');
  });

  it('unknown event безопасно диагностируется, не нарушая следующий известный поток', () => {
    const unknown = jsonl({ type: 'future.synthetic', payload: 'SECRET-UNKNOWN' });
    const { parser, events } = parse([unknown, fixture('success')]);
    expect(parser.error).toBeUndefined();
    expect(parser.result?.kind).toBe('success');
    expect(parser.diagnostics.length).toBeGreaterThan(0);
    expect(JSON.stringify(parser.diagnostics)).not.toContain('SECRET-UNKNOWN');
    expect(rendered(events)).toBe('Привет, мир 🌍');
  });

  it('JSONL без финального LF и с CRLF', () => {
    const bytes = fixture('success').toString();
    for (const value of [bytes.trimEnd(), bytes.replaceAll('\n', '\r\n')]) {
      const result = parse([Buffer.from(value)]);
      expect(result.parser.error).toBeUndefined();
      expect(result.parser.result?.kind).toBe('success');
    }
  });

  it('turn.failed не становится success и не раскрывает сырой текст ошибки', () => {
    const { parser } = parse([jsonl(started, { type: 'turn.failed', error: { message: 'SECRET-FAILURE' } })]);
    expect(parser.result?.kind).toBe('error');
    expect(JSON.stringify({ result: parser.result, diagnostics: parser.diagnostics })).not.toContain('SECRET-FAILURE');
  });

  it.each([
    ['rate limit 429 SECRET', { kind: 'limit' }],
    ['unauthorized SECRET', { kind: 'error', reason: 'not_authenticated' }],
  ])('turn.failed классифицируется без сырого сообщения: %s', (message, expected) => {
    const { parser } = parse([jsonl(started, { type: 'turn.failed', error: { message } })]);
    expect(parser.error).toBeUndefined();
    expect(parser.result).toMatchObject(expected);
    expect(JSON.stringify(parser.result)).not.toContain('SECRET');
  });

  it('error без terminal сохраняет классификацию при EOF', () => {
    const parser = new CodexStreamParser();
    parser.feed(jsonl(started, { type: 'error', message: 'unauthorized SECRET' }));
    expect(parser.result).toBeUndefined();
    parser.end();
    expect(parser.error).toBeUndefined();
    expect(parser.result).toMatchObject({ kind: 'error', reason: 'not_authenticated' });
    expect(JSON.stringify({ result: parser.result, diagnostics: parser.diagnostics })).not.toContain('SECRET');
  });

  it('промежуточный error допускает последующий terminal success', () => {
    const { parser } = parse([jsonl(started, { type: 'error', message: 'connection retry SECRET' }, completed)]);
    expect(parser.error).toBeUndefined();
    expect(parser.result?.kind).toBe('success');
    expect(JSON.stringify(parser.diagnostics)).not.toContain('SECRET');
  });

  it('error после terminal является нарушением протокола', () => {
    const { parser } = parse([jsonl(started, completed, { type: 'error', message: 'late SECRET' })]);
    expect(parser.error?.reason).toBe('protocol_incompatible');
  });

  it.each(['item.started', 'item.updated', 'item.completed'])('%s до thread.started запрещён', type => {
    expectProtocolError(jsonl({ type, item: { id: 'msg', type: 'agent_message', text: 'premature' } }, started, completed));
  });

  it.each(['command_execution', 'file_change', 'mcp_tool_call', 'collab_tool_call', 'web_search'])('голый parser применяет forbiddenItems: %s', type => {
    const parser = new CodexStreamParser({ forbiddenItems: [type] });
    const events = parser.feed(jsonl(started, { type: 'item.started', item: { id: 'tool', type } }, completed));
    parser.end();
    expect(parser.error?.reason).toBe('runtime_inventory_mismatch');
    expect(parser.result?.kind).not.toBe('success');
    expect(events.some(event => event.type === 'tool_started')).toBe(false);
  });

  it('без terminal нет кандидата success', () => {
    const { parser } = parse([jsonl(started, { type: 'turn.started' })]);
    expect(parser.result?.kind).not.toBe('success');
  });

  it('success без CLI-ID запрещён', () => expectProtocolError(jsonl(completed)));

  it.each([
    { type: 'thread.started' }, { type: 'thread.started', thread_id: '' },
    { type: 'thread.started', thread_id: 42 },
  ])('повреждённый обязательный thread.started: %j', event => expectProtocolError(jsonl(event, completed)));

  it.each([
    { type: 'turn.completed' }, { type: 'turn.completed', usage: null },
    { type: 'turn.completed', usage: 'invalid' },
    { type: 'turn.completed', usage: { input_tokens: -1, cached_input_tokens: 0, output_tokens: 1 } },
    { type: 'turn.completed', usage: { input_tokens: '20', cached_input_tokens: 0, output_tokens: 1 } },
    { type: 'turn.completed', usage: { input_tokens: 20, cached_input_tokens: 0, output_tokens: null } },
  ])('повреждённый обязательный terminal: %j', event => expectProtocolError(jsonl(started, event)));

  it('другой thread.started внутри одного хода отклоняется', () => {
    expectProtocolError(jsonl(started, { ...started, thread_id: '019a0000-0000-7000-8000-000000000002' }, completed));
  });

  it('битый JSON посреди потока не скрывается поздним success', () => {
    expectProtocolError(Buffer.concat([jsonl(started), Buffer.from('{"type":"item.completed",BROKEN}\n'), jsonl(completed)]));
  });

  it('оборванный обязательный JSON не принимается за результат', () => {
    expectProtocolError(Buffer.concat([jsonl(started), Buffer.from('{"type":"turn.completed",')]));
  });

  it('невалидный UTF-8 отклоняется, а не заменяется символом', () => {
    expectProtocolError(Buffer.concat([jsonl(started), Buffer.from([0xc3, 0x28, 0x0a]), jsonl(completed)]));
  });

  it('повтор end безопасен и не повторяет события', () => {
    const parser = new CodexStreamParser();
    parser.feed(fixture('success'));
    parser.end();
    expect(parser.end()).toEqual([]);
    expect(parser.feed(jsonl({ type: 'future.late' }))).toEqual([]);
  });

  it('expectedThreadId проверяет resume без навязывания Claude UUIDv4', () => {
    const parser = new CodexStreamParser({ expectedThreadId: '019a0000-0000-7000-8000-000000000002' });
    parser.feed(fixture('success')); parser.end();
    expect(parser.error?.reason).toBe('protocol_incompatible');
    expect(parser.result?.kind).not.toBe('success');
  });

  it('лимит строки применяется к байтам до появления LF', () => {
    const parser = new CodexStreamParser({ maxLineBytes: 64 });
    parser.feed(Buffer.from('я'.repeat(33)));
    expect(parser.error?.reason).toBe('output_limit');
  });

  it('лимит количества item ограничивает состояние даже для коротких сообщений', () => {
    const parser = new CodexStreamParser({ maxMessages: 2 });
    parser.feed(jsonl(started));
    for (let i = 0; i < 3; i++) parser.feed(jsonl({ type: 'item.completed', item: { id: `msg_${i}`, type: 'agent_message', text: 'x' } }));
    expect(parser.error?.reason).toBe('output_limit');
  });

  it('суммарное состояние сообщений ограничено независимо от длины строки', () => {
    const parser = new CodexStreamParser({ maxStateBytes: 64, maxLineBytes: 1_024 });
    parser.feed(jsonl(started));
    parser.feed(jsonl({ type: 'item.completed', item: { id: 'msg_1', type: 'agent_message', text: 'x'.repeat(65) } }));
    expect(parser.error?.reason).toBe('output_limit');
  });

  it('тысячи unknown events не раздувают диагностику и не раскрывают payload', () => {
    const parser = new CodexStreamParser({ maxDiagBytes: 512 });
    for (let i = 0; i < 1_000; i++) parser.feed(jsonl({ type: 'unknown.synthetic', value: 'SECRET-UNKNOWN' }));
    expect(parser.diagnostics.reduce((n, d) => n + Buffer.byteLength(d.code + d.detail), 0)).toBeLessThanOrEqual(512);
    expect(parser.diagnostics.length).toBeGreaterThan(0);
    expect(JSON.stringify(parser.diagnostics)).not.toContain('SECRET-UNKNOWN');
  });

  it.each([0, -1, Infinity, NaN, 1.5])('невалидный лимит %s отвергается', maxLineBytes => {
    expect(() => new CodexStreamParser({ maxLineBytes })).toThrow();
  });

  it('два terminal не удваивают usage и не принимаются молча', () => {
    const result = parse([fixture('success'), jsonl(completed)]);
    expect(result.parser.error?.reason).toBe('protocol_incompatible');
    expect(result.events.filter(e => e.type === 'usage')).toHaveLength(1);
  });
});
