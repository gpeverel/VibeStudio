import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, ftruncateSync, fsyncSync, mkdtempSync,
  openSync, readFileSync, readSync, realpathSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createProcessRunner } from '../../src/adapters/process-runner/index.ts';
import { buildCodexEnv } from '../../src/adapters/codex/args.ts';
import { claimR3Attempt, runAdmissionProbe } from '../helpers/codex/admission-probe.ts';
import { R3_BUDGET, R3_STEPS, r3Request } from '../helpers/codex/admission-probe-scenario.ts';
import type { R3Identity } from '../helpers/codex/admission-probe-evidence.ts';
import { R3_IDENTITY_PATHS } from '../helpers/codex/admission-probe-evidence.ts';

const cwd = '/Users/nishimata/Library/Application Support/com.vibeforge.app/data/worktrees/0712ff57-4c40-4d55-b797-62e225b94a6a/session';
const paths = {
  wrapper: '/Users/nishimata/.nvm/versions/node/v24.15.0/bin/codex',
  native: '/Users/nishimata/.nvm/versions/node/v24.15.0/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex',
  node: '/Users/nishimata/.nvm/versions/node/v24.15.0/bin/node',
};
const fixedPins = {
  wrapper: '61b0194f3bb6534439c8d26a3ed57d0805f84b884588b761795323eeb92fcf70',
  native: '8813367285524ac798dd96d1b071aea30d58708c7226fd236cd275cf1cfdee31',
  node: '3200fbd9f7fd4410426dd541e10d1ab829d3472f270d743c7fabd1696c03fe32',
};
const key = (path: string): string => {
  const st = statSync(path);
  return [realpathSync(path), st.dev, st.ino, st.size, st.mtimeMs, st.ctimeMs].join(':');
};
function hashFile(path: string): string {
  const fd = openSync(realpathSync(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > 536_870_912) throw new Error('identity');
    const bytes = Buffer.alloc(65_536); const hash = createHash('sha256'); let total = 0; let count: number;
    while ((count = readSync(fd, bytes))) { total += count; if (total > before.size) throw new Error('identity'); hash.update(bytes.subarray(0, count)); }
    const after = fstatSync(fd);
    if (total !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('identity');
    return hash.digest('hex');
  } finally { closeSync(fd); }
}
async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (!args.length) {
    writeFileSync(1, JSON.stringify({ scenario: 'P3-R3', armed: false, executor: 'B', budget: R3_BUDGET,
      commands: R3_STEPS.map(step => {
        const request = r3Request(step, '<pinned-codex>', '<pinned-node>', '/own-tmp/project', {},
          step === 'resume' ? '019a0000-0000-7000-8000-000000000001' : undefined);
        return { step, executable: request.executable, args: request.args, timeoutMs: request.timeoutMs };
      }), productionAdmission: 'not_assessed' }, null, 2) + '\n');
    return 0;
  }
  if (args.length !== 1 || args[0] !== '--run-p3-r3' || process.env.CODEX_R3_PLAN !== 'P3-R3-2026-10-25'
    || process.env.CODEX_BIN !== paths.wrapper || process.env.CODEX_API_KEY !== undefined || process.platform !== 'darwin'
    || realpathSync(process.cwd()) !== cwd || !/^[a-f0-9]{64}$/.test(process.env.CODEX_R3_REVIEW ?? '')) throw new Error('opt-in');
  const { fd: latch, startedAt } = claimR3Attempt(join(cwd, '.tmp'));
  let evidence: string | undefined; let evidenceFd: number | undefined;
  const controller = new AbortController(); const stop = (): void => controller.abort();
  const saveLatch = (value: object): void => { ftruncateSync(latch, 0); writeSync(latch, JSON.stringify(value) + '\n', 0, 'utf8'); fsyncSync(latch); };
  try {
    const manifestPath = join(cwd, 'tests/fixtures/codex/r3-identity-manifest.json');
    if (hashFile(manifestPath) !== process.env.CODEX_R3_REVIEW) throw new Error('review');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { purpose: string; cwd: string; identity: R3Identity };
    if (manifest.purpose !== 'expected_identity_only' || manifest.cwd !== cwd) throw new Error('manifest');
    const identity = manifest.identity;
    if (Object.keys(identity.files).length !== R3_IDENTITY_PATHS.length || R3_IDENTITY_PATHS.some(path => !identity.files[path])) throw new Error('manifest');
    const snapshots = new Map<string, string>();
    for (const role of ['wrapper', 'native', 'node'] as const) {
      const before = key(paths[role]);
      if (identity.executable[role] !== fixedPins[role] || hashFile(paths[role]) !== fixedPins[role] || key(paths[role]) !== before) throw new Error('installation');
      snapshots.set(paths[role], before);
    }
    for (const [relative, expected] of Object.entries(identity.files)) {
      if (!(R3_IDENTITY_PATHS as readonly string[]).includes(relative)) throw new Error('manifest');
      const path = join(cwd, relative); const before = key(path);
      if (!realpathSync(path).startsWith(cwd + '/') || hashFile(path) !== expected || key(path) !== before) throw new Error('source');
      snapshots.set(path, before);
    }
    snapshots.set(manifestPath, key(manifestPath));
    for (const path of ['/usr/bin/git', '/usr/bin/cc']) snapshots.set(path, key(path));
    const env = buildCodexEnv(process.env);
    const pathNode = (env.PATH ?? '').split(delimiter).map(dir => join(dir, 'node')).find(existsSync);
    if (!pathNode || realpathSync(pathNode) !== realpathSync(paths.node) || realpathSync(process.execPath) !== realpathSync(paths.node)) throw new Error('node');

    evidence = join(mkdtempSync(join(tmpdir(), 'vs-codex-R3-evidence-')), 'results.json');
    evidenceFd = openSync(evidence, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    const report = await runAdmissionProbe({ runner: createProcessRunner(), executable: paths.wrapper, node: paths.node,
      provenance: 'live', env, signal: controller.signal,
      beforeStart: () => { try { return [...snapshots].every(([path, snapshot]) => key(path) === snapshot); } catch { return false; } },
      checkpoint: report => {
        const value = { schemaVersion: 1, scenario: 'P3-R3', expectedVersion: '0.163.0', startedAt,
          recordedAt: new Date().toISOString(), identity, budget: R3_BUDGET, report,
          p3: 'unconfirmed', extensions: 'not_attested', filesystemEffects: 'reported_by_supervisor' };
        ftruncateSync(evidenceFd!, 0); writeSync(evidenceFd!, JSON.stringify(value, null, 2) + '\n', 0, 'utf8'); fsyncSync(evidenceFd!);
        saveLatch({ scenario: 'P3-R3', startedAt, state: report.status, attempts: report.attempts, evidence, cleanup: report.cleanup });
      },
    });
    writeFileSync(1, JSON.stringify({ scenario: report.scenario, status: report.status, reason: report.reason,
      attempts: report.attempts, cleanup: report.cleanup, evidence }) + '\n');
    return report.status === 'observed' && report.cleanup === 'removed' ? 0 : 1;
  } finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    if (evidenceFd !== undefined) closeSync(evidenceFd);
    closeSync(latch);
  }
}
let exitCode = 1;
try { exitCode = await main(); }
catch { writeFileSync(2, 'R3 не запущен либо остановлен: условия, идентичность, однократность или запись evidence не подтверждены. Повтор запрещён.\n'); }
finally { process.exit(exitCode); } // Entrypoint exit is not evidence of child exit/EOF.
