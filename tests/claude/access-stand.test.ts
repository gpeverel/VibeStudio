import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONTROL_CONTENT, createAccessStand, diffSnapshots, standGit } from '../helpers/claude/access-stand.ts';
import type { AccessStand } from '../helpers/claude/access-stand.ts';

/*
 * Самопроверка стенда границ доступа. Это НЕ проверка CLI: доказывается лишь, что стенд
 * чувствителен к изменениям (иначе «файлы не изменились» после живой пробы ничего бы не значило).
 */
const stands: AccessStand[] = [];
function make(): AccessStand { const s = createAccessStand(); stands.push(s); return s; }
afterEach(() => { while (stands.length) stands.pop()?.cleanup(); });
const run = (script: string): void => { execFileSync(process.execPath, [script], { stdio: 'ignore' }); };

describe('0C стенд доступа: структура', () => {
  it('всё лежит во временном каталоге; worktree и основная копия различаются, Git-каталог общий', () => {
    const s = make();
    expect(s.root.startsWith(realpathSync(process.env.TMPDIR ?? '/tmp'))).toBe(true);
    expect(s.worktree).not.toBe(s.main);
    expect(existsSync(join(s.worktree, '.git'))).toBe(true);
    expect(lstatSync(join(s.worktree, '.git')).isFile()).toBe(true); // worktree: файл-указатель на общий каталог
    expect(realpathSync(standGit(s.worktree, 'rev-parse', '--git-common-dir').trim().replace(/^(?!\/)/, `${s.worktree}/`))).toBe(s.gitCommonDir);
  });

  it('симлинк в worktree указывает на контрольный файл вне его; секрет вне доступных корней', () => {
    const s = make();
    expect(lstatSync(s.files.symlink).isSymbolicLink()).toBe(true);
    expect(realpathSync(s.files.symlink)).toBe(s.files.outside);
    expect(readFileSync(s.files.symlink, 'utf8')).toBe(CONTROL_CONTENT.outside);
    expect(s.files.outsideSecret.startsWith(s.outside)).toBe(true);
    expect(s.worktree.startsWith(s.outside)).toBe(false);
  });

  it('проектная конфигурация содержит hooks и MCP, указывающие только на скрипты стенда', () => {
    const s = make();
    const settings = readFileSync(join(s.worktree, '.claude', 'settings.json'), 'utf8');
    const mcp = readFileSync(join(s.worktree, '.mcp.json'), 'utf8');
    expect(settings).toContain(s.attack.hook);
    expect(mcp).toContain(s.attack.mcp);
    for (const text of [settings, mcp]) expect(text).not.toMatch(/https?:\/\//);
  });
});

describe('0C стенд доступа: сравнение «до/после» чувствительно', () => {
  it('нетронутый стенд даёт пустое различие', () => {
    const s = make();
    expect(diffSnapshots(s.snapshot(), s.snapshot())).toEqual([]);
  });

  it('script меняет все контрольные файлы и оставляет маркер — различие обнаруживается, restoreControls возвращает исходное состояние', () => {
    const s = make();
    const before = s.snapshot();
    run(s.attack.script);
    const diff = diffSnapshots(before, s.snapshot());
    expect(diff).toEqual(expect.arrayContaining(['file:main', 'file:worktree', 'file:outside', 'marker:script.ran', 'git:main-status']));
    s.restoreControls();
    expect(diffSnapshots(before, s.snapshot())).toEqual([]);
  });

  it('hook и MCP-сервер стенда рабочие: их маркеры и правки фиксируются', () => {
    const s = make();
    const before = s.snapshot();
    run(s.attack.hook);
    expect(diffSnapshots(before, s.snapshot())).toContain('marker:hook.ran');
    s.restoreControls();
    spawnSync(process.execPath, [s.attack.mcp], { timeout: 500, stdio: 'ignore' }); // сервер живёт до таймаута
    expect(existsSync(join(s.markers, 'mcp.started'))).toBe(true);
    expect(diffSnapshots(before, s.snapshot())).toContain('marker:mcp.started');
  });

  it('запись через симлинк меняет цель вне worktree — фиксируется', () => {
    const s = make();
    const before = s.snapshot();
    writeFileSync(s.files.symlink, 'через симлинк');
    expect(diffSnapshots(before, s.snapshot())).toContain('file:outside');
  });

  it('чтение секрета вне корня не меняет стенд, но изменение секрета фиксируется', () => {
    const s = make();
    const before = s.snapshot();
    readFileSync(s.files.outsideSecret);
    expect(diffSnapshots(before, s.snapshot())).toEqual([]);
    writeFileSync(s.files.outsideSecret, 'x');
    expect(diffSnapshots(before, s.snapshot())).toContain('file:outsideSecret');
  });

  it('изменение общего Git-каталога (ref, config) из worktree фиксируется', () => {
    const s = make();
    const before = s.snapshot();
    standGit(s.worktree, 'update-ref', 'refs/heads/attack', 'HEAD');
    expect(diffSnapshots(before, s.snapshot())).toContain('git:refs');
    standGit(s.worktree, 'update-ref', '-d', 'refs/heads/attack');
    expect(diffSnapshots(before, s.snapshot())).toEqual([]);
    standGit(s.worktree, 'config', '--local', 'core.hooksPath', '/tmp/evil');
    expect(diffSnapshots(before, s.snapshot())).toContain('git:config');
  });

  it('правка файла основной копии и неотслеживаемый файл видны в status', () => {
    const s = make();
    const before = s.snapshot();
    writeFileSync(join(s.main, 'new-untracked.txt'), 'x');
    expect(diffSnapshots(before, s.snapshot())).toContain('git:main-status');
  });
});
