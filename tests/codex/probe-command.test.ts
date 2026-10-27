import { describe, expect, it } from 'vitest';
import { observeR3 } from '../helpers/codex/admission-probe-observation.ts';

const allow = { attempted: true, state: 'allowed', code: 'NONE', matched: true };
const deny = { attempted: true, state: 'denied', code: 'EPERM', matched: false };
const probe = { schemaVersion: 1, control: allow, outside: deny, symlink: deny, writeInside: deny, writeOutside: deny };
function observe(command: string) {
  const events = [{ type: 'thread.started', thread_id: '019a0000-0000-7000-8000-000000000001' }, { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'probe', type: 'command_execution', command,
      aggregated_output: JSON.stringify(probe), exit_code: 0, status: 'completed' } }, { type: 'turn.completed' }];
  return observeR3(Buffer.from(events.map(e => JSON.stringify(e)).join('\n')), '/own', '0'.repeat(32)).review;
}
describe('R3/R4: точная форма команды реального Codex', () => {
  it.each(['/bin/zsh', '/bin/bash', '/bin/sh'])('принимает одиночный ./fs-probe через %s без кавычек', shell => {
    expect(observe(`${shell} -lc ./fs-probe`)).toMatchObject({ protocol: 'confirmed', probe, unexpectedTool: false });
  });
  it.each(['; echo extra', ' && true', ' extra', '\ntrue', ' | cat'])('не принимает составную команду %s', suffix => {
    expect(observe('/bin/zsh -lc ./fs-probe' + suffix)).toMatchObject({ unexpectedTool: true });
    expect(observe('/bin/zsh -lc ./fs-probe' + suffix).probe).toBeUndefined();
  });
});
