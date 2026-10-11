import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { ClaudeStreamParser } from '../../src/adapters/claude/parser.ts';
import { collectProbeStdout } from '../helpers/claude/probe-output.ts';

function source(chunks: Buffer[]) {
  return {
    stdout: (async function* () { for (const chunk of chunks) yield chunk; })(),
    kill: vi.fn(async () => {}),
  };
}

describe('0C артефакты живой пробы (без Claude)', () => {
  it('сохраняет именно тот chunk, на котором сломался разбор, и останавливает процесс', async () => {
    const first = Buffer.from('{"type":"system","subtype":"init","session_id":"test"}\n');
    const malformed = Buffer.from('{"type":"result", BROKEN}\n');
    const run = source([first, malformed, Buffer.from('не должно читаться')]);
    const parser = new ClaudeStreamParser();
    const output = await collectProbeStdout(run, parser, 1024);
    expect(parser.error?.reason).toBe('protocol_incompatible');
    expect(output.rawText).toBe(Buffer.concat([first, malformed]).toString('utf8'));
    expect(output.overBudget).toBe(false);
    expect(run.kill).toHaveBeenCalledOnce();
  });

  it('не теряет ошибочную последнюю строку без LF', async () => {
    const raw = Buffer.from('{"type":"result", BROKEN}');
    const parser = new ClaudeStreamParser();
    const output = await collectProbeStdout(source([raw]), parser, 1024);
    expect(parser.error?.reason).toBe('protocol_incompatible');
    expect(output.rawText).toBe(raw.toString('utf8'));
  });

  it('не накапливает chunk сверх общего byte-бюджета и останавливает процесс', async () => {
    const run = source([Buffer.from('   '), Buffer.from('ещё')]);
    const output = await collectProbeStdout(run, new ClaudeStreamParser(), 4);
    expect(output.overBudget).toBe(true);
    expect(output.rawText).toBe('   ');
    expect(Buffer.byteLength(output.rawText)).toBeLessThanOrEqual(4);
    expect(run.kill).toHaveBeenCalledOnce();
  });

  it('сохраняет UTF-8 и result при побайтовом потоке без конечного LF', async () => {
    const raw = readFileSync(new URL('../fixtures/claude/success-simple.jsonl', import.meta.url), 'utf8').trimEnd();
    const bytes = Buffer.from(raw);
    const run = source(Array.from(bytes, byte => Buffer.from([byte])));
    const parser = new ClaudeStreamParser();
    const output = await collectProbeStdout(run, parser, bytes.length);
    expect(output.rawText).toBe(raw);
    expect(output.overBudget).toBe(false);
    expect(parser.result?.kind).toBe('success');
    expect(parser.error).toBeUndefined();
    expect(output.payloads.some(event => event.type === 'text')).toBe(true);
    expect(run.kill).not.toHaveBeenCalled();
  });
});
