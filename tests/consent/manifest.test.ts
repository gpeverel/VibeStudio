import { describe, expect, it } from 'vitest';
import { parseStrictJson } from '../../src/adapters/project-command-snapshot/strict-json.ts';

describe('P4: неоднозначные manifest не принимаются молча', () => {
  it.each([
    ['{"scripts":{"test":"node one.js","test":"node two.js"}}', [['scripts', 'test']]],
    ['{"scripts":{"test":"node one.js"},"scripts":{"test":"node two.js"}}', [['scripts']]],
    ['{"scripts":{"test":"node one.js","te\\u0073t":"node two.js"}}', [['scripts', 'test']]],
    ['{"items":[{"test":1,"test":2}]}', [['items', '0', 'test']]],
  ])('сохраняет неоднозначность ключей: %s', (source, duplicates) => {
    const result = parseStrictJson(source as string);
    expect(result).toMatchObject({ ok: true, duplicates });
  });

  it('разбирает обычный package.json без ложной неоднозначности строковых значений', () => {
    const source = String.raw`{"name":"p4-fixture","private":true,"scripts":{"test":"node scripts/check.js"},"value":"\"test\":1","meta":[null,false,0,-12.5e2]}`;
    const result = parseStrictJson(source);
    expect(result).toMatchObject({ ok: true, value: JSON.parse(source), duplicates: [] });
  });

  it.each([
    '', '{', '{"scripts":}', '{"scripts":{},}', '{"a":1} trailing', '{"a":01}', '{"a":1.}',
    '{"a":"\\x00"}', '{"a":"line\nline"}', '[1,]', '{"a":NaN}', '{"a":"\\uZZZZ"}',
  ])('отклоняет повреждённый JSON: %j', source => {
    expect(parseStrictJson(source)).toEqual({ ok: false });
  });

  it('ограничивает вложенность без исключения наружу', () => {
    expect(parseStrictJson('['.repeat(1000) + '0' + ']'.repeat(1000))).toEqual({ ok: false });
  });

  it('ключ __proto__ остаётся данными и его дубликат обнаруживается', () => {
    const result = parseStrictJson('{"__proto__":{"polluted":true},"__proto__":{}}');
    expect(result).toMatchObject({ ok: true, duplicates: [['__proto__']] });
    if (!result.ok || result.value === null || typeof result.value !== 'object') throw new Error('Ожидался объект');
    expect(Object.hasOwn(result.value, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(result.value)).toBeNull();
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
  });
});
