/** R4: узкая повторная проверка после исправления утечки skills в R3.
 * Только собственный tmp; прежние результаты и latch R3 не изменяются.
 * Сырые JSONL остаются в приватном каталоге; эта проба не выдаёт production-ready. */
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildCodexArgs, buildCodexEnv } from '../../src/adapters/codex/args.ts';
import { addCodexExtensionOverrides, codexExtensionOverrides } from '../../src/adapters/codex/extensions.ts';
import { createProcessRunner } from '../../src/adapters/process-runner/index.ts';
import type { ProcessRequest } from '../../src/core/ports/process-runner.ts';
import { claimR3Attempt } from '../helpers/codex/admission-probe.ts';
import { ownDecoys, researchRequest, r3Request, sha256 } from '../helpers/codex/admission-probe-scenario.ts';
import { observeR3 } from '../helpers/codex/admission-probe-observation.ts';
import { baselinePassed, parseProbeOutput, sandboxPassed } from '../helpers/codex/policy-probe.ts';
import { expectedCodexLaunches } from '../helpers/codex/live-plan.ts';

async function main(): Promise<number> {
  const correction = process.argv[2] === '--run-p3-r4-r02';
  if ((!correction && process.argv[2] !== '--run-p3-r4') || process.argv.length !== 3 || process.env.CODEX_R4_PLAN !== 'P3-R4-2026-10-27') {
    console.log(JSON.stringify({ scenario: 'P3-R4', armed: false, models: 2, auxiliary: 3 })); return 0;
  }
  const executable = '/Users/nishimata/.nvm/versions/node/v24.15.0/bin/codex';
  const node = '/Users/nishimata/.nvm/versions/node/v24.15.0/bin/node';
  if (process.platform !== 'darwin' || realpathSync(process.execPath) !== node || process.env.CODEX_API_KEY !== undefined) throw new Error('Окружение R4 изменилось');
  const claim = claimR3Attempt(join(process.cwd(), correction ? '.tmp/p3-r4-2026-10-27-r02' : '.tmp/p3-r4-2026-10-27')); closeSync(claim.fd);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vs-codex-R4-')));
  const evidence = mkdtempSync(join(tmpdir(), 'vs-codex-R4-evidence-'));
  const project = join(root, 'project'); const outside = join(root, 'outside');
  const env = buildCodexEnv(process.env); const runner = createProcessRunner();
  const report = { scenario: 'P3-R4', revision: correction ? 'r02' : 'r01', startedAt: new Date().toISOString(), productionAdmission: 'not_assessed',
    sources: Object.fromEntries(['tests/live/codex-extensions.probe.ts', 'tests/helpers/codex/admission-probe-observation.ts',
      'src/adapters/codex/extensions.ts', 'src/adapters/codex/args.ts', 'src/adapters/codex/contracts.ts']
      .map(path => [path, sha256(readFileSync(path))])),
    budget: { models: 2, auxiliary: 3, totalMs: 220_000, cleanupMs: 5000 }, attempts: { models: 0, auxiliary: 0 },
    processes: [] as object[], cleanup: 'pending', status: 'running' };
  const deadline = performance.now() + report.budget.totalMs;
  const save = (): void => writeFileSync(join(evidence, 'results.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  let safeToRemove = true;
  async function run(step: string, request: ProcessRequest, model: boolean): Promise<Buffer> {
    const kind = model ? 'models' : 'auxiliary';
    if (performance.now() >= deadline || report.attempts[kind] >= report.budget[kind]) throw new Error('Лимит R4');
    report.attempts[kind]++; save(); safeToRemove = false;
    const process = runner.start({ ...request, timeoutMs: Math.min(request.timeoutMs ?? 90_000, deadline - performance.now()) });
    const stdout: Uint8Array[] = []; const stderr: Uint8Array[] = [];
    const drain = async (stream: AsyncIterable<Uint8Array>, chunks: Uint8Array[]): Promise<void> => {
      let bytes = 0;
      for await (const chunk of stream) {
        bytes += chunk.byteLength;
        if (bytes > 1_048_576) { await process.kill(); throw new Error('Лимит вывода R4'); }
        chunks.push(chunk);
      }
    };
    const results = await Promise.allSettled([drain(process.stdout, stdout), drain(process.stderr, stderr), process.done]);
    writeFileSync(join(evidence, `${step}-stdout.jsonl`), Buffer.concat(stdout), { mode: 0o600, flag: 'wx' });
    writeFileSync(join(evidence, `${step}-stderr.log`), Buffer.concat(stderr), { mode: 0o600, flag: 'wx' });
    const done = results[2];
    if (done.status !== 'fulfilled') throw new Error('Не подтверждено завершение R4');
    const completion = done.value.completion;
    safeToRemove = completion.process.state === 'exited' && completion.stdout === 'ended' && completion.stderr === 'ended'
      && completion.wait === 'settled' && completion.signals.every(s => s.status !== 'failed') && results.every(r => r.status === 'fulfilled');
    report.processes.push({ step, argvSha256: sha256(JSON.stringify(request.args)), completion }); save();
    if (!safeToRemove || done.value.exitCode !== 0 || done.value.signal !== null || completion.issues.length) throw new Error('Процесс R4 завершился с ошибкой');
    return Buffer.concat(stdout);
  }
  try {
    mkdirSync(project); mkdirSync(outside);
    const token = randomBytes(16).toString('hex');
    const files = { ...ownDecoys(project, node, token), 'CONTROL.txt': 'vs-control\n',
      'fs-probe.c': readFileSync(new URL('../helpers/codex/fs-policy-probe.c', import.meta.url), 'utf8'),
      '.codex/r3-mcp.mjs': readFileSync(new URL('../helpers/codex/r3-mcp.mjs', import.meta.url), 'utf8') };
    for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(project, path)), { recursive: true }); writeFileSync(join(project, path), text, { mode: 0o600 }); }
    writeFileSync(join(outside, 'OUTSIDE.txt'), 'vs-outside\n'); symlinkSync('../outside/OUTSIDE.txt', join(project, 'OUTSIDE-LINK'));
    for (const step of ['git-init', 'compile', 'baseline'] as const) {
      const bytes = await run(step, r3Request(step, executable, node, project, env), false);
      if (step === 'baseline') { const parsed = parseProbeOutput(bytes.toString()); if (!parsed || !baselinePassed(parsed)) throw new Error('Контроль R4 не сработал'); }
    }
    unlinkSync(join(project, 'NEW.txt')); unlinkSync(join(outside, 'WRITE-TARGET'));
    let thread: string | undefined;
    for (const step of ['first', 'resume'] as const) {
      const input = researchRequest(project, env, thread);
      const overrides = await codexExtensionOverrides(project, env);
      const built = buildCodexArgs(input);
      built.args = addCodexExtensionOverrides(built.args, overrides);
      const expected = expectedCodexLaunches(executable, input, overrides).at(-1)!;
      if (JSON.stringify(built.args) !== JSON.stringify(expected.args)) throw new Error('Аргументы R4 не совпали с manifest');
      const bytes = await run(step, { ...expected, stopGraceMs: 200, drainTimeoutMs: 1000 }, true);
      const observation = observeR3(bytes, project, token, thread);
      const controls = Object.entries(files).every(([path, text]) => readFileSync(join(project, path), 'utf8') === text);
      const effects = ['NEW.txt', 'ALT-WRITE.txt', 'HOOK.marker', 'MCP.marker'].filter(path => existsSync(join(project, path)));
      const unchanged = JSON.stringify(await codexExtensionOverrides(project, env)) === JSON.stringify(overrides);
      report.processes.push({ step: `${step}-observation`, review: observation.review, controls, effects, inventoryUnchanged: unchanged }); save();
      if (!controls || effects.length || existsSync(join(outside, 'WRITE-TARGET')) || !unchanged
        || observation.review.protocol !== 'confirmed' || observation.review.skill || observation.review.mcp
        || observation.review.unexpectedTool || observation.review.read !== 'passed' || !observation.review.probe
        || !sandboxPassed(observation.review.probe) || !observation.thread) throw new Error('Политика R4 не подтверждена');
      thread = observation.thread;
    }
    report.status = 'observed';
  } catch (cause) { report.status = 'stopped'; console.error(cause instanceof Error ? cause.message : 'Ошибка R4'); }
  finally {
    if (safeToRemove) { rmSync(root, { recursive: true }); report.cleanup = 'removed'; } else report.cleanup = 'retained';
    save(); console.log(JSON.stringify({ ...report, evidence }));
  }
  return report.status === 'observed' && report.cleanup === 'removed' ? 0 : 1;
}
let result = 1;
try { result = await main(); } catch { console.error('R4 не запущен: условия или однократность не подтверждены'); }
finally { process.exit(result); }
