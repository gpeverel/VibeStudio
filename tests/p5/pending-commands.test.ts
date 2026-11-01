import { describe, expect, it } from 'vitest';
import { createPendingCommands, PENDING_COMMANDS_KEY, type PendingCommand } from '../../src/renderer/pending-commands.ts';

function storageStand() {
  const values = new Map<string, string>();
  return { values, storage: { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } } };
}
const creation: PendingCommand = { method: 'createSession', request: { requestId: 'create-once', projectId: 'project', cli: 'claude' } };
const send: PendingCommand = { method: 'sendTurn', request: { requestId: 'send-once', sessionId: 'session', prompt: 'Исходная задача', conversation: 'continue' } };
const stop: PendingCommand = { method: 'stop', request: { requestId: 'stop-once', sessionId: 'session' } };

describe('P5 UI: сохранение идентичности незавершённого запроса', () => {
  it('новый экземпляр читает то же тело/ID; изменение формы не меняет сохранённый запрос', () => {
    const stand = storageStand(), initial = createPendingCommands(() => stand.storage);
    const form = structuredClone(creation); initial.put(form); form.request.cli = 'codex';
    expect(createPendingCommands(() => stand.storage).read()).toEqual([creation]);
  });
  it('Stop не теряет ожидающий send; подтверждение удаляет только свой запрос', () => {
    const stand = storageStand(), initial = createPendingCommands(() => stand.storage);
    initial.put(send); initial.put(stop);
    const restored = createPendingCommands(() => stand.storage);
    expect(restored.acknowledge(stop.request.requestId)).toEqual([send]);
    expect(initial.read()).toEqual([send]);
    restored.acknowledge(send.request.requestId); expect(stand.values.has(PENDING_COMMANDS_KEY)).toBe(false);
  });
  it('повтор ID не дублируется, другой payload не заменяет неизвестный исход', () => {
    const stand = storageStand(), pending = createPendingCommands(() => stand.storage);
    pending.put(send); pending.put(send); expect(pending.read()).toEqual([send]);
    expect(() => pending.put({ ...send, request: { ...send.request, prompt: 'Другая задача' } })).toThrow('другое содержимое');
    expect(pending.read()).toEqual([send]);
  });
  it('отказ записи не удаляет исходный запрос и не изображается успешным сохранением', () => {
    const stand = storageStand(), pending = createPendingCommands(() => stand.storage);
    pending.put(send);
    stand.storage.setItem = () => { throw new Error('QuotaExceededError'); };
    expect(() => pending.put(stop)).toThrow('QuotaExceededError'); expect(pending.read()).toEqual([send]);
  });
  it.each([
    '{ повреждённый JSON',
    JSON.stringify({ version: 2, commands: [creation] }),
    JSON.stringify({ version: 1, commands: [{ method: 'exec', request: { requestId: 'forged' } }] }),
    JSON.stringify({ version: 1, commands: [{ ...creation, request: { ...creation.request, approved: true } }] }),
    JSON.stringify({ version: 1, commands: [send, send] }),
  ])('отклоняет повреждение/подмену записи без её удаления %#', raw => {
    const stand = storageStand(); stand.values.set(PENDING_COMMANDS_KEY, raw);
    expect(() => createPendingCommands(() => stand.storage).read()).toThrow('Новые действия заблокированы');
    expect(stand.values.get(PENDING_COMMANDS_KEY)).toBe(raw);
  });
});
