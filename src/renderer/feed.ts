/** Cursor is advanced only after a complete committed page has been accepted.
 * Notifications carry no state: a lost/duplicate hint can only cause another read. */
export function createCursorFeed<T extends { readonly seq: number }>(options: {
  read(afterSeq: number): Promise<{ events: readonly T[]; nextCursor: number; hasMore: boolean }>;
  changed(snapshot: { events: readonly T[]; cursor: number; truncated: boolean }): void;
  failed(error: unknown): void;
  capacity?: number;
}) {
  const capacity = options.capacity ?? 300;
  if (!Number.isInteger(capacity) || capacity < 1) throw new Error('Неверный размер окна ленты.');
  let events: readonly T[] = [];
  let cursor = 0;
  let truncated = false;
  let active = true;
  let requested = false;
  let pending: Promise<void> | undefined;

  async function drain(): Promise<void> {
    try {
      do {
        requested = false;
        let more: boolean;
        do {
          const page = await options.read(cursor);
          if (!active) return;
          let last = cursor;
          for (const event of page.events) {
            if (!Number.isSafeInteger(event.seq) || event.seq <= last) {
              throw new Error('Нарушен порядок событий. Повторите чтение истории.');
            }
            last = event.seq;
          }
          if (page.nextCursor !== last || (page.hasMore && last === cursor)) {
            throw new Error('Некорректный курсор истории.');
          }
          if (page.events.length > 0) {
            const combined = [...events, ...page.events];
            truncated ||= combined.length > capacity;
            events = combined.slice(-capacity);
            cursor = last;
          }
          options.changed({ events, cursor, truncated });
          more = page.hasMore;
          // Give input/paint a chance even when recovering a long history.
          if (more) await new Promise<void>(resolve => setTimeout(resolve, 0));
        } while (active && more);
      } while (active && requested);
    } catch (error) {
      if (active) options.failed(error);
    } finally {
      pending = undefined;
    }
  }

  return {
    refresh(): Promise<void> {
      if (!active) return Promise.resolve();
      requested = true;
      // Defer entry so even a synchronous reader error clears the assigned promise.
      pending ??= Promise.resolve().then(drain);
      return pending;
    },
    dispose(): void { active = false; },
  };
}
