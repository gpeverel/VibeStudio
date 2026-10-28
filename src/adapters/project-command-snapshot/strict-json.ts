/** Минимальный строгий разбор JSON: отличается от JSON.parse тем, что находит повторяющиеся ключи.
 * Нужен для package.json: при дубле `scripts.test` JSON.parse молча берёт последний, и пользователь,
 * видевший первый, согласился бы на другое тело. Без Node-модулей. */
export type StrictJsonValue = null | boolean | number | string | StrictJsonValue[] | { [key: string]: StrictJsonValue };

export type StrictJsonResult =
  | {
      readonly ok: true;
      readonly value: StrictJsonValue;
      /** Путь каждого повторённого ключа: ['scripts', 'test']. */
      readonly duplicates: readonly (readonly string[])[];
    }
  | { readonly ok: false };

const MAX_DEPTH = 64;
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;
const ESCAPES: Readonly<Record<string, string>> = {
  '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t',
};

class Malformed extends Error {}

class Reader {
  private index = 0;
  readonly duplicates: string[][] = [];
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  parseDocument(): StrictJsonValue {
    const value = this.value([], 0);
    this.skipSpace();
    if (this.index !== this.text.length) throw new Malformed();
    return value;
  }

  private skipSpace(): void {
    while (this.index < this.text.length) {
      const ch = this.text[this.index];
      if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') return;
      this.index += 1;
    }
  }

  private value(path: string[], depth: number): StrictJsonValue {
    if (depth > MAX_DEPTH) throw new Malformed();
    this.skipSpace();
    const ch = this.text[this.index];
    if (ch === '{') return this.object(path, depth);
    if (ch === '[') return this.array(path, depth);
    if (ch === '"') return this.string();
    for (const [literal, result] of [['true', true], ['false', false], ['null', null]] as const) {
      if (this.text.startsWith(literal, this.index)) {
        this.index += literal.length;
        return result;
      }
    }
    const match = NUMBER.exec(this.text.slice(this.index, this.index + 64));
    if (!match) throw new Malformed();
    this.index += match[0].length;
    return Number(match[0]);
  }

  private object(path: string[], depth: number): StrictJsonValue {
    this.index += 1;
    // Без прототипа: ключ `__proto__` остаётся обычным ключом и не меняет объект.
    const result: { [key: string]: StrictJsonValue } = Object.create(null) as { [key: string]: StrictJsonValue };
    this.skipSpace();
    if (this.text[this.index] === '}') {
      this.index += 1;
      return result;
    }
    for (;;) {
      this.skipSpace();
      if (this.text[this.index] !== '"') throw new Malformed();
      const key = this.string();
      this.skipSpace();
      if (this.text[this.index] !== ':') throw new Malformed();
      this.index += 1;
      if (Object.hasOwn(result, key)) this.duplicates.push([...path, key]);
      result[key] = this.value([...path, key], depth + 1);
      this.skipSpace();
      const next = this.text[this.index];
      this.index += 1;
      if (next === '}') return result;
      if (next !== ',') throw new Malformed();
    }
  }

  private array(path: string[], depth: number): StrictJsonValue {
    this.index += 1;
    const result: StrictJsonValue[] = [];
    this.skipSpace();
    if (this.text[this.index] === ']') {
      this.index += 1;
      return result;
    }
    for (;;) {
      result.push(this.value([...path, String(result.length)], depth + 1));
      this.skipSpace();
      const next = this.text[this.index];
      this.index += 1;
      if (next === ']') return result;
      if (next !== ',') throw new Malformed();
    }
  }

  private string(): string {
    this.index += 1;
    let out = '';
    for (;;) {
      const ch = this.text[this.index];
      if (ch === undefined) throw new Malformed();
      this.index += 1;
      if (ch === '"') return out;
      if (ch < ' ') throw new Malformed();
      if (ch !== '\\') {
        out += ch;
        continue;
      }
      const escape = this.text[this.index];
      this.index += 1;
      if (escape === 'u') {
        const hex = this.text.slice(this.index, this.index + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Malformed();
        out += String.fromCharCode(Number.parseInt(hex, 16));
        this.index += 4;
        continue;
      }
      const mapped = escape === undefined ? undefined : ESCAPES[escape];
      if (mapped === undefined) throw new Malformed();
      out += mapped;
    }
  }
}

export function parseStrictJson(text: string): StrictJsonResult {
  const reader = new Reader(text.startsWith('﻿') ? text.slice(1) : text);
  try {
    const value = reader.parseDocument();
    return { ok: true, value, duplicates: reader.duplicates };
  } catch (error) {
    if (error instanceof Malformed) return { ok: false };
    // Переполнение стека и прочие сбои не раскрываются: вызывающий видит только «не разобрано».
    return { ok: false };
  }
}
