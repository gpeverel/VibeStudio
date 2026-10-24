import { describe, expect, it } from 'vitest';
import { buildCodexArgs, buildCodexEnv } from '../../src/adapters/codex/args.ts';
import { checkCodexAdmission, createCodexProductionAdmission, validateCodexProfile } from '../../src/adapters/codex/profile.ts';
import type { CodexRunRequest } from '../../src/adapters/codex/contracts.ts';
import { buildAgentInstructions } from '../../src/core/agent-instructions.ts';
import { detection, firstRequest, profile, resumeRequest, SYNTHETIC_ADMISSION, THREAD } from '../helpers/codex/requests.ts';

const CWD = '/synthetic/workspace with spaces';
const invalid = (value: unknown) => value as CodexRunRequest; // Только проверка runtime-недоверенного ввода.

describe('Codex argv/env: собственный контракт first turn и resume', () => {
  it('большой prompt передаётся только через stdin, без shell-конкатенации', () => {
    const prompt = 'Прочитай $(not-a-command) `literal` ; "quoted"\n'.repeat(10_000);
    const built = buildCodexArgs(firstRequest(CWD, { prompt }));
    expect(built.stdin).toBe(prompt);
    expect(built.args.slice(0, 1)).toEqual(['exec']);
    expect(built.args.at(-1)).toBe('-');
    expect(built.args.join(' ')).not.toContain('not-a-command');
    for (const forbidden of ['--session-id', '--append-system-prompt', '--full-auto', '--dangerously-bypass-approvals-and-sandbox']) expect(built.args).not.toContain(forbidden);
    expect(built.args).toEqual(expect.arrayContaining(['--json', '--sandbox', 'read-only', '--ignore-user-config', '--ignore-rules', 'approval_policy="never"']));
  });

  it('resume адресует только явный ID этого адаптера и сохраняет политику', () => {
    const built = buildCodexArgs(resumeRequest(CWD));
    expect(built.args.slice(0, 2)).toEqual(['exec', 'resume']);
    expect(built.args.slice(-2)).toEqual([THREAD, '-']);
    expect(built.args).not.toContain('--last');
    expect(built.args).not.toContain('--all');
    expect(built.args).toEqual(expect.arrayContaining(['sandbox_mode="read-only"', 'approval_policy="never"', '--ignore-user-config', '--ignore-rules']));
  });

  it.each([false, true])('sandbox read-only задан своим значением, обходов нет: resume=%s', resume => {
    const { args } = buildCodexArgs(resume ? resumeRequest(CWD) : firstRequest(CWD));
    if (resume) {
      expect(args).not.toContain('--sandbox');
      expect(args.filter(arg => arg.startsWith('sandbox_mode='))).toEqual(['sandbox_mode="read-only"']);
      expect(args[args.indexOf('sandbox_mode="read-only"') - 1]).toBe('-c');
    } else {
      expect(args.filter(arg => arg === '--sandbox')).toHaveLength(1);
      expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only');
      expect(args.some(arg => arg.startsWith('sandbox_mode='))).toBe(false);
    }
    expect(args.filter(arg => arg.startsWith('approval_policy='))).toEqual(['approval_policy="never"']);
    expect(args[args.indexOf('approval_policy="never"') - 1]).toBe('-c');
    for (const forbidden of ['--yolo', '--dangerously-bypass-hook-trust', '--approve-for-me', '--full-auto', '--dangerously-bypass-approvals-and-sandbox']) {
      expect(args).not.toContain(forbidden);
    }
  });

  it.each([false, true])('инструкции переданы отдельным config-значением, resume=%s; это не доказательство исполнения', resume => {
    const request = resume ? resumeRequest(CWD) : firstRequest(CWD);
    const built = buildCodexArgs(request);
    const entry = built.args.find(arg => arg.startsWith('developer_instructions='));
    expect(entry).toBeDefined();
    const instructions: unknown = JSON.parse(entry!.slice('developer_instructions='.length));
    expect(instructions).toBe(buildAgentInstructions({ resume }));
    expect(instructions).toContain(resume ? 'Это продолжение предыдущего диалога.' : 'Твоя задача передана');
    expect(instructions).not.toMatch(/⟦|ВЫРАЖЕНИЕ|\$\{/);
    expect(built.stdin).toBe(request.prompt);
  });

  it('ephemeral только явным запросом, resume не может быть ephemeral', () => {
    expect(buildCodexArgs(firstRequest(CWD)).args).not.toContain('--ephemeral');
    expect(buildCodexArgs(firstRequest(CWD, { persistSession: false })).args).toContain('--ephemeral');
    expect(() => buildCodexArgs({ ...resumeRequest(CWD), persistSession: false })).toThrow();
  });

  it.each([
    { ...firstRequest(CWD), thread: { adapter: 'codex', threadId: THREAD } },
    { ...resumeRequest(CWD), thread: undefined },
    { ...resumeRequest(CWD), thread: { adapter: 'claude', threadId: THREAD } },
    { ...resumeRequest(CWD), thread: { adapter: 'codex', threadId: '--last' } },
    { ...resumeRequest(CWD), thread: { adapter: 'codex', threadId: '' } },
  ])('чужая/отсутствующая история и ID первого хода отклоняются: %j', value => {
    expect(() => buildCodexArgs(invalid(value))).toThrow();
  });

  it('неподдерживаемый maxTurns не игнорируется', () => {
    expect(() => buildCodexArgs(firstRequest(CWD, { maxTurns: 1 }))).toThrow();
  });

  it.each(['--model=other', 'model\n-c approval_policy=never', 'model\0hidden'])('некорректная модель %j отклоняется', model => {
    expect(() => buildCodexArgs(firstRequest(CWD, { model }))).toThrow();
  });

  it('allowlist сохраняет штатные пути и удаляет инъекции/секреты приложения', () => {
    const result = buildCodexEnv({
      HOME: '/existing-home', CODEX_HOME: '/existing-codex-home', PATH: '/node/bin:/usr/bin', LANG: 'ru_RU.UTF-8',
      NODE_OPTIONS: '--require /tmp/injection', DYLD_INSERT_LIBRARIES: 'injection', HTTP_PROXY: 'http://example.invalid',
      APP_SECRET: 'secret', OPENAI_BASE_URL: 'https://example.invalid', LC_ALL: 'bad\0value',
    });
    expect(result).toEqual({ HOME: '/existing-home', CODEX_HOME: '/existing-codex-home', PATH: '/node/bin:/usr/bin', LANG: 'ru_RU.UTF-8' });
  });
});

describe('Codex профиль: требования отдельно от доказательств их исполнения', () => {
  it('валидный профиль не даёт production-ready даже с полными synthetic capabilities', async () => {
    const request = firstRequest(CWD);
    expect(validateCodexProfile(request.profile, CWD)).toEqual([]);
    const built = buildCodexArgs(request);
    const value = await createCodexProductionAdmission()({ request, detection: detection('/synthetic/codex'), args: built.args, env: built.env });
    // Source-review ограничен встроенным exec-маршрутом 0.163.0; остальные требования остаются unconfirmed.
    expect(value).toMatchObject({ status: 'unsupported', reason: 'cli_unsupported' });
    expect(value.requirements).toEqual(expect.arrayContaining([
      expect.objectContaining({ requirement: 'reads_closed', status: 'unsupported', code: 'closed_read_mechanism_unavailable',
        sourceReview: expect.objectContaining({ scope: 'builtin_exec', binaryCorrespondence: 'unconfirmed' }) }),
      expect.objectContaining({ requirement: 'shell_forbidden', status: 'unconfirmed' }),
      expect.objectContaining({ requirement: 'project_extensions_disabled', status: 'unconfirmed' }),
      expect.objectContaining({ requirement: 'user_extensions_disabled', status: 'unconfirmed' }),
    ]));
    expect(checkCodexAdmission(value).error).toBe('profile_unsupported');
  });

  it.each([
    undefined, { mode: 'read-only', tools: ['Read', 'Glob', 'Grep'] },
    { ...profile(CWD), kind: 'practical-local-v1' },
    { ...profile(CWD), sandbox: 'workspace-write' },
    { ...profile(CWD), approvalPolicy: 'on-request' },
    { ...profile(CWD), requires: [] },
    { ...profile(CWD), workspaceRoot: '/foreign-workspace' },
    { ...profile(CWD), tools: ['Bash'] },
  ])('чужой/ослабленный профиль отклоняется: %j', value => {
    expect(validateCodexProfile(value, CWD).length).toBeGreaterThan(0);
  });

  it('доверие проекту обязательно и не заменяется tools', () => {
    expect(validateCodexProfile({ ...profile(CWD), projectTrust: 'untrusted' }, CWD)).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'practical_admission_blocked' }),
    ]));
  });

  it('явный synthetic ready проверяет маршрутизацию, не реальную политику', () => {
    expect(checkCodexAdmission(SYNTHETIC_ADMISSION).error).toBeUndefined();
  });

  it.each([undefined, {}, { status: 'ready', detail: 'synthetic', confirmed: [], limitations: [] },
    { ...SYNTHETIC_ADMISSION, limitations: [] }, { ...SYNTHETIC_ADMISSION, confirmed: [] },
    { status: 'blocked', reason: 'invented', detail: 'synthetic' },
  ])('unknown/неполный допуск не становится ready: %j', value => {
    expect(checkCodexAdmission(value).error).toBe('practical_admission_blocked');
  });
});
