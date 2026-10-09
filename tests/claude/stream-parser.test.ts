import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ClaudeStreamParser } from '../../src/adapters/claude/parser.ts';
import type { ParserOptions } from '../../src/adapters/claude/parser.ts';
import type { NormalizedPayload } from '../../src/core/ports/agent.ts';
import { fragment } from '../helpers/claude/stand.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'claude');
const load = (name: string): Buffer => readFileSync(join(FIXTURES, name));
const SESSION = '11111111-1111-4111-8111-111111111111';

function parse(chunks: Uint8Array[], options?: ParserOptions) {
  const parser = new ClaudeStreamParser(options);
  const events: NormalizedPayload[] = [];
  for (const chunk of chunks) events.push(...parser.feed(chunk));
  events.push(...parser.end());
  return { parser, events };
}
const whole = (name: string, options?: ParserOptions) => parse([load(name)], options);
const textOf = (events: NormalizedPayload[]): string =>
  events.flatMap(e => (e.type === 'text' ? [e] : [])).reduce((acc, e) => (e.mode === 'delta' ? acc + e.text : e.text), '');
const types = (events: NormalizedPayload[]): string[] => events.map(e => e.type);

describe('0C парсер потока: нормализация событий', () => {
  it('простой успешный запуск: run_started, текст, usage, success', () => {
    const { parser, events } = whole('success-simple.jsonl');
    expect(events[0]).toEqual({ type: 'run_started', agentSessionId: SESSION });
    expect(textOf(events)).toBe('Привет, мир 🌍');
    expect(parser.error).toBeUndefined();
    expect(parser.result).toMatchObject({ kind: 'success', text: 'Привет, мир 🌍' });
  });

  it('delta + итоговый snapshot не удваивают текст', () => {
    const { parser, events } = whole('partial-deltas-then-snapshot.jsonl');
    expect(textOf(events)).toBe('Привет, мир 🌍');
    const textEvents = events.filter(e => e.type === 'text');
    expect(textEvents.every(e => e.type === 'text' && e.messageId === 'msg_1')).toBe(true);
    expect(parser.result?.kind).toBe('success');
  });

  it('usage публикуется снимками; повтор тех же значений в snapshot assistant не создаёт приращения', () => {
    const { events } = whole('partial-deltas-then-snapshot.jsonl');
    const usages = events.flatMap(e => (e.type === 'usage' ? [e] : []));
    expect(usages.every(u => u.mode === 'snapshot')).toBe(true);
    // Последний снимок равен итогу CLI (10 входных, 5 выходных), а не сумме дельт и snapshot.
    expect(usages.at(-1)?.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 });
    for (const u of usages) {
      expect(u.usage.inputTokens ?? 0).toBeLessThanOrEqual(10);
      expect(u.usage.outputTokens ?? 0).toBeLessThanOrEqual(5);
    }
    // Без дублирующихся подряд одинаковых снимков.
    const serialized = usages.map(u => JSON.stringify(u.usage));
    serialized.forEach((value, i) => { if (i > 0) expect(value).not.toBe(serialized[i - 1]); });
  });

  it('итоговый usage result не суммируется с usage сообщений', () => {
    const { events, parser } = whole('tool-use.jsonl');
    const last = events.filter(e => e.type === 'usage').at(-1);
    expect(last).toMatchObject({ usage: { inputTokens: 60, outputTokens: 20 } });
    expect(parser.result).toMatchObject({ kind: 'success', usage: { inputTokens: 60, outputTokens: 20 } });
  });

  it('инструмент: стабильный toolCallId, вход не попадает в события', () => {
    const { events } = whole('tool-use.jsonl');
    const started = events.find(e => e.type === 'tool_started');
    const finished = events.find(e => e.type === 'tool_finished');
    expect(started).toMatchObject({ toolCallId: 'toolu_1', tool: 'Read' });
    expect(finished).toMatchObject({ toolCallId: 'toolu_1', isError: false });
    const dump = JSON.stringify(events);
    expect(dump).not.toContain('SECRET-PATH');
    expect(dump).not.toContain('SECRET-CONTENT');
  });

  it('ошибка инструмента и permission_denials отражаются событиями', () => {
    const { events } = whole('tool-error-and-denial.jsonl');
    expect(events.find(e => e.type === 'tool_finished')).toMatchObject({ toolCallId: 'toolu_9', isError: true });
    const denied = events.find(e => e.type === 'permission_denied');
    expect(denied).toMatchObject({ tool: 'Bash' });
    expect(JSON.stringify(denied)).not.toContain('rm -rf');
  });

  it('rate_limit и retry нормализуются; время сброса не выдумывается', () => {
    const limit = whole('rate-limit.jsonl').events.find(e => e.type === 'rate_limit');
    expect(limit).toMatchObject({ status: 'allowed_warning' });
    expect(limit && limit.type === 'rate_limit' ? limit.resetAt : undefined).toBe(new Date(1790000000 * 1000).toISOString());
    expect(whole('retry.jsonl').events.find(e => e.type === 'retry')).toMatchObject({ attempt: 1 });
    const parser = new ClaudeStreamParser();
    const none = parser.feed(Buffer.from('{"type":"rate_limit_event","rate_limit_info":{"status":"rejected"}}\n'));
    expect(none[0]).toEqual({ type: 'rate_limit', status: 'rejected' });
  });

  it('результаты max_turns и error сопоставляются без превращения в success', () => {
    expect(whole('error-max-turns.jsonl').parser.result?.kind).toBe('max_turns');
    expect(whole('error-execution.jsonl').parser.result).toMatchObject({ kind: 'error' });
  });
});

describe('0C парсер потока: фрагментация', () => {
  const names = ['success-simple.jsonl', 'partial-deltas-then-snapshot.jsonl', 'tool-use.jsonl', 'tool-error-and-denial.jsonl', 'unknown-events.jsonl', 'result-without-lf.jsonl'];
  for (const name of names) {
    it(`${name}: результат не зависит от нарезки на чанки (в т.ч. посреди UTF-8 и JSON)`, () => {
      const expected = whole(name);
      for (let seed = 1; seed <= 40; seed++) {
        const got = parse(fragment(load(name), seed, 1 + (seed % 11)));
        expect(got.events, `seed=${seed}`).toEqual(expected.events);
        expect(got.parser.result, `seed=${seed}`).toEqual(expected.parser.result);
        expect(got.parser.error).toBeUndefined();
      }
    });
  }

  it('побайтовая подача многобайтных символов (кириллица, эмодзи) собирается без искажения', () => {
    const bytes = load('success-simple.jsonl');
    const single = Array.from(bytes, b => new Uint8Array([b]));
    const { events, parser } = parse(single);
    expect(textOf(events)).toBe('Привет, мир 🌍');
    expect(parser.result?.kind).toBe('success');
  });

  it('CRLF-окончания строк не ломают разбор', () => {
    const text = load('success-simple.jsonl').toString('utf8').replace(/\n/g, '\r\n');
    const { parser, events } = parse([Buffer.from(text)]);
    expect(parser.error).toBeUndefined();
    expect(textOf(events)).toBe('Привет, мир 🌍');
  });

  it('последняя строка без LF учитывается только после end()', () => {
    const parser = new ClaudeStreamParser();
    const data = load('result-without-lf.jsonl');
    parser.feed(data);
    expect(parser.result).toBeUndefined();
    parser.end();
    expect(parser.result?.kind).toBe('success');
  });
});

describe('0C парсер потока: повреждения не становятся success', () => {
  it('оборванный result без LF: нет success, есть ошибка протокола', () => {
    const { parser } = whole('truncated-result.jsonl');
    expect(parser.result).toBeUndefined();
    expect(parser.error?.reason).toBe('protocol_incompatible');
  });

  it('result без обязательного is_error — не success', () => {
    const { parser } = whole('result-malformed-fields.jsonl');
    expect(parser.result).toBeUndefined();
    expect(parser.error?.reason).toBe('protocol_incompatible');
  });

  it('повреждённая строка в середине потока фиксирует ошибку, поздний result не «лечит» её', () => {
    const { parser, events } = whole('corrupt-middle.jsonl');
    expect(parser.error?.reason).toBe('protocol_incompatible');
    expect(parser.result).toBeUndefined();
    expect(types(events)).toEqual(['run_started']);
  });

  it('отсутствие result: терминала нет (решение принимает адаптер)', () => {
    const { parser } = whole('no-result.jsonl');
    expect(parser.result).toBeUndefined();
  });

  it('событие после result — ошибка протокола, терминал не заменяется', () => {
    const { parser } = whole('events-after-result.jsonl');
    expect(parser.error?.reason).toBe('protocol_incompatible');
  });

  it('невалидный UTF-8 даёт ошибку протокола, а не подставленные символы', () => {
    const parser = new ClaudeStreamParser();
    parser.feed(Buffer.from([0x7b, 0xff, 0xfe, 0x0a]));
    parser.end();
    expect(parser.error?.reason).toBe('protocol_incompatible');
    expect(parser.result).toBeUndefined();
  });

  it('оборванный посреди символа UTF-8 в конце потока — ошибка', () => {
    const parser = new ClaudeStreamParser();
    parser.feed(Buffer.from([0x7b, 0xd0]));
    parser.end();
    expect(parser.error?.reason).toBe('protocol_incompatible');
  });

  it('другой session_id при заданном expectedSessionId отклоняется', () => {
    const { parser } = whole('other-session.jsonl', { expectedSessionId: SESSION });
    expect(parser.error?.reason).toBe('protocol_incompatible');
    expect(parser.result).toBeUndefined();
  });

  it('JSON не-объект и объект без type — ошибка протокола', () => {
    for (const line of ['[]\n', '42\n', '"x"\n', '{"a":1}\n', 'null\n']) {
      const parser = new ClaudeStreamParser();
      parser.feed(Buffer.from(line));
      expect(parser.error?.reason, line).toBe('protocol_incompatible');
    }
  });

  it('после ошибки новые данные игнорируются и не порождают события', () => {
    const parser = new ClaudeStreamParser();
    parser.feed(Buffer.from('{broken\n'));
    expect(parser.feed(load('success-simple.jsonl'))).toEqual([]);
    expect(parser.result).toBeUndefined();
  });
});

describe('0C парсер потока: result с признаками ошибки не становится success', () => {
  it('subtype=success при is_error=true и api_error_status 401 → ошибка авторизации', () => {
    const { parser } = whole('result-api-error-401.jsonl');
    expect(parser.result?.kind).not.toBe('success');
    expect(parser.result ?? parser.error).toMatchObject({ reason: 'not_authenticated' });
  });

  it('api_error_status 429 → лимит/rate_limit, не success', () => {
    const { parser } = whole('result-api-error-429.jsonl');
    expect(parser.result?.kind).not.toBe('success');
    const reasonOf = (): string | undefined => (parser.result && 'reason' in parser.result ? parser.result.reason : parser.error?.reason);
    expect(parser.result?.kind === 'limit' || reasonOf() === 'rate_limit').toBe(true);
  });

  it('api_error_status 529 → перегрузка', () => {
    const { parser } = whole('result-api-error-529.jsonl');
    expect(parser.result?.kind).not.toBe('success');
    expect(parser.result ?? parser.error).toMatchObject({ reason: 'overloaded' });
  });

  it('terminal_reason=aborted_streaming при is_error=false не даёт success', () => {
    const { parser } = whole('result-aborted-streaming.jsonl');
    expect(parser.result?.kind).not.toBe('success');
    expect(parser.result ?? parser.error).toBeDefined(); // решение принято явно, а не «ничего не произошло»
  });

  it('is_error=true при subtype=success без кода — не success', () => {
    const { parser } = whole('result-success-is-error-no-status.jsonl');
    expect(parser.result?.kind).not.toBe('success');
    expect(parser.result ?? parser.error).toBeDefined();
  });
});

describe('0C парсер потока: неизвестные события и лимиты', () => {
  it('неизвестные события не роняют поток и дают ограниченную диагностику без сырого содержимого', () => {
    const { parser, events } = whole('unknown-events.jsonl');
    expect(parser.error).toBeUndefined();
    expect(parser.result?.kind).toBe('success');
    expect(parser.diagnostics.length).toBeGreaterThan(0);
    const dump = JSON.stringify(parser.diagnostics);
    expect(dump).not.toContain('xxxxxxxxxx');
    expect(dump.length).toBeLessThan(4_096);
    expect(textOf(events)).toBe('ok');
  });

  it('объём диагностики ограничен maxDiagBytes при потоке из тысяч неизвестных событий', () => {
    const parser = new ClaudeStreamParser({ maxDiagBytes: 512 });
    const line = Buffer.from('{"type":"weird"}\n');
    for (let i = 0; i < 5_000; i++) parser.feed(line);
    const bytes = parser.diagnostics.reduce((n, d) => n + Buffer.byteLength(d.code + d.detail), 0);
    expect(bytes).toBeLessThanOrEqual(512);
    expect(parser.error).toBeUndefined();
  });

  it('строка длиннее maxLineBytes даёт output_limit без накопления памяти', () => {
    const parser = new ClaudeStreamParser({ maxLineBytes: 1_000 });
    const chunk = Buffer.alloc(400, 0x61);
    for (let i = 0; i < 100 && !parser.error; i++) parser.feed(chunk);
    expect(parser.error?.reason).toBe('output_limit');
    expect(parser.result).toBeUndefined();
  });

  it('строка ровно в пределах лимита проходит', () => {
    const line = '{"type":"future","pad":"' + 'a'.repeat(100) + '"}\n';
    const parser = new ClaudeStreamParser({ maxLineBytes: Buffer.byteLength(line) });
    parser.feed(Buffer.from(line));
    expect(parser.error).toBeUndefined();
  });

  it('число отслеживаемых сообщений и инструментов ограничено maxMessages', () => {
    const parser = new ClaudeStreamParser({ maxMessages: 10 });
    for (let i = 0; i < 100 && !parser.error; i++) {
      const message = { type: 'assistant', message: { id: `m${i}`, content: [{ type: 'text', text: 't' }], usage: { input_tokens: i + 1 } } };
      parser.feed(Buffer.from(`${JSON.stringify(message)}\n`));
    }
    expect(parser.error?.reason).toBe('output_limit');
  });

  it('суммарный размер накопленного текста ограничен maxStateBytes', () => {
    const parser = new ClaudeStreamParser({ maxStateBytes: 2_000 });
    const start = '{"type":"stream_event","event":{"type":"message_start","message":{"id":"m1"}}}\n';
    parser.feed(Buffer.from(start));
    const delta = Buffer.from(`${JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'я'.repeat(300) } } })}\n`);
    for (let i = 0; i < 100 && !parser.error; i++) parser.feed(delta);
    expect(parser.error?.reason).toBe('output_limit');
  });

  it('невалидные значения лимитов отклоняются', () => {
    expect(() => new ClaudeStreamParser({ maxLineBytes: 0 })).toThrow();
    expect(() => new ClaudeStreamParser({ maxDiagBytes: -1 })).toThrow();
  });
});
