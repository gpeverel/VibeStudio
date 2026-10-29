import { describe, expect, it, vi } from 'vitest';
import { createCursorFeed } from '../../src/renderer/feed.ts';
import { presentEvents, outcomeLabel } from '../../src/renderer/presentation.ts';
import type { SoloEvent } from '../../src/shared/solo.ts';
import type { AgentRunCompletion } from '../../src/shared/agent.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const page = (values: number[], hasMore = false, emptyCursor = 0) => ({
  events: values.map(seq => ({ seq })), nextCursor: values.at(-1) ?? emptyCursor, hasMore,
});

describe('P5 UI: лента committed-событий', () => {
  it('не теряет уведомление во время первого чтения и не удваивает события', async () => {
    const first = deferred<ReturnType<typeof page>>();
    const read = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValueOnce(page([2]));
    const changed = vi.fn(), failed = vi.fn();
    const feed = createCursorFeed<{ seq: number }>({ read, changed, failed });
    const draining = feed.refresh();
    await Promise.resolve();
    const duplicate = feed.refresh();
    first.resolve(page([1]));
    await Promise.all([draining, duplicate]);
    expect(read.mock.calls.map(call => call[0])).toEqual([0, 1]);
    expect(changed).toHaveBeenLastCalledWith({ events: [{ seq: 1 }, { seq: 2 }], cursor: 2, truncated: false });
    expect(failed).not.toHaveBeenCalled();
  });

  it('восстанавливает большую историю порциями, удерживая ограниченное окно', async () => {
    const source = Array.from({ length: 705 }, (_, i) => i + 1);
    const read = vi.fn(async (after: number) => page(source.slice(after, after + 100), after + 100 < source.length));
    const changed = vi.fn(), failed = vi.fn();
    const feed = createCursorFeed({ read, changed, failed, capacity: 300 });
    await feed.refresh();
    const last = changed.mock.calls.at(-1)![0] as { events: { seq: number }[]; cursor: number; truncated: boolean };
    expect(last.events).toHaveLength(300); expect(last.events[0]?.seq).toBe(406);
    expect(last.cursor).toBe(705); expect(last.truncated).toBe(true);
    expect(read).toHaveBeenCalledTimes(8); expect(failed).not.toHaveBeenCalled();
    expect((await read(0)).events[0]?.seq).toBe(1);
  });

  it('после ошибки чтения повторяет тот же курсор и восстанавливает UI', async () => {
    const read = vi.fn().mockResolvedValueOnce(page([1], true)).mockRejectedValueOnce(new Error('IPC'))
      .mockResolvedValueOnce(page([2]));
    const changed = vi.fn(), failed = vi.fn();
    const feed = createCursorFeed<{ seq: number }>({ read, changed, failed });
    await feed.refresh(); await feed.refresh();
    expect(read.mock.calls.map(call => call[0])).toEqual([0, 1, 1]);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenLastCalledWith({ events: [{ seq: 1 }, { seq: 2 }], cursor: 2, truncated: false });
  });

  it('синхронный отказ reader не навсегда блокирует повтор', async () => {
    let broken = true;
    const changed = vi.fn(), failed = vi.fn();
    const feed = createCursorFeed({ read: () => { if (broken) throw new Error('disconnected'); return Promise.resolve(page([1])); }, changed, failed });
    await feed.refresh(); broken = false; await feed.refresh();
    expect(failed).toHaveBeenCalledOnce(); expect(changed).toHaveBeenCalledOnce();
  });

  it.each([
    { events: [{ seq: 1 }, { seq: 1 }], nextCursor: 1, hasMore: false },
    { events: [{ seq: 1 }], nextCursor: 2, hasMore: false },
    { events: [], nextCursor: 0, hasMore: true },
  ])('не перескакивает через повреждённую страницу %#', async broken => {
    const read = vi.fn().mockResolvedValueOnce(broken).mockResolvedValueOnce(page([1, 2]));
    const changed = vi.fn(), failed = vi.fn();
    const feed = createCursorFeed<{ seq: number }>({ read, changed, failed });
    await feed.refresh(); expect(changed).not.toHaveBeenCalled();
    await feed.refresh(); expect(read.mock.calls.map(call => call[0])).toEqual([0, 0]);
    expect(failed).toHaveBeenCalledOnce();
  });

  it('не применяет запоздалую страницу прежней сессии после dispose', async () => {
    const request = deferred<ReturnType<typeof page>>();
    const changed = vi.fn(), failed = vi.fn(), read = vi.fn(() => request.promise);
    const feed = createCursorFeed({ read, changed, failed });
    const pending = feed.refresh(); await Promise.resolve(); feed.dispose();
    request.resolve(page([1], true)); await pending; await feed.refresh();
    expect(changed).not.toHaveBeenCalled(); expect(read).toHaveBeenCalledOnce();
  });
});

function textEvent(seq: number, text: string, mode: 'delta' | 'snapshot' = 'delta', turnId = 'turn'): SoloEvent {
  return { id: `event-${seq}`, sessionId: 'session', seq, timestamp: '2026-10-29T00:00:00.000Z', payload: { type: 'agent',
    event: { schemaVersion: 1, eventId: `agent-${seq}`, sessionId: 'session', participantId: 'participant', turnId,
      seq, timestamp: '2026-10-29T00:00:00.000Z', type: 'text', messageId: 'message', mode, text } } };
}
describe('P5 UI: недоверенный текст и результат', () => {
  it('snapshot заменяет дельты, а новый ход не сливается с предыдущим', () => {
    const events = [textEvent(1, 'При'), textEvent(2, 'вет'), textEvent(3, 'Привет', 'snapshot'), textEvent(4, '!', 'delta'), textEvent(5, 'Следующий', 'snapshot', 'next')];
    expect(presentEvents(events).map(entry => entry.text)).toEqual(['Привет!', 'Следующий']);
    expect(presentEvents(structuredClone(events))).toEqual(presentEvents(events));
  });
  it('сохраняет HTML/ссылку буквальным текстом без интерпретации', () => {
    const text = '<img src="https://outside.invalid/pixel" onerror="alert(1)"><script>throw 1</script>';
    expect(presentEvents([textEvent(1, text)])[0]?.text).toBe(text);
  });
  it('ограничивает размер видимого сообщения и явно отмечает усечение', () => {
    const entry = presentEvents([textEvent(1, 'x'.repeat(64_001))])[0]!;
    expect(entry.text).toHaveLength(64_000); expect(entry.truncated).toBe(true);
  });
  it('принятый Stop не выглядит успешным даже при позднем success', () => {
    const result = { kind: 'success', stopAccepted: true } as AgentRunCompletion;
    expect(outcomeLabel(result)).toBe('Прерывание принято');
  });
});
