import { mkdtemp, realpath, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCodexAppServerAdapter } from '../../src/adapters/codex/app-server.ts';
import type { CodexAppServerRequest } from '../../src/adapters/codex/app-server-contracts.ts';
import { appServerArgs, inspectAppServerConfig } from '../../src/adapters/codex/app-server-policy.ts';
import { object } from '../../src/adapters/codex/rpc.ts';
import type { AgentEvent, AgentRun } from '../../src/core/ports/agent.ts';
import { rpcConfig, rpcDouble, RPC_THREAD } from '../helpers/codex/rpc-double.ts';
import { processResult, cleanCompletion } from '../helpers/codex/process-double.ts';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup(doubleOptions: Parameters<typeof rpcDouble>[0] = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'vs-rpc-unit-'))); roots.push(root);
  const cwd = join(root, 'project'), home = join(root, 'home'); await mkdir(cwd); await mkdir(home);
  const env = { HOME: home, PATH: '/usr/bin:/bin' };
  const request: CodexAppServerRequest = { sessionId: 'session', turnId: 'turn', participantId: 'agent', workspaceId: 'workspace',
    cwd, prompt: 'Задача пользователя', env, resume: false, profile: { kind: 'codex-app-server-read-v1', mode: 'read-only', sandbox: 'named-profile',
      approvalPolicy: 'never', workspaceRoot: cwd, projectTrust: 'trusted',
      requires: ['shell_sandboxed', 'reads_scoped', 'writes_forbidden', 'project_extensions_disabled', 'user_extensions_disabled'] } };
  const fake = rpcDouble(doubleOptions);
  let detects = 0;
  const adapter = createCodexAppServerAdapter({ env, interactiveRunner: fake.runner, timeoutMs: 1000, stopGraceMs: 20,
    detect: async () => { detects++; return { status: 'available', binaryPath: process.execPath, version: '0.163.0', auth: 'authenticated',
      capabilities: { appServer: true, strictConfig: true, loginStatus: true }, unavailable: [] }; } });
  return { root, cwd, home, env, request, adapter, fake, detects: () => detects };
}
async function collect(run: AgentRun) {
  const events: AgentEvent[] = []; for await (const event of run.events) events.push(event);
  const result = await run.done; expect(events.filter(e => e.type === 'run_finished')).toHaveLength(1);
  expect(events.at(-1)).toMatchObject({ type: 'run_finished', result }); return { result, events };
}
describe('Codex app-server: контракт адаптера', () => {
  it('сначала проверяет конфигурацию, затем передаёт инструкцию и начинает ход', async () => {
    const s = await setup(); const { result, events } = await collect(await s.adapter.start(s.request));
    expect(result).toMatchObject({ kind: 'success', text: 'Ответ', stopAccepted: false });
    expect(s.fake.calls.map(c => c.method)).toEqual(['initialize', 'initialized', 'config/read', 'thread/start', 'thread/inject_items', 'turn/start']);
    expect(JSON.stringify(s.fake.requests)).not.toContain(s.request.prompt);
    expect(events.some(e => e.type === 'text' && e.mode === 'delta')).toBe(true);
  });
  it('продолжение использует тот же ID, новую инструкцию и монотонные события', async () => {
    const s = await setup(); const first = await collect(await s.adapter.start(s.request));
    const second = await collect(await s.adapter.start({ ...s.request, resume: true, thread: { adapter: 'codex', threadId: RPC_THREAD }, turnId: 'next' }));
    expect(second.result.kind).toBe('success');
    expect(s.fake.calls.filter(c => c.method === 'thread/inject_items').map(c => JSON.stringify(c.params))).toEqual([
      expect.stringContaining('Твоя задача передана'), expect.stringContaining('Это продолжение предыдущего диалога')]);
    expect(s.fake.calls.filter(c => c.method === 'thread/resume')).toHaveLength(1);
    expect(second.events[0]!.seq).toBeGreaterThan(first.events.at(-1)!.seq);
  });
  it.each(['missing', 'foreign', 'binding'])('отклоняет %s историю до диагностики', async kind => {
    const s = await setup();
    if (kind === 'binding') await collect(await s.adapter.start(s.request));
    const before = s.detects();
    const invalid = { ...s.request, resume: true, workspaceId: kind === 'binding' ? 'foreign' : s.request.workspaceId,
      thread: kind === 'missing' ? undefined : { adapter: kind === 'foreign' ? 'claude' : 'codex', threadId: RPC_THREAD } } as unknown as CodexAppServerRequest;
    expect((await collect(await s.adapter.start(invalid))).result).toMatchObject({ kind: 'error', reason: 'invalid_request' });
    expect(s.detects()).toBe(before);
  });
  it('Stop прерывает активный ход через RPC и подтверждает выход', async () => {
    const s = await setup({ hang: true }); const run = await s.adapter.start(s.request);
    const events: AgentEvent[] = []; let stopping: Promise<void> | undefined;
    for await (const event of run.events) { events.push(event); if (event.type === 'text') stopping = run.interrupt(); }
    await stopping;
    expect(await run.done).toMatchObject({ kind: 'interrupted', stopAccepted: true, completion: { process: { state: 'exited' } } });
    expect(s.fake.calls.some(c => c.method === 'turn/interrupt')).toBe(true);
    expect(events.filter(e => e.type === 'run_finished')).toHaveLength(1);
  });
  it('Stop до запуска не создаёт процесс', async () => {
    const s = await setup(); const run = await s.adapter.start(s.request); const stop = run.interrupt();
    expect((await collect(run)).result.kind).toBe('interrupted'); await stop; expect(s.fake.requests).toHaveLength(0);
  });
  it('deadline прекращает зависший RPC', async () => {
    const s = await setup({ stallAt: 'initialize' });
    expect((await collect(await s.adapter.start(s.request))).result).toMatchObject({ kind: 'error', reason: 'timeout' });
  });
  it.each(['config/read', 'thread/start', 'thread/inject_items', 'turn/start'])('ошибка %s не теряет terminal и не раскрывает сообщение CLI', async errorAt => {
    const s = await setup({ errorAt }); const run = await s.adapter.start(s.request); const result = await collect(run);
    expect(result.result.kind).toBe('error'); expect(JSON.stringify([result, run.diagnostics])).not.toContain('SECRET');
    expect(s.fake.calls.at(-1)?.method).toBe(errorAt);
  });
  it.each(['foreign_thread', 'foreign_turn', 'unknown_tool', 'server_request', 'duplicate_response'])('отклоняет нарушение протокола %s', async kind => {
    const s = await setup({ mutate: message => {
      if (message.method === 'item/completed') {
        const p = object(message.params)!;
        if (kind === 'foreign_thread') p.threadId = 'foreign';
        if (kind === 'foreign_turn') p.turnId = 'foreign';
        if (kind === 'unknown_tool') object(p.item)!.type = 'mcpToolCall';
        if (kind === 'server_request') message.id = 'approval';
        if (kind === 'duplicate_response') return { id: 1, result: {} };
      }
      return message;
    } });
    expect((await collect(await s.adapter.start(s.request))).result.kind).toBe('error');
  });
  it('чистый ответ не заменяет подтверждённый lifecycle', async () => {
    const s = await setup({ completion: processResult(cleanCompletion({ stdout: 'forced_closed' })) });
    expect((await collect(await s.adapter.start(s.request))).result.kind).toBe('error');
  });
  it('ошибка kill остаётся в completion', async () => {
    const s = await setup({ errorAt: 'thread/start', stopError: true });
    const { result } = await collect(await s.adapter.start(s.request)); expect(result.completion.issues).toContainEqual(expect.objectContaining({ code: 'signal_failed' }));
  });
});
describe('Codex app-server: допуск конфигурации', () => {
  it('выключает все MCP точными ключами без утечки команд и токенов', () => {
    const input = rpcConfig('/project'); object(input.config)!.mcp_servers = { 'name.with.dots': { command: 'SECRET', env: { TOKEN: 'SECRET' } } };
    expect(inspectAppServerConfig(input, '/project')).toEqual({ mcp_servers: { 'name.with.dots': { enabled: false } } });
  });
  it.each(['approval_policy', 'default_permissions', 'web_search', 'model_provider', 'notify', 'developer_instructions'])('блокирует изменённый %s', key => {
    const input = rpcConfig('/project'); object(input.config)![key] = 'conflict'; expect(() => inspectAppServerConfig(input, '/project')).toThrow();
  });
  it.each(['hooks', 'apps', 'plugins', 'multi_agent_v2', 'image_generation', 'retain_client_developer_messages'])('проверяет обязательный переключатель %s', feature => {
    const input = rpcConfig('/project'); const features = object(object(input.config)!.features)!; features[feature] = !features[feature];
    expect(() => inspectAppServerConfig(input, '/project')).toThrow();
  });
  it.each(['computer_use', 'js_repl', 'browser_use', 'unknown_future_tool'])('отклоняет дополнительный канал %s до thread/start', feature => {
    const input = rpcConfig('/project'); object(object(input.config)!.features)![feature] = true;
    expect(() => inspectAppServerConfig(input, '/project')).toThrow();
  });
  it('принимает известные настройки штатной авторизации без расширения инструментов', () => {
    const input = rpcConfig('/project'); Object.assign(object(object(input.config)!.features)!, {
      api_key_cyber_access_programs: true, api_key_model_discovery: true, auth_elicitation: true, mentions_v2: true,
    });
    expect(() => inspectAppServerConfig(input, '/project')).not.toThrow();
  });
  it('блокирует лишний читаемый путь', () => {
    const input = rpcConfig('/project'); const profile = object(object(object(input.config)!.permissions)!['vibestudio-read-v1'])!;
    object(profile.filesystem)!['/foreign'] = 'read'; expect(() => inspectAppServerConfig(input, '/project')).toThrow();
  });
  it('отклоняет user rules до создания процесса', async () => {
    const s = await setup(); await mkdir(join(s.home, '.codex/rules'), { recursive: true }); await writeFile(join(s.home, '.codex/rules/allow.rules'), '');
    expect((await collect(await s.adapter.start(s.request))).result.kind).toBe('error'); expect(s.fake.requests).toHaveLength(0); expect(s.detects()).toBe(0);
  });
  it('отклоняет симлинк rules', async () => {
    const s = await setup(); await mkdir(join(s.cwd, '.codex')); await symlink(s.home, join(s.cwd, '.codex/rules'));
    await expect(appServerArgs(s.cwd, s.env)).rejects.toThrow();
  });
});
