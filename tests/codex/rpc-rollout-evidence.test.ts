import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { inspectOwnRpcRollout } from '../helpers/codex/rpc-rollout-evidence.ts';
import { inspectOwnRollout } from '../helpers/codex/own-rollout-evidence.ts';
import type { JsonObject } from '../../src/adapters/codex/rpc.ts';

const evidence = JSON.parse(readFileSync(new URL('../fixtures/codex/observed-0.163.0-app-server-r01.json', import.meta.url), 'utf8'));
const m4 = evidence.m4;
const inspect = (rows: JsonObject[] = m4.rolloutProjection, turn = m4.turnId) => inspectOwnRpcRollout(rows.map(row => JSON.stringify(row)).join('\n'), m4.threadId, turn, m4.cwd, m4.home, '');
const copy = (): JsonObject[] => structuredClone(m4.rolloutProjection);
const payload = (rows: JsonObject[], index: number) => rows.filter(row => row.type === 'turn_context')[index]!.payload as JsonObject;

describe('два реальных снимка политики app-server', () => {
  it('сохраняет первоначальный отказ и независимо подтверждает оба снимка', () => {
    expect(evidence.report.status).toBe('failed');
    expect(m4.originalReview.runtime.policy).toBe(false);
    const text = m4.rolloutProjection.map((row: unknown) => JSON.stringify(row)).join('\n');
    expect(inspectOwnRollout(text, m4.threadId, m4.cwd, m4.home, '').policy).toBe(false);
    expect(inspect()).toMatchObject({ ownership: true, policy: true, inventory: 'confirmed', unexpectedSkills: false });
  });
  it.each([0, 1])('не скрывает ослабление снимка %s', index => {
    const rows = copy(); payload(rows, index).approval_policy = 'on-request';
    expect(inspect(rows).policy).toBe(false);
  });
  it('отклоняет одинаково повреждённые политики', () => {
    const rows = copy(); for (const index of [0, 1]) payload(rows, index).permission_profile = { type: 'unrestricted' };
    expect(inspect(rows).policy).toBe(false);
  });
  it('отклоняет лишний снимок, неверный порядок и отсутствие снимка', () => {
    const rows = copy(); expect(inspect([...rows, rows[1]!]).policy).toBe(false);
    [rows[1], rows[2]] = [rows[2]!, rows[1]!]; expect(inspect(rows).policy).toBe(false);
    expect(inspect(copy().filter((_, i) => i !== 1)).policy).toBe(false);
  });
  it('связывает turn_id и root_turn_id с настоящим RPC', () => {
    expect(inspect(copy(), '019a0000-0000-7000-8000-000000000001').policy).toBe(false);
    const rows = copy(); payload(rows, 1).root_turn_id = 'foreign'; expect(inspect(rows).policy).toBe(false);
  });
});
