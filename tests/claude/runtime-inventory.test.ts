import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ClaudeStreamParser } from '../../src/adapters/claude/parser.ts';
import type { ParserOptions } from '../../src/adapters/claude/parser.ts';
import { compareRuntimeInventory } from '../../src/adapters/claude/profile.ts';
import type { RuntimeInventoryExpectation } from '../../src/adapters/claude/profile.ts';
import type { InventoryOrigin, RuntimeInventory } from '../../src/core/ports/agent.ts';
import { independentInventoryId, jsonLines, syntheticExpectation, syntheticInit, syntheticResult, SYNTHETIC_SESSION } from '../helpers/claude/practical-evidence.ts';
import { fragment } from '../helpers/claude/stand.ts';

const parse = (value: Record<string, unknown>, options: ParserOptions = {}) => {
  const parser = new ClaudeStreamParser(options);
  const events = parser.feed(jsonLines(value));
  return { parser, events, inventory: parser.runtimeInventory! };
};
const expected = (): ParserOptions => ({ expectedSessionId: SYNTHETIC_SESSION, expectedInventory: syntheticExpectation() });

describe('P2b: безопасное runtime inventory, наблюдение не равно разрешению', () => {
  it('совместимый init сравнивается с независимым ожиданием, DTO заморожен', () => {
    const { parser, inventory } = parse(syntheticInit(), expected());
    expect(parser.error).toBeUndefined();
    expect(compareRuntimeInventory(inventory, syntheticExpectation())).toBeUndefined();
    expect(inventory.plugins).toEqual({ state: 'known', provenance: 'cli-init', value: syntheticExpectation().plugins });
    expect(inventory.agents).toMatchObject({ state: 'known', value: ['claude', 'Explore', 'general-purpose', 'Plan'].map(independentInventoryId) });
    expect(Object.isFrozen(inventory)).toBe(true);
    expect(Object.isFrozen(inventory.plugins)).toBe(true);
    if (inventory.plugins.state === 'known') expect(Object.isFrozen(inventory.plugins.value[0])).toBe(true);
  });

  it.each(['tools', 'plugins', 'mcp_servers', 'skills', 'slash_commands', 'agents'])('%s: отсутствие отличается от явно пустого списка', field => {
    const names = { mcp_servers: 'mcpServers', slash_commands: 'slashCommands' };
    const key = (names[field as keyof typeof names] ?? field) as keyof RuntimeInventory;
    const missing = syntheticInit(); delete missing[field];
    expect(parse(missing).inventory[key]).toEqual({ state: 'unknown', reason: 'missing', provenance: 'cli-init' });
    expect(parse(syntheticInit({ [field]: [] })).inventory[key]).toEqual({ state: 'known', value: [], provenance: 'cli-init' });
  });

  it.each(['tools', 'plugins', 'mcp_servers', 'skills', 'slash_commands', 'agents', 'claude_code_version', 'permissionMode'])('пропущенное обязательное %s блокирует gate', field => {
    const init = syntheticInit(); delete init[field];
    expect(parse(init, expected()).parser.error).toMatchObject({ reason: 'runtime_inventory_unknown' });
  });

  it.each([
    { tools: ['Read', null] }, { plugins: [{ name: 'cc-plugin-agents-md', path: 'builtin', source: 'cc-plugin-agents-md@builtin' }, null] },
    { mcp_servers: [{ name: null }] }, { skills: ['valid', {}] }, { slash_commands: ['one', 'one'] },
    { plugins: [{ name: 'valid', path: { SECRET: 'value' } }] }, { agents: ['claude', null] },
  ])('повреждённый элемент списка не исчезает: %j', patch => {
    expect(parse(syntheticInit(patch), expected()).parser.error).toMatchObject({ reason: 'runtime_inventory_unknown' });
  });

  it.each(['project', 'user', 'managed', 'missing'])('знакомое имя plugin с источником %s не превращается в builtin', source => {
    const plugin = { name: 'cc-plugin-agents-md', ...(source === 'missing' ? {} : { source }) };
    const { parser, inventory } = parse(syntheticInit({ plugins: [plugin] }), expected());
    expect(inventory.plugins).toMatchObject({ state: 'known', value: [{ id: independentInventoryId(plugin.name), origin: 'unknown' }] });
    expect(parser.error).toMatchObject({ reason: 'runtime_inventory_unknown' });
  });

  it.each([
    { name: 'cc-plugin-agents-md', path: 'builtin', source: 'cc-plugin-agents-md@project' },
    { name: 'cc-plugin-agents-md', path: '/SECRET/user/plugin', source: 'cc-plugin-agents-md@builtin' },
  ])('противоречие path/source — conflict, не builtin', plugin => {
    const { parser, inventory } = parse(syntheticInit({ plugins: [plugin] }), expected());
    expect(inventory.plugins).toEqual({ state: 'conflict', reason: 'source_conflict', provenance: 'cli-init' });
    expect(parser.error).toMatchObject({ reason: 'runtime_inventory_mismatch' });
    expect(JSON.stringify([inventory, parser.error, parser.diagnostics])).not.toContain('SECRET');
  });

  it.each(['project', 'user', 'managed', 'builtin'] as const)('сравнение origin=%s не подменяется совпадением имени', origin => {
    const { inventory } = parse(syntheticInit());
    const entry = { id: independentInventoryId('same-name'), origin };
    const actual: RuntimeInventory = { ...inventory, plugins: { state: 'known', provenance: 'cli-init', value: [entry] } };
    const wanted: RuntimeInventoryExpectation = { ...syntheticExpectation(), plugins: [entry] };
    expect(compareRuntimeInventory(actual, wanted)).toBeUndefined();
    const other: InventoryOrigin = origin === 'builtin' ? 'managed' : 'builtin';
    expect(compareRuntimeInventory(actual, { ...wanted, plugins: [{ ...entry, origin: other }] })).toMatchObject({ reason: 'runtime_inventory_mismatch' });
  });

  it('known с чужим provenance не является наблюдением cli-init', () => {
    const { inventory } = parse(syntheticInit());
    expect(compareRuntimeInventory({ ...inventory, tools: { state: 'known', provenance: 'version-contract', value: ['Read', 'Glob', 'Grep'] } }, syntheticExpectation()))
      .toMatchObject({ reason: 'runtime_inventory_unknown', field: 'tools' });
  });

  it.each([
    { tools: ['Read', 'Glob', 'Grep', 'Bash'] }, { plugins: [] }, { mcp_servers: [{ name: 'project-command', source: 'project' }] },
    { skills: ['unexpected-skill'] }, { slash_commands: ['unexpected-command'] }, { agents: ['unexpected-agent'] },
    { claude_code_version: '2.1.296' }, { permissionMode: 'bypassPermissions' },
  ])('отличающееся обязательное поле не разрешает само себя: %j', patch => {
    expect(parse(syntheticInit(patch), expected()).parser.error).toBeDefined();
  });

  it('секретные поля name/path/source/env/config не выходят через inventory или диагностику', () => {
    const { parser, inventory, events } = parse(syntheticInit({
      tools: ['SECRET-tool'], plugins: [{ name: 'SECRET-plugin', path: '/SECRET/path', source: 'SECRET-source', command: 'SECRET-command' }],
      mcp_servers: [{ name: 'SECRET-server', env: { TOKEN: 'SECRET-token' } }], skills: ['SECRET-skill'], slash_commands: ['SECRET-command'],
      agents: ['SECRET-agent'], permissionMode: 'SECRET-mode', config: { password: 'SECRET-password' }, apiKeySource: 'SECRET-credential',
    }));
    expect(JSON.stringify([inventory, events, parser.error, parser.diagnostics])).not.toContain('SECRET');
    expect(inventory.tools).toMatchObject({ value: [independentInventoryId('SECRET-tool')] });
  });

  it('semver suffix не раскрывает произвольный секрет через cliVersion', () => {
    const { parser, inventory, events } = parse(syntheticInit({ claude_code_version: '2.1.295-SECRET-version' }));
    expect(JSON.stringify([inventory, events, parser.diagnostics, parser.error])).not.toContain('SECRET');
  });

  it('реальный init 2.1.295 сохраняет builtin регистрацию, без вывода managed-совместимости', () => {
    const raw = readFileSync(new URL('../fixtures/claude/real/01-no-persist.jsonl', import.meta.url), 'utf8');
    const parser = new ClaudeStreamParser();
    parser.feed(Buffer.from(raw)); parser.end();
    expect(parser.error).toBeUndefined();
    expect(parser.runtimeInventory?.plugins).toMatchObject({ state: 'known', value: syntheticExpectation().plugins });
    expect(parser.runtimeInventory).not.toHaveProperty('managed');
    expect(parser.runtimeInventory).not.toHaveProperty('hooks');
    expect(parser.result?.kind).toBe('success'); // Только replay исторического протокола.
  });
});

describe('P2b: синхронный gate, протокол и конечные бюджеты inventory', () => {
  it('init с лишним tool и success одним chunk не дают result или text', () => {
    const parser = new ClaudeStreamParser(expected());
    const events = parser.feed(jsonLines(syntheticInit({ tools: ['Read', 'Bash'] }), syntheticResult()));
    expect(parser.error).toMatchObject({ reason: 'runtime_inventory_mismatch' });
    expect(parser.result).toBeUndefined();
    expect(events).toEqual([]);
  });

  it('правильный init и result выдерживают побайтовую фрагментацию', () => {
    const parser = new ClaudeStreamParser(expected());
    for (const chunk of fragment(jsonLines(syntheticInit(), syntheticResult()), 29, 1)) parser.feed(chunk);
    parser.end();
    expect(parser.error).toBeUndefined();
    expect(parser.result?.kind).toBe('success');
  });

  it('перестановка inventory сохраняет состав независимого ожидания', () => {
    const init = syntheticInit();
    for (const field of ['tools', 'plugins', 'mcp_servers', 'skills', 'slash_commands', 'agents']) {
      init[field] = [...init[field] as unknown[]].reverse();
    }
    const parser = new ClaudeStreamParser(expected());
    parser.feed(jsonLines(init, syntheticResult())); parser.end();
    expect(parser.error).toBeUndefined();
    expect(parser.result?.kind).toBe('success');
  });

  it.each([
    { patch: { tools: ['Read', 'Bash'] }, reason: 'runtime_inventory_mismatch' },
    { patch: { permissionMode: null }, reason: 'runtime_inventory_unknown' },
  ])('последний init без LF проверяется на end: $reason', ({ patch, reason }) => {
    const parser = new ClaudeStreamParser(expected());
    expect(parser.feed(Buffer.from(JSON.stringify(syntheticInit(patch))))).toEqual([]);
    expect(parser.error).toBeUndefined();
    expect(parser.end()).toEqual([]);
    expect(parser.error).toMatchObject({ reason });
    expect(parser.result).toBeUndefined();
    expect(parser.feed(jsonLines(syntheticResult()))).toEqual([]);
    expect(parser.result).toBeUndefined();
  });

  it('повтор init не заменяет первый снимок и запрещает поздний success', () => {
    const parser = new ClaudeStreamParser(expected());
    parser.feed(jsonLines(syntheticInit()));
    const first = parser.runtimeInventory;
    parser.feed(jsonLines(syntheticInit({ tools: ['Bash'] }), syntheticResult()));
    expect(parser.error).toMatchObject({ reason: 'protocol_incompatible' });
    expect(parser.runtimeInventory).toBe(first);
    expect(parser.result).toBeUndefined();
  });

  it.each(['empty', 'result', 'assistant'] as const)('отсутствующий init при %s не даёт success', form => {
    const parser = new ClaudeStreamParser(expected());
    if (form === 'result') parser.feed(jsonLines(syntheticResult()));
    if (form === 'assistant') parser.feed(jsonLines({ type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: 'SECRET-before-init' }] } }));
    parser.end();
    expect(parser.error).toMatchObject({ reason: 'runtime_inventory_unknown' });
    expect(parser.result).toBeUndefined();
  });

  it('мутация исходного ожидания после конструктора не меняет gate', () => {
    const expectation = syntheticExpectation();
    const parser = new ClaudeStreamParser({ expectedInventory: expectation });
    (expectation.tools as string[]).push('Bash');
    parser.feed(jsonLines(syntheticInit(), syntheticResult()));
    expect(parser.error).toBeUndefined();
    expect(parser.result?.kind).toBe('success');
  });

  it.each([
    { name: 'sparse tools', patch: { tools: new Array(3) } },
    { name: 'sparse plugins', patch: { plugins: new Array(1) } },
    { name: 'повреждённая запись', patch: { plugins: [null] } },
    { name: 'неизвестное происхождение', patch: { plugins: [{ id: independentInventoryId('plugin'), origin: 'unknown' }] } },
    { name: 'отсутствующий список', patch: { mcpServers: undefined } },
    { name: 'неизвестная версия', patch: { cliVersion: 'SECRET-version' } },
    { name: 'другой режим прав', patch: { permissionMode: 'SECRET-mode' } },
  ])('повреждённое ожидание $name не разрешает фактический inventory', ({ patch }) => {
    const parser = new ClaudeStreamParser({ expectedInventory: { ...syntheticExpectation(), ...patch } as unknown as RuntimeInventoryExpectation });
    expect(parser.error).toMatchObject({ reason: 'runtime_inventory_unknown' });
    expect(parser.feed(jsonLines(syntheticInit(), syntheticResult()))).toEqual([]);
    expect(parser.end()).toEqual([]);
    expect(parser.result).toBeUndefined();
    expect(JSON.stringify([parser.error, parser.diagnostics])).not.toContain('SECRET');
  });

  it.each([
    ['число элементов поля', syntheticInit({ skills: Array.from({ length: 65 }, (_, i) => `s${i}`) }), {}],
    ['байты имени', syntheticInit({ plugins: [{ name: 'я'.repeat(65) }] }), {}],
    ['общий счётчик', syntheticInit(), { maxMessages: 2 }],
    ['бюджет состояния', syntheticInit(), { maxStateBytes: 128 }],
    ['строка JSONL', syntheticInit(), { maxLineBytes: 128 }],
  ] as const)('%s ограничен, поздний result не снимает output_limit', (_name, init, options) => {
    const parser = new ClaudeStreamParser({ ...expected(), ...options });
    parser.feed(jsonLines(init, syntheticResult()));
    expect(parser.error).toMatchObject({ reason: 'output_limit' });
    expect(parser.result).toBeUndefined();
  });

  it('повреждённый JSON не раскрывает содержимое в конечной диагностике', () => {
    const parser = new ClaudeStreamParser({ ...expected(), maxDiagBytes: 64 });
    parser.feed(Buffer.from('{"type":"system","SECRET-token":\n'));
    parser.feed(jsonLines(syntheticInit(), syntheticResult()));
    expect(parser.error).toMatchObject({ reason: 'protocol_incompatible' });
    expect(JSON.stringify([parser.error, parser.diagnostics])).not.toContain('SECRET');
    expect(parser.result).toBeUndefined();
  });
});
