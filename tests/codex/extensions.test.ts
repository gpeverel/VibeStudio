import { mkdtemp, mkdir, writeFile, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addCodexExtensionOverrides, codexExtensionOverrides } from '../../src/adapters/codex/extensions.ts';
import { buildCodexArgs } from '../../src/adapters/codex/args.ts';
import { createCodexProductionAdmission } from '../../src/adapters/codex/profile.ts';
import { createCodexAdapter } from '../../src/adapters/codex/index.ts';
import { detection, sandboxFirstRequest } from '../helpers/codex/requests.ts';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'vs-codex-extensions-'))); roots.push(root);
  const cwd = join(root, 'project'); const home = join(root, 'home');
  await mkdir(cwd); await mkdir(home);
  return { root, cwd, home, env: { HOME: home } };
}
async function file(path: string, content = 'содержимое не должно читаться') {
  await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, content);
}
describe('Codex: проверка и отключение локальных навыков', () => {
  it('отключает проектные, пользовательские и унаследованные навыки точными путями', async () => {
    const { root, cwd, home, env } = await setup();
    const paths = [join(cwd, '.agents/skills/one/SKILL.md'), join(root, '.codex/skills/two/SKILL.md'),
      join(home, '.codex/skills/three/SKILL.md'), join(home, '.agents/skills/four/SKILL.md')];
    for (const path of paths) await file(path);
    const result = await codexExtensionOverrides(cwd, env);
    for (const path of paths) expect(result[1]).toContain(`path=${JSON.stringify(path)},enabled=false`);
    expect(result[0]).toContain(`${JSON.stringify(cwd)}={trust_level="untrusted"}`);
    expect(result.join('')).not.toContain('содержимое');
    expect(await codexExtensionOverrides(cwd, env)).toEqual(result);
  });
  it('обнаруживает добавленный навык между двумя проверками', async () => {
    const { cwd, env } = await setup();
    const before = await codexExtensionOverrides(cwd, env);
    await file(join(cwd, '.agents/skills/late/SKILL.md'));
    expect(await codexExtensionOverrides(cwd, env)).not.toEqual(before);
  });
  it('отказывает при симлинке каталога вместо предположения о его содержимом', async () => {
    const { root, cwd, env } = await setup();
    await mkdir(join(cwd, '.agents')); await symlink(root, join(cwd, '.agents/skills'));
    await expect(codexExtensionOverrides(cwd, env)).rejects.toThrow('extension_inventory_symlink');
  });
  it('отказывает при симлинке родителя каталога навыков', async () => {
    const { root, cwd, env } = await setup();
    const external = join(root, 'external');
    await file(join(external, 'skills/hidden/SKILL.md'));
    await symlink(external, join(cwd, '.agents'));
    await expect(codexExtensionOverrides(cwd, env)).rejects.toThrow('extension_inventory_symlink');
  });
  it.each(['AGENTS.md', 'AGENTS.override.md'])('блокирует пользовательский %s, не меняя HOME', async name => {
    const { cwd, home, env } = await setup(); await file(join(home, '.codex', name));
    await expect(codexExtensionOverrides(cwd, env)).rejects.toThrow('user_instructions_present');
  });
  it('соблюдает отдельный CODEX_HOME', async () => {
    const { root, cwd, env } = await setup(); const codex = join(root, 'cli');
    const path = join(codex, 'skills/own/SKILL.md'); await file(path);
    expect((await codexExtensionOverrides(cwd, { ...env, CODEX_HOME: codex }))[1]).toContain(JSON.stringify(path));
  });
  it('отказывает при слишком глубоком дереве', async () => {
    const { cwd, env } = await setup(); await file(join(cwd, '.agents/skills', ...Array<string>(14).fill('nested'), 'SKILL.md'));
    await expect(codexExtensionOverrides(cwd, env)).rejects.toThrow('extension_inventory_limit');
  });
  it('production проверяет текущий каталог повторно и отклоняет устаревшие аргументы', async () => {
    const { cwd, env } = await setup();
    const request = { ...sandboxFirstRequest(cwd), env: { ...env, PATH: '/usr/bin:/bin' } };
    const built = buildCodexArgs(request);
    const args = addCodexExtensionOverrides(built.args, await codexExtensionOverrides(cwd, request.env));
    const context = { request, args, env: built.env, detection: detection('/synthetic/codex') };
    const assess = createCodexProductionAdmission();
    expect(await assess(context)).toMatchObject({ status: process.platform === 'darwin' && process.arch === 'arm64' ? 'ready' : 'blocked' });
    await file(join(cwd, '.agents/skills/new/SKILL.md'));
    expect(await assess(context)).toMatchObject({ status: 'blocked', reason: 'configuration_conflict' });
    expect(await assess({ ...context, args: [...args.slice(0, -1), '-c', 'skills.config=[]', '-'] }))
      .toMatchObject({ status: 'blocked', reason: 'configuration_conflict' });
  });
  it('production не доверяет подставленному флагу ready и неподтверждённой auth', async () => {
    const { cwd, env } = await setup();
    const request = { ...sandboxFirstRequest(cwd), env: { ...env, PATH: '/usr/bin:/bin' } };
    const built = buildCodexArgs(request);
    const args = addCodexExtensionOverrides(built.args, await codexExtensionOverrides(cwd, request.env));
    const context = { request, args, env: built.env, detection: { ...detection('/synthetic/codex'), auth: 'unknown' as const }, ready: true };
    expect(await createCodexProductionAdmission()(context)).toMatchObject({ status: 'blocked', reason: 'requirement_unconfirmed' });
  });
  it('полный профиль не разрешает resume с неподдерживаемой заменой инструкции', async () => {
    const { cwd, env } = await setup();
    const request = { ...sandboxFirstRequest(cwd), env: { ...env, PATH: '/usr/bin:/bin' }, resume: true as const,
      thread: { adapter: 'codex' as const, threadId: '019a0000-0000-7000-8000-000000000001' } };
    const built = buildCodexArgs(request);
    const args = addCodexExtensionOverrides(built.args, await codexExtensionOverrides(cwd, request.env));
    const result = await createCodexProductionAdmission()({ request, args, env: built.env, detection: detection('/synthetic/codex') });
    expect(result).toMatchObject({ status: 'unsupported', reason: 'cli_unsupported' });
    expect(result.detail).toContain('прежнюю developer-инструкцию');
    const start = vi.fn(() => { throw new Error('Модель не должна запускаться'); });
    const adapter = createCodexAdapter({ env: request.env, runner: { start },
      detect: async () => detection(await realpath(process.execPath)), verifyThread: () => true });
    const run = await adapter.start(request);
    const events = [];
    for await (const event of run.events) events.push(event);
    expect(await run.done).toMatchObject({ kind: 'error', reason: 'profile_unsupported' });
    expect(events.some(event => event.type === 'run_started')).toBe(false);
    expect(start).not.toHaveBeenCalled();
  });
});
