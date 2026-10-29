/** Только ограниченная диагностика; бизнес-состояние живёт в Store. */
export interface Journal {
  append(entry: { timestamp: string; sessionId: string; code: string; detail: string }): Promise<void>;
}
