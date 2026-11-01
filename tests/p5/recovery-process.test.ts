import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EventPage, OperationView, SessionView } from '../../src/shared/solo.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const script = resolve('tests/helpers/p5-crash-process.ts');
function run(mode: string, root: string, point: string, effect: string) {
  return spawnSync(process.execPath, ['--experimental-transform-types', script, mode, root, point, effect], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024,
  });
}
function effects(path: string) { return existsSync(path) ? readFileSync(path, 'utf8') : ''; }
async function scenario(point: string, effect: 'agent' | 'setup' | 'create') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vs-p5-crash-'))); roots.push(root);
  const crashed = run('crash', root, point, effect);
  expect(crashed.signal, `status=${crashed.status}; stderr=${crashed.stderr}; stdout=${crashed.stdout}`).toBe('SIGKILL');
  const context = JSON.parse(readFileSync(join(root, 'crash-context.json'), 'utf8')) as { pid: number; sessionId: string; workspacePath: string };
  // A synthetic setup, if already spawned, is finite and only writes its own marker.
  if (effect === 'setup') await new Promise(resolve => setTimeout(resolve, 100));
  const effectPath = effect === 'setup' ? join(context.workspacePath, 'setup-effects.txt')
    : join(root, effect === 'create' ? 'workspace-effects.txt' : 'agent-effects.txt');
  const before = effects(effectPath);
  const restarted = run('recover', root, point, effect);
  expect(restarted.status, restarted.stderr).toBe(0);
  const recovered = JSON.parse(restarted.stdout) as { pid: number; session: SessionView; operation?: OperationView;
    events: EventPage; starts: number; sessions: number; lease: { state: string } };
  expect(recovered.pid).not.toBe(process.pid); expect(recovered.pid).not.toBe(context.pid);
  expect(effects(effectPath)).toBe(before); expect(recovered.starts).toBe(0);
  expect(new Set(recovered.events.events.map(event => event.seq)).size).toBe(recovered.events.events.length);
  return { root, context, before, recovered };
}

describe('P5: recovery новым процессом после настоящего SIGKILL', () => {
  it.each(['after_intent', 'before_effect', 'after_effect', 'before_result', 'after_result'])(
    'create_session: падение %s не вызывает второй createWorkspace', async point => {
      const { context, before, recovered } = await scenario(point, 'create');
      const created = !['after_intent', 'before_effect'].includes(point);
      expect(before).toBe(created ? 'create\n' : '');
      expect(existsSync(join(context.workspacePath, '.git'))).toBe(created);
      expect(recovered.sessions).toBe(1); expect(recovered.operation?.kind).toBe('create_session');
      expect(recovered.session.status).toBe(point === 'after_result' ? 'ready' : 'recovery_required');
      expect(recovered.lease.state).toBe(point === 'after_result' ? 'released' : 'uncertain');
      expect(recovered.session.actions.send).toBe(point === 'after_result');
    });
  it.each(['after_intent', 'before_effect', 'after_effect', 'before_result', 'after_result'])(
    'агент: падение %s не создаёт повторного запуска', async point => {
      const { before, recovered } = await scenario(point, 'agent');
      const expected = point === 'after_intent' ? 'interrupted' : point === 'after_result' ? 'answered' : 'recovery_required';
      expect(recovered.session.status).toBe(expected);
      expect(before).toBe(['after_intent', 'before_effect'].includes(point) ? '' : 'start\n');
      expect(recovered.events.events.filter(event => event.payload.type === 'user_message')).toHaveLength(1);
      if (expected === 'recovery_required') expect(recovered.session.actions.send).toBe(false);
    });
  it.each(['before_commit', 'after_commit'])('state и событие атомарны при падении %s', async point => {
    const { before, recovered } = await scenario(point, 'agent'); expect(before).toBe('');
    if (point === 'before_commit') {
      expect(recovered.session.status).toBe('ready'); expect(recovered.operation).toBeUndefined();
      expect(recovered.events.events.some(event => event.payload.type === 'user_message')).toBe(false);
    } else {
      expect(recovered.session.status).toBe('interrupted'); expect(recovered.operation).toBeDefined();
      expect(recovered.events.events.filter(event => event.payload.type === 'user_message')).toHaveLength(1);
    }
  });
  it.each(['after_intent', 'before_effect', 'after_effect', 'before_result', 'after_result'])(
    'setup: падение %s не повторяет команду после restart', async point => {
      const { before, recovered } = await scenario(point, 'setup');
      // intent_saved is proof that the executor was not called; only later phases are ambiguous.
      expect(recovered.session.status).toBe(point === 'after_result' ? 'ready' : point === 'after_intent' ? 'interrupted' : 'recovery_required');
      if (['after_intent', 'before_effect'].includes(point)) expect(before).toBe('');
      if (['before_result', 'after_result'].includes(point)) expect(before).toBe('setup\n');
      if (point !== 'after_result') expect(recovered.session.actions.send).toBe(false);
    });
});
