import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openEngineStand, must } from './p5-engine.ts';
import { createControlledAgent } from './p5-agent.ts';
import type { OperationRecord } from '../../src/core/ports/store.ts';

const [mode, root, point, effect = 'agent'] = process.argv.slice(2);
if (!root || !['crash', 'recover'].includes(mode ?? '') || !point) throw new Error('Неверный сценарий');
const marker = join(root, 'crash-context.json');
let armed = false;
function crash() { process.kill(process.pid, 'SIGKILL'); }
function observeFault(where: string, operation: OperationRecord): void {
  if (mode !== 'crash' || !armed || where !== point
      || operation.kind !== (effect === 'create' ? 'create_session' : effect === 'setup' ? 'confirm_setup' : 'send_turn')) return;
  if (effect === 'create') writeFileSync(marker, JSON.stringify({ pid: process.pid, sessionId: operation.sessionId,
    workspacePath: stand.store.getWorkspace(operation.workspaceId!)!.path, projectId: operation.projectId }));
  crash();
}
const agent = createControlledAgent({ onStart: () => appendFileSync(join(root, 'agent-effects.txt'), 'start\n') });
const stand = openEngineStand(root, { agent, setup: effect === 'setup',
  fault: observeFault,
  onCreateWorkspace: () => appendFileSync(join(root, 'workspace-effects.txt'), 'create\n'),
  storage: { faultInjector: (where, context) => {
    if (mode === 'crash' && armed && where === point && context.eventTypes.includes('user_message')) crash();
  } },
});
await stand.engine.recover();
if (mode === 'crash') {
  if (effect === 'create') {
    const project = must(await stand.ipc.selectProject(stand.source, { requestId: 'project-once' }));
    if (!project) throw new Error('Не выбран собственный проект');
    armed = true;
    must(await stand.ipc.createSession(stand.source, { requestId: 'create-once', projectId: project.id, cli: 'claude' }));
  } else {
    const session = await stand.create();
    writeFileSync(marker, JSON.stringify({ pid: process.pid, sessionId: session.id, workspacePath: stand.store.getSessionWorkspace(session.id)!.path }));
    armed = true;
    if (effect === 'setup') {
      if (session.setup.decision?.status !== 'needs_consent') throw new Error('Setup не запросил согласие');
      must(await stand.ipc.confirmSetup(stand.source, { requestId: 'setup-once', sessionId: session.id, challengeId: session.setup.decision.challengeId }));
    } else must(await stand.ipc.sendTurn(stand.source, { requestId: 'turn-once', sessionId: session.id, prompt: 'Задача', conversation: 'continue' }));
  }
  await stand.engine.waitForIdle();
  throw new Error(`Точка падения не достигнута: ${point}`);
} else {
  const saved = JSON.parse(readFileSync(marker, 'utf8')) as { sessionId: string; projectId?: string };
  const operation = stand.store.findOperation(effect === 'create' ? 'create-once' : effect === 'setup' ? 'setup-once' : 'turn-once');
  const before = stand.agent.runs.length;
  if (effect === 'agent' && operation) {
    const repeated = must(await stand.ipc.sendTurn(stand.source, { requestId: 'turn-once', sessionId: saved.sessionId, prompt: 'Задача', conversation: 'continue' }));
    if (repeated.id !== operation.id) throw new Error('Повтор создал другую операцию');
  }
  if (effect === 'create' && operation) {
    const repeated = must(await stand.ipc.createSession(stand.source, { requestId: 'create-once', projectId: saved.projectId, cli: 'claude' }));
    if (repeated.id !== operation.id || repeated.sessionId !== saved.sessionId) throw new Error('Повтор создал другую сессию или операцию');
  }
  await stand.engine.waitForIdle();
  const session = must(await stand.ipc.getSession(stand.source, { sessionId: saved.sessionId }));
  const events = must(await stand.ipc.readEvents(stand.source, { sessionId: saved.sessionId, after: 0, limit: 200 }));
  console.log(JSON.stringify({ pid: process.pid, session, operation, events, starts: stand.agent.runs.length - before,
    sessions: stand.store.listSessions().length, lease: stand.store.getLease(session.workspace.id) }));
  await stand.close();
}
