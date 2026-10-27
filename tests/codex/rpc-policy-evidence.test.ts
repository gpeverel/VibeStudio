import { describe, expect, it } from 'vitest';
import { reviewRpcPolicy } from '../helpers/codex/rpc-policy-evidence.ts';
import type { OwnRolloutReview } from '../helpers/codex/own-rollout-evidence.ts';

const runtime: OwnRolloutReview = { ownership: true, policy: true, inventory: 'confirmed',
  toolNames: ['exec_command', 'apply_patch'], unexpectedSkills: false };
const allowed = { attempted: true, state: 'allowed', code: 'NONE', matched: true };
const denied = { attempted: true, state: 'denied', code: 'EPERM', matched: false };
const output = { schemaVersion: 1, control: allowed, outside: denied, symlink: denied, writeInside: denied, writeOutside: denied };
const command = (text: string, aggregatedOutput: string) => ({ method: 'item/completed', params: {
  threadId: 'owned', turnId: 'turn', item: { type: 'commandExecution', id: text, command: text, exitCode: 0, aggregatedOutput },
} });
const rows = () => [command('/bin/cat -- CONTROL.txt', 'marker\n'), command('./fs-probe', JSON.stringify(output))];
const review = (value = rows(), current = runtime, controls = true) => reviewRpcPolicy(value, 'owned', 'marker', controls, current);

describe('независимое подтверждение файловой политики RPC', () => {
  it('принимает результаты двух точных команд и отдельную runtime-проверку', () => {
    expect(Object.values(review()).every(value => value === true)).toBe(true);
  });
  it('не принимает пересказ модели вместо результата команды', () => {
    expect(review([])).toMatchObject({ allowedRead: false, filePolicy: false });
  });
  it.each(['/bin/cat -- CONTROL.txt; echo marker', 'echo marker', 'cat CONTROL.txt'])('отклоняет подмену команды: %s', text => {
    const value = rows(); value[0]!.params.item.command = text;
    expect(review(value).allowedRead).toBe(false);
  });
  it('отклоняет чужую историю и повтор результата', () => {
    const value = rows(); value[0]!.params.threadId = 'foreign';
    expect(review(value).allowedRead).toBe(false);
    expect(review([...rows(), rows()[0]!]).allowedRead).toBe(false);
  });
  it.each(['outside', 'symlink', 'writeInside', 'writeOutside'] as const)('не скрывает разрешённую запрещённую операцию %s', key => {
    const value = rows(); value[1]!.params.item.aggregatedOutput = JSON.stringify({ ...output, [key]: allowed });
    expect(review(value).filePolicy).toBe(false);
  });
  it('не подтверждает политику по отсутствующим маркерам без runtime inventory', () => {
    expect(review(rows(), { ...runtime, inventory: 'unconfirmed' }).extensionPolicy).toBe(false);
    expect(review(rows(), { ...runtime, toolNames: [...runtime.toolNames, 'unknown_tool'] }).extensionPolicy).toBe(false);
    expect(review(rows(), { ...runtime, unexpectedSkills: true }).extensionPolicy).toBe(false);
  });
  it('сохраняет отрицательные ownership, effective policy и контроль файлов', () => {
    expect(review(rows(), { ...runtime, ownership: false }).effectivePolicy).toBe(false);
    expect(review(rows(), { ...runtime, policy: false }).effectivePolicy).toBe(false);
    expect(review(rows(), runtime, false).controls).toBe(false);
  });
});
