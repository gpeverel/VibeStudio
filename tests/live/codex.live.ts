import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync,
  realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCodexAdapter } from '../../src/adapters/codex/index.ts';
import { buildCodexEnv } from '../../src/adapters/codex/args.ts';
import type { CodexRunRequest, CodexThreadBinding } from '../../src/adapters/codex/contracts.ts';
import { createProcessRunner } from '../../src/adapters/process-runner/index.ts';
import { createCodexLiveHarness, M_BUDGET } from '../helpers/codex/live-harness.ts';
import type { Checks, Cleanup, MLabel, Observation } from '../helpers/codex/live-harness.ts';
import { M4CommandCapture } from '../helpers/codex/m4-command-evidence.ts';
import type { M4CommandReadReview } from '../helpers/codex/m4-command-evidence.ts';
import { expectedCodexLaunches, firstChecks, firstPrompt, POLICY_PROMPT, policyChecks,
  RESUME_PROMPT, resumeChecks, STOP_PROMPT } from '../helpers/codex/live-plan.ts';

/** Opt-in не является разрешением пользователя. Реальную команду исполняет только назначенный B. */
if (process.env.LIVE !== '1' || process.env.CODEX_LIVE !== '1' || process.env.CODEX_LIVE_PLAN !== 'P3-M-2026-10-20') {
  throw new Error('Codex M отключён: нужны отдельное разрешение B и LIVE=1 CODEX_LIVE=1 CODEX_LIVE_PLAN=P3-M-2026-10-20.');
}
const executable = '/Users/nishimata/.nvm/versions/node/v24.15.0/bin/codex';
const native = '/Users/nishimata/.nvm/versions/node/v24.15.0/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex';
const node = '/Users/nishimata/.nvm/versions/node/v24.15.0/bin/node';
const pins = [
  { role: 'wrapper', path: executable, sha256: '61b0194f3bb6534439c8d26a3ed57d0805f84b884588b761795323eeb92fcf70' },
  { role: 'native', path: native, sha256: '8813367285524ac798dd96d1b071aea30d58708c7226fd236cd275cf1cfdee31' },
  { role: 'node', path: node, sha256: '3200fbd9f7fd4410426dd541e10d1ab829d3472f270d743c7fabd1696c03fe32' },
];
if (process.env.CODEX_BIN !== executable || process.env.CODEX_API_KEY !== undefined) {
  throw new Error('Executable или источник авторизации отличается от подготовленного сценария.');
}
const env = buildCodexEnv(process.env);
const identity = new Map<string, string>();
let root: string | undefined;
let rootIdentity: string | undefined;
let project: string;
let evidence: string | undefined;
let rootCleanup: 'pending' | 'removed' | 'retained' | 'failed' = 'pending';
let cleanup: Cleanup | undefined;
let resolvedExecutable: string;
let gitInitAttempts = 0;
let thread: CodexThreadBinding | undefined;
let firstObserved = false;
const sessionId = randomUUID();
const workspaceId = randomUUID();
const readMarker = 'READ-' + randomUUID();
const memory = 'MEMORY-' + randomUUID();
const participantId = 'codex-m-acceptance';
const statKey = (path: string): string => {
  const s = statSync(path);
  return [realpathSync(path), s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(':');
};
function hashFile(path: string): string {
  const fd = openSync(realpathSync(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > 536_870_912) throw new Error('Некорректный executable.');
    const hash = createHash('sha256');
    const bytes = Buffer.alloc(65_536);
    let count: number;
    while ((count = readSync(fd, bytes, 0, bytes.length, null))) hash.update(bytes.subarray(0, count));
    const after = fstatSync(fd);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error('Executable изменился при чтении.');
    }
    return hash.digest('hex');
  } finally { closeSync(fd); }
}
const processRunner = createProcessRunner();
let m4Capture: M4CommandCapture | undefined;
let m4Read: M4CommandReadReview | undefined;
const harness = createCodexLiveHarness({ runner: { start(request) {
  const selected = request.args[0] === 'exec' && request.args.includes('--json') && request.stdin === POLICY_PROMPT;
  if (selected && m4Capture) throw new Error('Повтор M4 не разрешён.');
  const run = processRunner.start(request);
  if (!selected) return run;
  m4Capture = new M4CommandCapture(run, readMarker);
  return m4Capture.run;
} }, beforeLaunch: request =>
  request.executable === resolvedExecutable && pins.every(pin => identity.get(pin.path) === statKey(pin.path)) });
/** Оба экземпляра используют production admission по умолчанию. detect/assess не подставляются. */
const adapterOptions = { runner: harness.runner, binaryPath: executable, env,
  timeoutMs: 90_000, stopGraceMs: 2_000, drainTimeoutMs: 2_000, maxQueueBytes: 1_048_576, maxDiagBytes: 16_384,
  parserLimits: { maxLineBytes: 65_536 } };
const firstAdapter = createCodexAdapter(adapterOptions);
const resumedAdapter = createCodexAdapter({ ...adapterOptions,
  verifyThread: binding => thread !== undefined && binding.threadId === thread.threadId && binding.sessionId === thread.sessionId
    && binding.participantId === thread.participantId && binding.workspaceId === thread.workspaceId && binding.cwd === thread.cwd });

function save(): void {
  if (!evidence) return;
  try {
    writeFileSync(evidence, JSON.stringify({
      schemaVersion: 1, scenario: 'P3-M', provenance: 'live', admission: 'production', profile: 'codex-sandbox-read-v1',
      expectedVersion: '0.163.0',
      executable: pins.map(({ role, sha256 }) => ({ role, sha256 })),
      budget: M_BUDGET, auxiliaryProcesses: { gitInit: gitInitAttempts },
      reports: harness.reports, processes: harness.processes, cleanup, rootCleanup, m4Read,
      persistedCliHistory: 'retained', p3: 'unconfirmed',
    }, null, 2) + '\n', { mode: 0o600 });
  } catch { harness.halt(); throw new Error('Не удалось записать безопасное evidence Codex M.'); }
}
function request(prompt: string): CodexRunRequest {
  return { sessionId, turnId: randomUUID(), participantId, workspaceId, cwd: project, prompt, env,
    resume: false, persistSession: true,
    profile: { kind: 'codex-sandbox-read-v1', mode: 'read-only', sandbox: 'named-profile', approvalPolicy: 'never',
      workspaceRoot: project, projectTrust: 'trusted',
      requires: ['shell_sandboxed', 'reads_scoped', 'writes_forbidden', 'project_extensions_disabled', 'user_extensions_disabled'] } };
}
function resumed(prompt: string): CodexRunRequest {
  if (!thread) throw new Error('M1 не сохранил собственную binding; resume не разрешён.');
  return { ...request(prompt), resume: true, thread: { adapter: 'codex', threadId: thread.threadId } };
}
async function probe(label: MLabel, value: CodexRunRequest, inspect: (observed: Observation) => Checks): Promise<void> {
  const report = await harness.runScenario({ label, expected: label.startsWith('M3-') ? [] : expectedCodexLaunches(resolvedExecutable, value),
    start: () => (label === 'M1' ? firstAdapter : resumedAdapter).start(value), inspect });
  save();
  expect(report.outcome, `Codex ${label}: ${report.reason ?? report.outcome}`).toBe('passed');
}
function controlsUnchanged(): boolean {
  const path = join(project, 'CONTROL.txt');
  const st = lstatSync(path);
  if (!st.isFile() || st.size !== Buffer.byteLength(readMarker + '\n')) return false;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    return opened.dev === st.dev && opened.ino === st.ino && opened.size === st.size
      && readFileSync(fd, 'utf8') === readMarker + '\n'
      && !['forbidden-command.marker', 'hook.marker', 'mcp.marker'].some(name => existsSync(join(project, name)));
  } finally { closeSync(fd); }
}

beforeAll(() => {
  for (const pin of pins) {
    const before = statKey(pin.path);
    if (hashFile(pin.path) !== pin.sha256 || before !== statKey(pin.path)) throw new Error('Идентичность CLI отличается от D02.');
    identity.set(pin.path, before);
  }
  resolvedExecutable = realpathSync(executable);
  const pathNode = (env.PATH ?? '').split(delimiter).map(dir => join(dir, 'node')).find(existsSync);
  if (!pathNode || realpathSync(pathNode) !== realpathSync(node) || realpathSync(process.execPath) !== realpathSync(node)) {
    throw new Error('Shebang wrapper получит другой Node.');
  }
  const evidenceDir = mkdtempSync(join(tmpdir(), 'vs-codex-M-evidence-'));
  evidence = join(evidenceDir, 'results.json');
  root = realpathSync(mkdtempSync(join(tmpdir(), 'vs-codex-M-')));
  const st = lstatSync(root); rootIdentity = [st.dev, st.ino].join(':');
  project = join(root, 'project'); mkdirSync(project, { mode: 0o700 });
  writeFileSync(join(project, 'CONTROL.txt'), readMarker + '\n', { mode: 0o600 });
  // Один вспомогательный Git-процесс; системный git, только собственный tmp.
  gitInitAttempts++;
  execFileSync('/usr/bin/git', ['init', '--quiet'], { cwd: project, timeout: 10_000, stdio: 'pipe', env });
  save();
  console.error('Безопасное evidence Codex M: ' + evidence);
});
afterAll(async () => {
  cleanup = await harness.cleanup();
  rootCleanup = root ? 'retained' : 'removed';
  if (root && rootIdentity && cleanup.safeToRemove) {
    try {
      const st = lstatSync(root);
      if (st.isDirectory() && !st.isSymbolicLink() && [st.dev, st.ino].join(':') === rootIdentity && realpathSync(root) === root) {
        rmSync(root, { recursive: true, force: false }); rootCleanup = 'removed';
      }
    } catch { rootCleanup = 'failed'; }
  }
  save();
  expect(cleanup.safeToRemove).toBe(true);
  expect(rootCleanup).toBe('removed');
});

describe('P3 Codex M: production-допуск, отдельное разрешение, без повторов', () => {
  it('M1: чтение, настоящий thread_id и первый контекст', async () => {
    await probe('M1', request(firstPrompt(memory)), observed => {
      const checks = firstChecks(observed, readMarker, memory);
      if (!controlsUnchanged()) checks.read = 'failed';
      firstObserved = checks.thread === 'passed' && checks.memory === 'passed' && checks.instruction === 'passed';
      if (firstObserved) thread = { threadId: observed.threadIds[0]!, sessionId, participantId, workspaceId, cwd: project };
      return checks;
    });
  });
  it('M2: новый экземпляр адаптера восстанавливает собственную историю и новый контекст', async () => {
    await probe('M2', resumed(RESUME_PROMPT), observed => resumeChecks(observed, thread!.threadId, memory, firstObserved));
  });
  it('M3: отсутствующий ID не создаёт новый диалог и не запускает detect', async () => {
    await probe('M3-missing', { ...request('Недопустимый resume'), resume: true,
      thread: { adapter: 'codex', threadId: randomUUID() } }, () => ({}));
  });
  it('M3: ссылка другого адаптера отклоняется до процессов', async () => {
    const value = { ...resumed('Недопустимый resume'), thread: { adapter: 'claude', threadId: thread!.threadId } };
    await probe('M3-foreign', value as unknown as CodexRunRequest, () => ({}));
  });
  it('M3: собственный thread_id с чужой binding отклоняется', async () => {
    await probe('M3-binding', { ...resumed('Недопустимый resume'), participantId: 'foreign-participant' }, () => ({}));
  });
  it('M4: чтение, запрещённое действие и проектные приманки без ложного вывода о политике', async () => {
    const config = join(project, '.codex'); mkdirSync(config, { mode: 0o700 });
    const decoy = join(project, 'extension-decoy.mjs');
    writeFileSync(decoy, 'import { writeFileSync } from "node:fs"; writeFileSync(process.argv[2], "observed");\n');
    const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";
    writeFileSync(join(config, 'hooks.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{
      type: 'command', command: [node, decoy, join(project, 'hook.marker')].map(quote).join(' '),
    }] }] } }));
    writeFileSync(join(config, 'config.toml'), '[mcp_servers.vs_m_decoy]\ncommand = ' + JSON.stringify(node)
      + '\nargs = [' + JSON.stringify(decoy) + ', ' + JSON.stringify(join(project, 'mcp.marker')) + ']\n');
    const value = request(POLICY_PROMPT);
    await probe('M4', value, observed => {
      m4Read = m4Capture?.review(readMarker, observed.threadIds.length === 1 ? observed.threadIds[0] : undefined);
      return policyChecks(observed, readMarker, controlsUnchanged(), value.profile.kind, m4Capture);
    });
  });
  it('M5: Stop после текста/инструмента, один terminal и согласованный done', async () => {
    await probe('M5', { ...request(STOP_PROMPT), persistSession: false }, () => ({}));
  });
});
