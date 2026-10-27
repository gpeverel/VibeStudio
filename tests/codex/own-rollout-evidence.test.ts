import { describe, expect, it } from 'vitest';
import { inspectOwnRollout, INVENTORY_CODE } from '../helpers/codex/own-rollout-evidence.ts';

const thread = '019a0000-0000-7000-8000-000000000001'; const cwd = '/own/project'; const home = '/own/home/.codex';
function rows() {
  const entries = [{ path: { type: 'special', value: { kind: 'root' } }, access: 'deny' },
    { path: { type: 'special', value: { kind: 'minimal' } }, access: 'read' },
    { path: { type: 'path', path: cwd }, access: 'read' },
    { path: { type: 'path', path: home + '/tmp/arg0-macos/codex-arg0Ab1' }, access: 'read' }];
  return [{ type: 'session_meta', payload: { id: thread, cwd } },
    { type: 'turn_context', payload: { cwd, approval_policy: 'never', sandbox_policy: { type: 'read-only' },
      active_permission_profile: { id: 'vibestudio-read-v1' },
      permission_profile: { type: 'managed', network: 'restricted', file_system: { type: 'restricted', entries } },
      file_system_sandbox_policy: { kind: 'restricted', entries } } },
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'own', input: INVENTORY_CODE } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'own', output: [
      { type: 'input_text', text: 'Script completed' }, { type: 'input_text', text: '["exec_command","apply_patch"]' }] } }];
}
const inspect = (values: unknown[]) => inspectOwnRollout(values.map(x => JSON.stringify(x)).join('\n'), thread, cwd, home, 'SECRET-SKILL-TOKEN');
describe('M4: только собственная история и фактический каталог инструментов', () => {
  it('проверяет effective policy и связанный результат вызова', () => {
    expect(inspect(rows())).toEqual({ ownership: true, policy: true, inventory: 'confirmed',
      toolNames: ['apply_patch', 'exec_command'], unexpectedSkills: false });
  });
  it.each(['id', 'cwd'])('отклоняет чужую привязку %s', key => {
    const data = rows(); Object.assign(data[0]!.payload, { [key]: 'foreign' });
    expect(inspect(data)).toMatchObject({ ownership: false, policy: false, inventory: 'unconfirmed' });
  });
  it.each(['approval_policy', 'active_permission_profile', 'sandbox_policy'])('не принимает изменённую политику %s', key => {
    const data = rows(); Object.assign(data[1]!.payload, { [key]: 'foreign' });
    expect(inspect(data).policy).toBe(false);
  });
  it.each(['write', 'read-write'])('не допускает доступ %s', access => {
    const data = rows(); data[1]!.payload.permission_profile!.file_system.entries[2]!.access = access;
    expect(inspect(data).policy).toBe(false);
  });
  it('не принимает лишний читаемый путь и выход из runtime-каталога', () => {
    const data = rows(); data[1]!.payload.permission_profile!.file_system.entries[3]!.path.path += '/../foreign';
    expect(inspect(data).policy).toBe(false);
  });
  it('текст модели не заменяет результат инструмента', () => {
    const data = rows(); data.pop();
    expect(inspect([...data, { type: 'response_item', payload: { role: 'assistant', content: ['["exec_command","apply_patch"]'] } }]).inventory).toBe('unconfirmed');
  });
  it('не принимает повторный каталог и чужой call_id', () => {
    const data = rows(); expect(inspect([...data, data[2]]).inventory).toBe('unconfirmed');
    data[3]!.payload.call_id = 'foreign'; expect(inspect(data).inventory).toBe('unconfirmed');
  });
  it.each([undefined, '', 7])('не связывает вызов и результат по некорректному call_id %s', callId => {
    const data = rows();
    Object.assign(data[2]!.payload, { call_id: callId });
    Object.assign(data[3]!.payload, { call_id: callId });
    expect(inspect(data).inventory).toBe('unconfirmed');
  });
  it('выявляет внедрение инструкции навыка, не экспортируя её', () => {
    const result = inspect([...rows(), { type: 'response_item', payload: { role: 'user', content: 'SECRET-SKILL-TOKEN' } }]);
    expect(result.unexpectedSkills).toBe(true); expect(JSON.stringify(result)).not.toContain('SECRET');
  });
});
