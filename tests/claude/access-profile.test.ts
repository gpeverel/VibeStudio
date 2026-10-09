import { describe, expect, it } from 'vitest';
import { buildClaudeArgs, buildClaudeEnv } from '../../src/adapters/claude/args.ts';
import { validateAccessProfile } from '../../src/adapters/claude/profile.ts';
import type { AccessProfile } from '../../src/core/ports/agent.ts';
import { AGENT_SESSION, flagValue, readOnlyProfile, request } from '../helpers/claude/requests.ts';

const CWD = '/tmp/vs-test/worktree';
const mutate = (patch: Record<string, unknown>): AccessProfile => ({ ...readOnlyProfile(CWD), ...patch }) as AccessProfile;

describe('0C argv и stdin: запуск без shell и без утечки промпта в аргументы', () => {
  it('промпт передаётся только через stdin и не встречается ни в одном аргументе', () => {
    const prompt = `большой промпт $(rm -rf /) \`id\` "'` + 'я'.repeat(200_000);
    const { args, stdin } = buildClaudeArgs(request(CWD, { prompt }));
    expect(stdin).toBe(prompt);
    expect(args.some(a => a.includes('rm -rf'))).toBe(false);
    expect(args.every(a => typeof a === 'string')).toBe(true);
    expect(args.join('\n').length).toBeLessThan(20_000); // аргументы не растут вместе с промптом
  });

  it('argv — массив отдельных элементов; значения с пробелами не склеиваются в строку команды', () => {
    const { args } = buildClaudeArgs(request(CWD));
    expect(Array.isArray(args)).toBe(true);
    expect(flagValue(args, '--tools')).toBe('Read,Glob,Grep');
    expect(args).toContain('--print');
    expect(flagValue(args, '--output-format')).toBe('stream-json');
  });

  it('первый ход использует --session-id, resume — --resume с тем же agentSessionId; turnId не попадает в argv', () => {
    const first = buildClaudeArgs(request(CWD)).args;
    expect(flagValue(first, '--session-id')).toBe(AGENT_SESSION);
    expect(first).not.toContain('--resume');
    const next = buildClaudeArgs(request(CWD, { resume: true, turnId: 'turn-2-unique' })).args;
    expect(flagValue(next, '--resume')).toBe(AGENT_SESSION);
    expect(next).not.toContain('--session-id');
    for (const args of [first, next]) {
      expect(args.join('\n')).not.toContain('turn-');
      expect(args).not.toContain('--continue');
      expect(args).not.toContain('--fork-session');
    }
  });

  it('agentSessionId обязан быть UUID; произвольная строка отклоняется', () => {
    for (const bad of ['', 'not-a-uuid', '--bare', `${AGENT_SESSION} --dangerously-skip-permissions`]) {
      expect(() => buildClaudeArgs(request(CWD, { agentSessionId: bad }))).toThrow();
    }
  });

  it('resume без сохранения диалога невозможен; отказ от сохранения добавляет флаг', () => {
    expect(() => buildClaudeArgs(request(CWD, { resume: true, persistSession: false }))).toThrow();
    expect(buildClaudeArgs(request(CWD, { persistSession: false })).args).toContain('--no-session-persistence');
    expect(buildClaudeArgs(request(CWD)).args).not.toContain('--no-session-persistence');
  });

  it('maxTurns и model передаются отдельными аргументами; некорректный maxTurns отклоняется', () => {
    const { args } = buildClaudeArgs(request(CWD, { maxTurns: 3, model: 'sonnet' }));
    expect(flagValue(args, '--max-turns')).toBe('3');
    expect(flagValue(args, '--model')).toBe('sonnet');
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(() => buildClaudeArgs(request(CWD, { maxTurns: bad }))).toThrow();
  });

  it('пустые идентификаторы запуска отклоняются', () => {
    for (const key of ['sessionId', 'turnId', 'participantId', 'workspaceId'] as const) {
      expect(() => buildClaudeArgs(request(CWD, { [key]: '' }))).toThrow();
    }
  });
});

describe('0C профиль доступа read-only: независимая проверка argv', () => {
  const args = (overrides = {}) => buildClaudeArgs(request(CWD, overrides)).args;

  it('--tools задаёт закрытый набор чтения без Bash/записи/делегирования', () => {
    const tools = (flagValue(args(), '--tools') ?? '').split(',');
    expect(tools.sort()).toEqual(['Glob', 'Grep', 'Read']);
    for (const banned of ['Bash', 'Edit', 'Write', 'NotebookEdit', 'Agent', 'Task', 'WebFetch', 'PowerShell']) {
      expect(tools).not.toContain(banned);
    }
  });

  it('недоступные инструменты дополнительно перечислены в --disallowedTools (deny — вторая линия)', () => {
    const denied = (flagValue(args(), '--disallowedTools') ?? '').split(',');
    for (const banned of ['Bash', 'Edit', 'Write', 'NotebookEdit', 'Agent']) expect(denied).toContain(banned);
  });

  it('ни allowedTools, ни permission mode не подменяют --tools', () => {
    const a = args();
    expect(a).toContain('--tools');
    expect(a).not.toContain('--dangerously-skip-permissions');
    expect(a).not.toContain('--allow-dangerously-skip-permissions');
    expect(flagValue(a, '--permission-mode')).not.toBe('bypassPermissions');
    expect(flagValue(a, '--permission-mode')).not.toBe('acceptEdits');
    expect(a).not.toContain('--allowedTools'); // пустой allow не добавляет флаг
  });

  it('allow из подмножества tools передаётся, но не расширяет --tools', () => {
    const a = buildClaudeArgs(request(CWD, { profile: readOnlyProfile(CWD, { allow: ['Read'] }) })).args;
    expect(flagValue(a, '--allowedTools')).toBe('Read');
    expect(flagValue(a, '--tools')).toBe('Read,Glob,Grep');
  });

  it('проектные hooks/MCP/plugins/settings отключены в argv и не заменены одним --bare', () => {
    const a = args();
    expect(flagValue(a, '--setting-sources')).toBe('');
    expect(a).toContain('--strict-mcp-config');
    expect(JSON.parse(flagValue(a, '--mcp-config') ?? 'null')).toEqual({ mcpServers: {} });
    expect(a).not.toContain('--plugin-dir');
    expect(a).not.toContain('--plugin-url');
    expect(a).not.toContain('--add-dir');
    expect(a).not.toContain('--bare'); // не универсальное решение: ломает авторизацию через Keychain/OAuth
    expect(a).not.toContain('--settings');
    expect(a).not.toContain('--agents');
  });

  it('неинтерактивные запросы разрешений не ждут ввода', () => {
    const a = args();
    expect(flagValue(a, '--permission-prompts')).toBe('none');
    expect(flagValue(a, '--permission-mode')).toBe('dontAsk');
  });

  it('--append-system-prompt не содержит исследовательской разметки и обещаний harness', () => {
    const text = flagValue(args(), '--append-system-prompt') ?? '';
    expect(text.length).toBeGreaterThan(0);
    for (const marker of ['⟦', '⟧', '{{', '}}', '${', '[[vibeforge', 'harness']) expect(text).not.toContain(marker);
    expect(text).not.toMatch(/автоматическ\w+ (откат|восстановлен)/i);
  });
});

describe('0C профиль доступа: validateAccessProfile блокирует ослабленные профили', () => {
  it('минимальный профиль read-only допустим', () => {
    expect(validateAccessProfile(readOnlyProfile(CWD), CWD)).toEqual([]);
  });

  const bad: [string, AccessProfile][] = [
    ['Bash в tools', mutate({ tools: ['Read', 'Bash'] })],
    ['Edit в tools', mutate({ tools: ['Read', 'Edit'] })],
    ['Write в tools', mutate({ tools: ['Write'] })],
    ['Agent в tools', mutate({ tools: ['Read', 'Agent'] })],
    ['allow шире tools', mutate({ allow: ['Bash'] })],
    ['режим не read-only', mutate({ mode: 'workspace-write' })],
    ['включённые hooks', mutate({ configPolicy: { settingSources: [], loadHooks: true, loadMcp: false, loadPlugins: false } })],
    ['включённые MCP', mutate({ configPolicy: { settingSources: [], loadHooks: false, loadMcp: true, loadPlugins: false } })],
    ['включённые plugins', mutate({ configPolicy: { settingSources: [], loadHooks: false, loadMcp: false, loadPlugins: true } })],
    ['автообнаружение project settings', mutate({ configPolicy: { settingSources: ['project'], loadHooks: false, loadMcp: false, loadPlugins: false } })],
    ['writeRoots не пуст', mutate({ fs: { readRoots: [CWD], writeRoots: [CWD], runtimeWriteRoots: [], protectedPaths: [] } })],
    ['чтение шире cwd', mutate({ fs: { readRoots: [CWD, '/'], writeRoots: [], runtimeWriteRoots: [], protectedPaths: [] } })],
    ['относительный путь границы', mutate({ fs: { readRoots: [CWD], writeRoots: [], runtimeWriteRoots: ['relative/tmp'], protectedPaths: [] } })],
    ['запись в runtime пересекает cwd', mutate({ fs: { readRoots: [CWD], writeRoots: [], runtimeWriteRoots: ['/tmp/vs-test'], protectedPaths: [] } })],
    ['запись в runtime пересекает Git-каталог', mutate({ fs: { readRoots: [CWD], writeRoots: [], runtimeWriteRoots: ['/repo/.git/x'], protectedPaths: [], gitCommonDir: '/repo/.git' } })],
    ['сеть шире провайдера', mutate({ network: 'full' })],
    ['нет fs', mutate({ fs: undefined })],
    ['нет configPolicy', mutate({ configPolicy: undefined })],
  ];
  for (const [name, profile] of bad) {
    it(`отказ: ${name}`, () => {
      expect(validateAccessProfile(profile, CWD).length).toBeGreaterThan(0);
      expect(() => buildClaudeArgs(request(CWD, { profile }))).toThrow();
    });
  }

  it('относительный cwd отклоняется', () => {
    expect(validateAccessProfile(readOnlyProfile('rel/dir'), 'rel/dir').length).toBeGreaterThan(0);
  });
});

describe('0C окружение: строгий allowlist без копирования всего env', () => {
  it('передаются только документированные имена; прочее отбрасывается', () => {
    const env = buildClaudeEnv({
      HOME: '/h', PATH: '/usr/bin', LANG: 'ru_RU.UTF-8', CLAUDE_CONFIG_DIR: '/c', ANTHROPIC_API_KEY: 'sk-test',
      NODE_OPTIONS: '--require /evil.js', DYLD_INSERT_LIBRARIES: '/evil.dylib', LD_PRELOAD: '/evil.so',
      HTTPS_PROXY: 'http://evil', HTTP_PROXY: 'http://evil', ANTHROPIC_BASE_URL: 'http://evil', CLAUDE_CODE_USE_BEDROCK: '1',
      GITHUB_TOKEN: 'ghp_x', AWS_SECRET_ACCESS_KEY: 'x', DATABASE_URL: 'postgres://x', BASH_ENV: '/evil.sh', GIT_DIR: '/evil',
    });
    expect(env.HOME).toBe('/h');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-test');
    for (const name of ['NODE_OPTIONS', 'DYLD_INSERT_LIBRARIES', 'LD_PRELOAD', 'HTTPS_PROXY', 'HTTP_PROXY', 'ANTHROPIC_BASE_URL',
      'CLAUDE_CODE_USE_BEDROCK', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'DATABASE_URL', 'BASH_ENV', 'GIT_DIR']) {
      expect(env, name).not.toHaveProperty(name);
    }
  });

  it('окружение процесса приложения не подмешивается: builder берёт только request.env', () => {
    process.env.VS_AMBIENT_SECRET = 'leak';
    process.env.GITHUB_TOKEN = 'ambient-token';
    try {
      const { env } = buildClaudeArgs(request(CWD, { env: { HOME: '/h' } }));
      expect(env).not.toHaveProperty('VS_AMBIENT_SECRET');
      expect(env).not.toHaveProperty('GITHUB_TOKEN');
      expect(env.HOME).toBe('/h');
    } finally { delete process.env.VS_AMBIENT_SECRET; delete process.env.GITHUB_TOKEN; }
  });

  it('автообновление и необязательный трафик выключены; значения с NUL отбрасываются', () => {
    const env = buildClaudeEnv({ HOME: 'a\0b', PATH: '/usr/bin' });
    expect(env.DISABLE_AUTOUPDATER).toBe('1');
    expect(env).not.toHaveProperty('HOME');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('секреты авторизации не попадают в argv и stdin', () => {
    const built = buildClaudeArgs(request(CWD, { env: { HOME: '/h', ANTHROPIC_API_KEY: 'sk-secret-123', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret-456' } }));
    expect(built.args.join('\n')).not.toMatch(/secret/);
    expect(built.stdin).not.toMatch(/secret/);
    expect(built.env.ANTHROPIC_API_KEY).toBe('sk-secret-123'); // штатная авторизация сохранена в env
  });
});
