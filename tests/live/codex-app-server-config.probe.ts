/** Конечная немодельная сверка усиленного preflight после M: ни thread, ни turn не создаются. */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appServerArgs, inspectAppServerConfig } from '../../src/adapters/codex/app-server-policy.ts';
import { buildCodexEnv } from '../../src/adapters/codex/args.ts';
import { CodexRpc } from '../../src/adapters/codex/rpc.ts';
import { createInteractiveProcessRunner } from '../../src/adapters/process-runner/interactive.ts';
import { safeCodexCompletion } from '../helpers/codex/live-harness.ts';

if (process.env.LIVE !== '1' || process.env.CODEX_RPC_PLAN !== 'P3-RPC-CONFIG-2026-10-27') throw new Error('Нужен явный запуск немодельной проверки');
writeFileSync('.tmp/p3-app-server/final-config-latch.json', JSON.stringify({ cli: 1, models: 0, timeoutMs: 45000 }), { flag: 'wx', mode: 0o600 });
const sha = (text: string | Uint8Array) => createHash('sha256').update(text).digest('hex');
const accepted = JSON.parse(readFileSync(new URL('../fixtures/codex/observed-0.163.0-app-server-r02.json', import.meta.url), 'utf8'));
for (const pin of accepted.report.binaryPins) if (sha(readFileSync(pin.path)) !== pin.sha256) throw new Error('Идентичность CLI изменилась');
const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'vs-codex-rpc-final-config-'))), env = buildCodexEnv(process.env);
if (process.env.CODEX_API_KEY !== undefined) throw new Error('CODEX_API_KEY не разрешён');
const args = await appServerArgs(cwd, env);
const run = createInteractiveProcessRunner().start({ executable: accepted.report.binaryPins[0].path, args, cwd, env,
  stdin: '', timeoutMs: 45000, stopGraceMs: 1000, drainTimeoutMs: 2000, maxQueueBytes: 1048576 });
const rpc = new CodexRpc(run, () => undefined);
const methods: string[] = [];
let passed = false;
try {
  methods.push('initialize'); await rpc.call('initialize', { clientInfo: { name: 'vibestudio_probe', version: '0.0.0' }, capabilities: { experimentalApi: true } });
  methods.push('initialized'); await rpc.notifyInitialized();
  methods.push('config/read'); inspectAppServerConfig(await rpc.call('config/read', { cwd, includeLayers: false }), cwd);
  passed = true; run.closeInput();
} catch { await run.kill(); }
const result = await rpc.closed, c = result.completion;
const clean = c.process.state === 'exited' && c.stdout === 'ended' && c.stderr === 'ended' && c.wait === 'settled' && c.issues.length === 0;
if (clean) rmSync(cwd, { recursive: true });
const evidence = { provenance: 'live', cli: 1, models: 0, methods, passed: passed && clean && result.exitCode === 0 && !rpc.error,
  policySourceSha256: sha(readFileSync('src/adapters/codex/app-server-policy.ts')), completion: safeCodexCompletion(c), cleanup: clean ? 'removed' : 'retained' };
writeFileSync('tests/fixtures/codex/observed-0.163.0-app-server-config.json', JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence)); process.exitCode = evidence.passed ? 0 : 1;
