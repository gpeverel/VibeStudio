/** Один потребитель, конечный бюджет. Переполнение сообщает владелец процесса. */
export class BoundedQueue<T> implements AsyncIterable<T> {
  private items: { value: T; size: number }[] = [];
  private bytes = 0;
  private ended = false;
  private waiter?: (item: IteratorResult<T>) => void;

  constructor(private readonly limit: number, private readonly sizeOf: (value: T) => number, private readonly maxItems = 1024) {}

  push(value: T): boolean {
    if (this.ended) return false;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter({ value, done: false });
      return true;
    }
    const size = this.sizeOf(value);
    if (this.bytes + size > this.limit || this.items.length >= this.maxItems) return false;
    this.items.push({ value, size });
    this.bytes += size;
    return true;
  }

  /** Единственный терминал имеет отдельный слот, не теряется при переполнении. */
  finish(last?: T): void {
    if (this.ended) return;
    if (last !== undefined) {
      if (this.waiter) {
        const waiter = this.waiter;
        this.waiter = undefined;
        waiter({ value: last, done: false });
      } else this.items.push({ value: last, size: 0 });
    }
    this.ended = true;
    this.waiter?.({ value: undefined, done: true });
    this.waiter = undefined;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) {
          this.bytes -= item.size;
          return Promise.resolve({ value: item.value, done: false });
        }
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        if (this.waiter) return Promise.reject(new Error('Поддерживается один потребитель потока'));
        return new Promise(resolve => { this.waiter = resolve; });
      },
    };
  }
}
