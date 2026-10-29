import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openSqliteStorage } from '../../src/adapters/store/index.ts';
import { createSoloAgents, ownHistory } from '../../src/main/solo-agents.ts';
import type { AgentRun, AgentRunRequest } from '../../src/core/ports/agent.ts';
import type { CodexAppServerRequest } from '../../src/adapters/codex/app-server-contracts.ts';
import { baseWrite, participant, turn, workspace } from '../store/records.ts';

const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
const id = '1949c706-7043-414d-a949-3c4e1156b352';
function inertRun(): AgentRun {
  return { events: (async function* () {})(), interrupt: async () => undefined, kill: async () => undefined, diagnostics: [],
    done: Promise.resolve({ kind: 'error', reason: 'binary_missing', detail: 'synthetic', stopAccepted: false,
      completion: { process: { state: 'not_started' }, stdout: 'not_started', stderr: 'not_started', wait: 'settled', issues: [], signals: [], descendants: 'not_guaranteed' } }) };
}
async function fixture(cli: 'claude' | 'codex') {
  const root = await mkdtemp(join(tmpdir(), 'solo-bridge-'));
  const storage = openSqliteStorage(join(root, 'app.sqlite'));
  closes.push(async () => { storage.close(); await rm(root, { recursive: true, force: true }); });
  const member = participant('session-1', 'workspace-session-1', cli), area = workspace();
  storage.store.commit(baseWrite({ participants: [member] }));
  const claudeRequests: AgentRunRequest[] = [], codexRequests: CodexAppServerRequest[] = [];
  const bridge = createSoloAgents({ store: storage.store,
    claude: { detect: async () => { throw new Error('not requested'); }, start: async request => { claudeRequests.push(request); return inertRun(); } },
    codex: { detect: async () => { throw new Error('not requested'); }, start: async request => { codexRequests.push(request); return inertRun(); } },
  });
  return { root, storage, member, area, bridge, claudeRequests, codexRequests };
}
it.each(['claude', 'codex'] as const)('композиция закрепляет %s и использует только его профиль/историю', async cli => {
  const f = await fixture(cli), first = turn('turn-1', 1, 'operation');
  await f.bridge.start({ participant: f.member, workspace: f.area, turn: first });
  const resumed = { ...f.member, agentSessionId: id, context: 'available' as const };
  f.storage.store.commit({ participants: [resumed] });
  await f.bridge.start({ participant: resumed, workspace: f.area, turn: { ...first, id: 'turn-2', seq: 2, conversation: 'continue' } });
  if (cli === 'claude') {
    expect(f.codexRequests).toHaveLength(0);
    expect(f.claudeRequests[0]).toMatchObject({ resume: false, profile: { kind: 'practical-local-v1', tools: ['Read', 'Glob', 'Grep'] } });
    expect(f.claudeRequests[1]).toMatchObject({ resume: true, agentSessionId: id });
  } else {
    expect(f.claudeRequests).toHaveLength(0);
    expect(f.codexRequests[0]).toMatchObject({ resume: false, profile: { kind: 'codex-app-server-read-v1', sandbox: 'named-profile', approvalPolicy: 'never' } });
    expect(f.codexRequests[1]).toMatchObject({ resume: true, thread: { adapter: 'codex', threadId: id } });
  }
});
it('композиция отказывает чужому cwd и подмене закреплённого адаптера', async () => {
  const f = await fixture('claude'), input = { participant: f.member, workspace: f.area, turn: turn('turn', 1, 'operation') };
  await expect(f.bridge.start({ ...input, workspace: { ...f.area, path: '/foreign' } })).rejects.toMatchObject({ code: 'foreign_entity' });
  await expect(f.bridge.start({ ...input, participant: { ...f.member, cli: 'codex', profile: 'codex-app-server-read-v1' } })).rejects.toMatchObject({ code: 'foreign_entity' });
  expect(f.claudeRequests).toHaveLength(0); expect(f.codexRequests).toHaveLength(0);
});
it.each(['claude', 'codex'] as const)('история %s проверяется по собственному UUID, symlink не даёт resume', async cli => {
  const f = await fixture(cli), member = { ...f.member, agentSessionId: id };
  const dir = cli === 'claude' ? join(f.root, '.claude', 'projects', 'own-workspace') : join(f.root, '.codex', 'sessions', '2026', '10', '29');
  await mkdir(dir, { recursive: true });
  expect(await ownHistory({ HOME: f.root }, member, f.area)).toBe('missing');
  const path = join(dir, cli === 'claude' ? `${id}.jsonl` : `rollout-2026-10-29-${id}.jsonl`);
  await writeFile(path, '{"own":"synthetic"}\n');
  expect(await ownHistory({ HOME: f.root }, member, f.area)).toBe('available');
  await rm(path); const target = join(f.root, 'unrelated'); await writeFile(target, '{}\n'); await symlink(target, path);
  expect(await ownHistory({ HOME: f.root }, member, f.area)).toBe('unknown');
});
