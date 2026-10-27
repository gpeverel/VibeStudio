/** Явно запускаемый конечный набор RPC M1–M5. Никаких synthetic-допусков. */
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createCodexAppServerAdapter } from '../../src/adapters/codex/index.ts';
import type { CodexAppServerRequest } from '../../src/adapters/codex/app-server-contracts.ts';
import type { AppServerBinding } from '../../src/adapters/codex/app-server.ts';
import { buildCodexEnv } from '../../src/adapters/codex/args.ts';
import { object } from '../../src/adapters/codex/rpc.ts';
import type { JsonObject } from '../../src/adapters/codex/rpc.ts';
import { createProcessRunner } from '../../src/adapters/process-runner/index.ts';
import { createInteractiveProcessRunner } from '../../src/adapters/process-runner/interactive.ts';
import type { InteractiveProcessRun } from '../../src/adapters/process-runner/interactive.ts';
import type { ProcessRun, ProcessRequest } from '../../src/core/ports/process-runner.ts';
import type { AgentRun, AgentEvent } from '../../src/core/ports/agent.ts';
import { firstChecks, firstPrompt, RESUME_PROMPT, resumeChecks, POLICY_PROMPT, STOP_PROMPT } from '../helpers/codex/live-plan.ts';
import { safeCodexCompletion } from '../helpers/codex/live-harness.ts';
import type { Observation } from '../helpers/codex/live-harness.ts';
import { baselinePassed, parseProbeOutput } from '../helpers/codex/policy-probe.ts';
import { ownDecoys } from '../helpers/codex/admission-probe-scenario.ts';
import { readOwnRpcRollout } from '../helpers/codex/rpc-rollout-evidence.ts';
import { reviewRpcPolicy } from '../helpers/codex/rpc-policy-evidence.ts';

const revision = process.argv[2];
if (process.env.LIVE !== '1' || process.env.CODEX_RPC_PLAN !== 'P3-RPC-2026-10-27' || !['r01', 'r02'].includes(revision ?? '')) throw new Error('Нужен явный запуск конечного RPC-набора');
mkdirSync('.tmp/p3-app-server', { recursive: true });
writeFileSync(`.tmp/p3-app-server/m-${revision}-latch.json`, JSON.stringify({ models: 4, diagnostics: 12, auxiliary: 3, totalMs: 440000 }), { flag: 'wx', mode: 0o600 });
const root = realpathSync(mkdtempSync(join(tmpdir(), 'vs-codex-rpc-M-'))), project = join(root, 'project'); mkdirSync(project);
const evidence = realpathSync(mkdtempSync(join(tmpdir(), 'vs-codex-rpc-evidence-')));
const rootStat = lstatSync(root);
const env = buildCodexEnv(process.env), node = '/Users/nishimata/.nvm/versions/node/v24.15.0/bin/node';
const executable = '/Users/nishimata/.nvm/versions/node/v24.15.0/bin/codex';
const native = '/Users/nishimata/.nvm/versions/node/v24.15.0/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex';
const sha = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const pins = [[executable, '61b0194f3bb6534439c8d26a3ed57d0805f84b884588b761795323eeb92fcf70'],
  [native, '8813367285524ac798dd96d1b071aea30d58708c7226fd236cd275cf1cfdee31'],
  [node, '3200fbd9f7fd4410426dd541e10d1ab829d3472f270d743c7fabd1696c03fe32']] as const;
// Замкнутый граф локальных TS-импортов: идентичность проверяется перед каждым запуском.
const sources = new Map<string, string>();
function pinSource(path: string): void {
  path = realpathSync(path);
  if (sources.has(path)) return;
  if (!path.startsWith(realpathSync('.') + '/')) throw new Error('Исходник вне рабочей копии');
  const text = readFileSync(path, 'utf8'); sources.set(path, sha(text));
  for (const match of text.matchAll(/(?:from\s*|import\s*)['"]([^'"]+\.ts)['"]/g)) {
    if (match[1]!.startsWith('.')) pinSource(join(dirname(path), match[1]!));
  }
}
pinSource('tests/live/codex-app-server.probe.ts');
const sourceManifest = Object.fromEntries([...sources].map(([path, hash]) => [path.slice(realpathSync('.').length + 1), hash]).sort(([a], [b]) => a!.localeCompare(b!)));
writeFileSync(join(evidence, 'source-manifest.json'), JSON.stringify(sourceManifest, null, 2) + '\n', { mode: 0o600 });
const report = { scenario: 'P3-RPC-M', revision, provenance: 'live', profile: 'codex-app-server-read-v1',
  sourceManifestSha256: sha(JSON.stringify(sourceManifest)), binaryPins: pins.map(([path, sha256]) => ({ path, sha256 })),
  budget: { models: 4, diagnostics: 12, auxiliary: 3, totalMs: 440000 }, attempts: { models: 0, diagnostics: 0, auxiliary: 0 },
  checks: [] as object[], processes: [] as object[], status: 'running', cleanup: 'pending', p3: 'unconfirmed' };
const save = (): void => writeFileSync(join(evidence, 'results.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
const deadline = performance.now() + report.budget.totalMs;
let safe = true, active: AgentRun | undefined, owned: AppServerBinding | undefined;
let label = '', raw: JsonObject[] = [];
const handles = new Set<ProcessRun>();
const runner = createProcessRunner(), interactive = createInteractiveProcessRunner();
function checkLaunch(request: ProcessRequest, model: boolean): void {
  if (performance.now() > deadline || process.env.CODEX_API_KEY !== undefined || realpathSync(process.execPath) !== node) throw new Error('Условия RPC изменились');
  for (const [path, expected] of pins) if (sha(readFileSync(path)) !== expected) throw new Error('Идентичность CLI изменилась');
  const key = model ? 'models' : 'diagnostics';
  if (report.attempts[key] >= report.budget[key]) throw new Error('Исчерпан бюджет RPC');
  for (const [path, hash] of sources) if (sha(readFileSync(path)) !== hash) throw new Error('Исходники изменились после фиксации');
  if (request.executable !== realpathSync(executable) || JSON.stringify(request.env) !== JSON.stringify(env)) throw new Error('Не совпал executable/env');
  if (model && (request.cwd !== project || request.stdin !== '' || JSON.stringify(request.args.slice(0, 4)) !== JSON.stringify(['app-server', '--listen', 'stdio://', '--strict-config']))) throw new Error('Не совпал транспорт');
  report.attempts[key]++; save();
}
function track<T extends ProcessRun>(run: T, request: ProcessRequest, model: boolean): T {
  handles.add(run); const processLabel = label;
  void run.done.then(result => {
    handles.delete(run); const c = result.completion;
    safe &&= c.process.state === 'exited' && c.stdout === 'ended' && c.stderr === 'ended' && c.wait === 'settled' && c.issues.length === 0;
    report.processes.push({ label: processLabel, model, argvSha256: sha(JSON.stringify(request.args)), completion: safeCodexCompletion(c) }); save();
  }, () => { safe = false; }); return run;
}
const adapterOptions = { binaryPath: executable, env, timeoutMs: 95000, stopGraceMs: 2000,
  runner: { start(request: ProcessRequest) { checkLaunch(request, false); return track(runner.start(request), request, false); } },
  interactiveRunner: { start(request: ProcessRequest): InteractiveProcessRun {
    checkLaunch(request, true); const run = track(interactive.start(request), request, true); let configId: unknown;
    const file = join(evidence, `${label}-rpc.jsonl`); writeFileSync(file, '', { flag: 'wx', mode: 0o600 });
    const capture = async function* () { let pending = ''; let bytes = 0; const decoder = new TextDecoder('utf-8', { fatal: true });
      for await (const chunk of run.stdout) {
        bytes += chunk.byteLength; if (bytes > 4194304) { await run.kill(); throw new Error('Лимит raw RPC'); }
        pending += decoder.decode(chunk, { stream: true }); let at: number;
        while ((at = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, at); pending = pending.slice(at + 1); if (!line.trim()) continue;
          const value = object(JSON.parse(line));
          // config/read может содержать секреты: исключён из записи целиком.
          if (value && value.id !== configId) { raw.push(value); appendFileSync(file, JSON.stringify(value) + '\n'); }
        }
        yield chunk;
      }
      pending += decoder.decode(); if (pending.trim()) throw new Error('Незавершённая строка raw RPC');
    };
    return { ...run, stdout: capture(), send: async text => { const value = object(JSON.parse(text)); if (value?.method === 'config/read') configId = value.id; await run.send(text); } };
  } } };
const firstAdapter = createCodexAppServerAdapter(adapterOptions);
const resumedAdapter = createCodexAppServerAdapter({ ...adapterOptions, verifyThread: binding => owned !== undefined && JSON.stringify(binding) === JSON.stringify(owned) });
const sessionId = randomUUID(), workspaceId = randomUUID(), memory = 'MEMORY-' + randomUUID(), marker = 'READ-' + randomUUID();
const token = randomUUID().replaceAll('-', '');
function request(prompt: string): CodexAppServerRequest {
  return { sessionId, turnId: randomUUID(), workspaceId, participantId: 'rpc-acceptance', cwd: project, env, prompt, resume: false, persistSession: true,
    profile: { kind: 'codex-app-server-read-v1', mode: 'read-only', sandbox: 'named-profile', approvalPolicy: 'never', workspaceRoot: project, projectTrust: 'trusted',
      requires: ['shell_sandboxed', 'reads_scoped', 'writes_forbidden', 'project_extensions_disabled', 'user_extensions_disabled'] } };
}
async function scenario(name: string, input: CodexAppServerRequest, stop = false): Promise<Observation> {
  label = name; raw = []; active = await (name === 'M1' ? firstAdapter : resumedAdapter).start(input);
  const events: AgentEvent[] = []; let stopping: Promise<void> | undefined;
  for await (const event of active.events) {
    events.push(event);
    if (stop && !stopping && (event.type === 'text' || event.type === 'tool_started')) stopping = active.interrupt();
  }
  await stopping; const result = await active.done; active = undefined;
  const terminal = events.filter(e => e.type === 'run_finished');
  const observation: Observation = { result, text: events.filter(e => e.type === 'text').map(e => e.text).join(''),
    threadIds: events.filter(e => e.type === 'run_started').map(e => e.agentSessionId),
    toolNames: events.filter(e => e.type === 'tool_started').map(e => e.tool), deniedTools: [], stopAccepted: result.stopAccepted };
  report.checks.push({ label, kind: result.kind, ...(result.kind === 'error' ? { reason: result.reason, detail: result.detail } : {}), terminalCount: terminal.length,
    stopAccepted: result.stopAccepted, completion: safeCodexCompletion(result.completion) }); save();
  if (terminal.length !== 1 || JSON.stringify(terminal[0]?.type === 'run_finished' ? terminal[0].result : null) !== JSON.stringify(result)) throw new Error('Несогласованный terminal');
  return observation;
}
function record(name: string, checks: Record<string, unknown>): void {
  report.checks.push({ label: name, checks }); save();
  if (Object.values(checks).some(value => value !== true && value !== 'passed')) throw new Error(`Не пройдены критерии ${name}`);
}
try {
  writeFileSync(join(project, 'CONTROL.txt'), marker + '\n', { mode: 0o600 });
  report.attempts.auxiliary++; execFileSync('/usr/bin/git', ['-c', 'init.templateDir=', 'init', '--quiet'], { cwd: project, env, timeout: 10000 });
  const m1 = await scenario('M1', request(firstPrompt(memory)));
  record('M1', { success: m1.result.kind === 'success', ...firstChecks(m1, marker, memory) });
  owned = { threadId: m1.threadIds[0]!, sessionId, participantId: 'rpc-acceptance', workspaceId, cwd: project, transport: 'app-server', profile: 'codex-app-server-read-v1' };
  const resumed: CodexAppServerRequest = { ...request(RESUME_PROMPT), resume: true, thread: { adapter: 'codex', threadId: owned.threadId } };
  const m2 = await scenario('M2', resumed);
  record('M2', { success: m2.result.kind === 'success', ...resumeChecks(m2, owned.threadId, memory, true) });
  for (const kind of ['missing', 'foreign', 'binding']) {
    const before = JSON.stringify(report.attempts);
    const invalid = { ...resumed, ...(kind === 'binding' ? { participantId: 'other' } : { thread: kind === 'missing' ? undefined : { adapter: 'claude', threadId: owned.threadId } }) } as unknown as CodexAppServerRequest;
    const result = await scenario('M3-' + kind, invalid);
    record('M3-' + kind, { rejected: result.result.kind === 'error' && result.result.reason === 'invalid_request', noProcesses: before === JSON.stringify(report.attempts) });
  }
  const files = { ...ownDecoys(project, node, token), '.codex/r3-mcp.mjs': readFileSync(new URL('../helpers/codex/r3-mcp.mjs', import.meta.url), 'utf8') };
  for (const [name, content] of Object.entries(files)) { mkdirSync(dirname(join(project, name)), { recursive: true }); writeFileSync(join(project, name), content, { mode: 0o600 }); }
  const source = readFileSync(new URL('../helpers/codex/fs-policy-probe.c', import.meta.url), 'utf8').replace('"vs-control\\n"', JSON.stringify(marker + '\n'));
  writeFileSync(join(project, 'fs-probe.c'), source); mkdirSync(join(root, 'outside')); writeFileSync(join(root, 'outside/OUTSIDE.txt'), 'vs-outside\n');
  symlinkSync('../outside/OUTSIDE.txt', join(project, 'OUTSIDE-LINK'));
  report.attempts.auxiliary++; execFileSync('/usr/bin/cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O0', '-fno-modules', join(project, 'fs-probe.c'), '-o', join(project, 'fs-probe')], { cwd: project, env, timeout: 20000 });
  const probeSha = sha(readFileSync(join(project, 'fs-probe')));
  report.attempts.auxiliary++; const baseline = parseProbeOutput(execFileSync(join(project, 'fs-probe'), [], { cwd: project, env, timeout: 10000 }).toString());
  if (!baseline || !baselinePassed(baseline)) throw new Error('Положительный контроль файловых операций не прошёл');
  rmSync(join(project, 'NEW.txt')); rmSync(join(root, 'outside/WRITE-TARGET'));
  const m4 = await scenario('M4', request(POLICY_PROMPT));
  const turn = object(object(raw.find(row => row.method === 'turn/started')?.params)?.turn)?.id;
  const runtime = readOwnRpcRollout(env.CODEX_HOME ?? join(env.HOME!, '.codex'), m4.threadIds[0] ?? '', String(turn ?? ''), project, token);
  const controls = readFileSync(join(project, 'CONTROL.txt'), 'utf8') === marker + '\n' && sha(readFileSync(join(project, 'fs-probe'))) === probeSha
    && readFileSync(join(root, 'outside/OUTSIDE.txt'), 'utf8') === 'vs-outside\n' && Object.entries(files).every(([name, content]) => readFileSync(join(project, name), 'utf8') === content)
    && !['NEW.txt', 'ALT-WRITE.txt', 'HOOK.marker', 'MCP.marker', '../outside/WRITE-TARGET'].some(name => existsSync(join(project, name)));
  const policy = reviewRpcPolicy(raw, m4.threadIds[0] ?? '', marker, controls, runtime);
  writeFileSync(join(evidence, 'policy-review.json'), JSON.stringify({ runtime, policy, probeSha, baseline }, null, 2), { mode: 0o600 });
  record('M4', { success: m4.result.kind === 'success', ...policy });
  const m5 = await scenario('M5', { ...request(STOP_PROMPT), persistSession: false }, true);
  record('M5', { interrupted: m5.result.kind === 'interrupted', accepted: m5.stopAccepted,
    exited: m5.result.completion.process.state === 'exited', stdout: m5.result.completion.stdout === 'ended', stderr: m5.result.completion.stderr === 'ended', issues: m5.result.completion.issues.length === 0 });
  report.status = 'passed'; report.p3 = 'accepted_rpc_profile';
} catch (cause) { report.status = 'failed'; console.error(cause instanceof Error ? cause.message : 'Ошибка приёмки RPC'); }
finally {
  if (active) await active.kill();
  for (const handle of handles) await handle.kill().catch(() => { safe = false; });
  const current = lstatSync(root);
  if (safe && !handles.size && current.dev === rootStat.dev && current.ino === rootStat.ino && !current.isSymbolicLink()) { rmSync(root, { recursive: true }); report.cleanup = 'removed'; }
  else report.cleanup = 'retained';
  save(); console.log(JSON.stringify({ evidence, ...report }));
}
process.exitCode = report.status === 'passed' && report.cleanup === 'removed' ? 0 : 1;
