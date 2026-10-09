import { chmodSync, copyFileSync, realpathSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { detectClaude, resolveClaudeBinary } from '../../src/adapters/claude/detect.ts';
import { createProcessRunner } from '../../src/adapters/process-runner/index.ts';
import { Stand } from '../helpers/claude/stand.ts';
import type { FakeScenario } from '../helpers/claude/stand.ts';

const stands: Stand[] = [];
function stand(): Stand { const s = new Stand(); stands.push(s); return s; }
afterEach(() => { while (stands.length) stands.pop()?.cleanup(); });

const runner = createProcessRunner();

// Независимый перечень флагов, нужных профилю (не импортируется из производственного кода).
const FLAGS = [
  '--print', '--verbose', '--input-format', '--output-format <format>', '--include-partial-messages', '--restricted', '--safe-mode',
  '--setting-sources <sources>', '--strict-mcp-config', '--mcp-config <configs...>', '--tools <tools...>', '--permission-mode <mode>',
  '--permission-prompts <target>', '--disable-slash-commands', '--no-chrome', '--disallowedTools <tools...>', '--allowedTools <tools...>',
  '--append-system-prompt <prompt>', '--session-id <uuid>', '--system-prompt-snapshot <on|off>', '--resume [value]', '--no-session-persistence', '--max-turns <n>',
];
const helpWith = (flags: string[], format = 'Output format (text, json, stream-json)'): string =>
  `Usage: claude [options]\n\nOptions:\n${flags.map(f => `  ${f}   описание`).join('\n')}\n  --output-format-note  ${format}\n`;
const FULL_HELP = helpWith(FLAGS);
const good = (extra: Partial<FakeScenario> = {}): FakeScenario => ({
  version: '2.1.295 (Claude Code)', help: FULL_HELP, auth: { loggedIn: true, authMethod: 'claude.ai' }, ...extra,
});
const env = (s: Stand) => ({ HOME: s.dir, PATH: '/usr/bin:/bin', ANTHROPIC_API_KEY: 'sk-test-detect', NODE_OPTIONS: '--require /evil.js' });
const reasons = (d: Awaited<ReturnType<typeof detectClaude>>) => d.unavailable.map(u => u.reason);

describe('0C detect: диагностика бинарника, авторизации и возможностей', () => {
  it('явный абсолютный путь несуществующего бинарника: binary_missing, ничего не запускается и не ставится', async () => {
    const s = stand();
    const d = await detectClaude(runner, { binaryPath: s.path('нет-claude'), env: env(s) });
    expect(d.status).toBe('unavailable');
    expect(d.binaryPath).toBeNull();
    expect(d.version).toBeNull();
    expect(reasons(d)).toContain('binary_missing');
    expect(reasons(d)).not.toContain('not_authenticated');
    expect(d.capabilities.readOnly).not.toBe('verified');
  });

  it('относительный путь не принимается как бинарник', async () => {
    const s = stand();
    const d = await detectClaude(runner, { binaryPath: 'claude', env: env(s) });
    expect(reasons(d)).toContain('binary_missing');
    expect(await resolveClaudeBinary({ binaryPath: './claude', env: env(s) })).toBeNull();
  });

  it('явный путь авторитетен: ошибка по нему не подменяется бинарником из PATH', async () => {
    const s = stand();
    s.fakeClaude(good()); // лежит в stand.dir как claude-1, но на него указывает PATH
    const dirOnPath = s.dir;
    const d = await detectClaude(runner, { binaryPath: s.path('другого-нет'), env: { HOME: s.dir, PATH: dirOnPath } });
    expect(reasons(d)).toContain('binary_missing');
    expect(d.binaryPath).toBeNull();
  });

  it('файл без права исполнения не считается бинарником', async () => {
    const s = stand();
    const control = s.controlFile('claude-noexec', '#!/bin/sh\nexit 0\n');
    const d = await detectClaude(runner, { binaryPath: control.path, env: env(s) });
    expect(reasons(d)).toContain('binary_missing');
  });

  it('ограниченный PATH (как при запуске из Finder): бинарник ищется по PATH запроса, а не по окружению Electron', async () => {
    const s = stand();
    const bin = s.fakeClaude(good());
    const named = s.path('claude');
    copyFileSync(bin, named);
    chmodSync(named, 0o755);
    const found = await detectClaude(runner, { env: { HOME: s.dir, PATH: s.dir } });
    expect(found.binaryPath).toBe(realpathSync(named));
    expect(found.version).toBe('2.1.295');
  });

  it('рабочий бинарник с входом: версия, возможности по help, но readOnly остаётся unverified и status=unavailable', async () => {
    const s = stand();
    const bin = s.fakeClaude(good());
    const d = await detectClaude(runner, { binaryPath: bin, env: env(s) });
    expect(d.binaryPath).toBe(bin);
    expect(d.version).toBe('2.1.295');
    expect(d.auth).toBe('authenticated');
    expect(d.capabilities).toMatchObject({ streamJson: true, partialMessages: true, restricted: true, safeMode: true, tools: true, settingSources: true, strictMcpConfig: true, resume: true, sessionId: true });
    expect(d.capabilities.readOnly).toBe('unverified'); // наличие флагов — не проверенная граница
    expect(d.status).toBe('unavailable');
    expect(reasons(d)).toContain('profile_unverified');
    expect(reasons(d)).not.toContain('binary_missing');
    expect(reasons(d)).not.toContain('not_authenticated');
    expect(reasons(d)).not.toContain('capability_missing');
  });

  it('нет авторизации: not_authenticated отличается от отсутствия бинарника и от несовместимости', async () => {
    const s = stand();
    const bin = s.fakeClaude(good({ auth: { loggedIn: false }, authExit: 1 }));
    const d = await detectClaude(runner, { binaryPath: bin, env: env(s) });
    expect(d.auth).toBe('unauthenticated');
    expect(reasons(d)).toContain('not_authenticated');
    expect(reasons(d)).not.toContain('binary_missing');
    expect(reasons(d)).not.toContain('capability_missing');
    expect(d.status).toBe('unavailable');
  });

  it('несовместимые возможности: перечисляется отсутствующий флаг, вход не путается с capability_missing', async () => {
    const s = stand();
    const bin = s.fakeClaude(good({ help: helpWith(FLAGS.filter(f => !f.startsWith('--restricted') && !f.startsWith('--tools'))) }));
    const d = await detectClaude(runner, { binaryPath: bin, env: env(s) });
    expect(d.capabilities.restricted).toBe(false);
    expect(d.capabilities.tools).toBe(false);
    const missing = d.unavailable.find(u => u.reason === 'capability_missing');
    expect(missing?.detail).toContain('--restricted');
    expect(missing?.detail).toContain('--tools');
    expect(reasons(d)).not.toContain('binary_missing');
  });

  it('флаг, упомянутый только в тексте описания другого флага, не считается поддержкой', async () => {
    const s = stand();
    const flags = FLAGS.filter(f => !f.startsWith('--restricted'));
    const bin = s.fakeClaude(good({ help: `${helpWith(flags)}  --other   подробнее см. --restricted-mode docs и (--restricted)\n` }));
    const d = await detectClaude(runner, { binaryPath: bin, env: env(s) });
    expect(d.capabilities.restricted).toBe(false);
  });

  it('падение --help или --version не даёт доступных возможностей', async () => {
    const s = stand();
    const bin = s.fakeClaude(good({ help: FULL_HELP, helpExit: 2 }));
    const d = await detectClaude(runner, { binaryPath: bin, env: env(s) });
    expect(d.capabilities.restricted).toBe(false);
    expect(d.status).toBe('unavailable');
    const noVersion = s.fakeClaude({ help: FULL_HELP, auth: { loggedIn: true } });
    expect((await detectClaude(runner, { binaryPath: noVersion, env: env(s) })).version).toBeNull();
  });

  it('loggedIn не boolean: auth не становится authenticated', async () => {
    const s = stand();
    const odd = s.fakeClaude(good({ auth: { loggedIn: 'yes' as unknown as boolean }, authExit: 0 }));
    const d = await detectClaude(runner, { binaryPath: odd, env: env(s) });
    expect(d.auth).not.toBe('authenticated');
    expect(d.status).toBe('unavailable');
  });

  it('detect не делает модельного запроса: только --version, --help и auth status', async () => {
    const s = stand();
    const bin = s.fakeClaude(good());
    await detectClaude(runner, { binaryPath: bin, env: env(s) });
    const probes = s.records().map(r => r.probe);
    expect(probes.length).toBeGreaterThan(0);
    expect(probes).not.toContain('run');
    for (const r of s.records()) {
      expect(r.argv).not.toContain('--print');
      expect(r.argv).not.toContain('-p');
    }
  });

  it('пробы получают allowlist окружения: без NODE_OPTIONS, с авторизацией', async () => {
    const s = stand();
    const bin = s.fakeClaude(good());
    await detectClaude(runner, { binaryPath: bin, env: env(s) });
    for (const r of s.records()) {
      expect(r.env).not.toHaveProperty('NODE_OPTIONS');
      expect(r.env.ANTHROPIC_API_KEY).toBe('sk-test-detect');
      expect(r.env.HOME).toBe(s.dir);
      expect(r.env.DISABLE_AUTOUPDATER).toBe('1');
    }
  });
});
