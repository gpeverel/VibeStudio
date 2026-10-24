import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, mkdtempSync, openSync, readSync,
  realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCodexEnv } from '../../src/adapters/codex/args.ts';
import { createProcessRunner } from '../../src/adapters/process-runner/index.ts';
import { buildR2Requests, R2_BUDGET, R2_SOURCE, runPolicyProbe } from '../helpers/codex/policy-probe.ts';

/** Лаборатория без модели; opt-in не заменяет отдельное разрешение пользователя для B. */
const executable = '/Users/nishimata/.nvm/versions/node/v24.15.0/bin/codex';
const native = '/Users/nishimata/.nvm/versions/node/v24.15.0/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex';
const node = '/Users/nishimata/.nvm/versions/node/v24.15.0/bin/node';
const pins = [
  { role: 'wrapper', path: executable, sha256: '61b0194f3bb6534439c8d26a3ed57d0805f84b884588b761795323eeb92fcf70' },
  { role: 'native', path: native, sha256: '8813367285524ac798dd96d1b071aea30d58708c7226fd236cd275cf1cfdee31' },
  { role: 'node', path: node, sha256: '3200fbd9f7fd4410426dd541e10d1ab829d3472f270d743c7fabd1696c03fe32' },
];
const statKey = (path: string): string => {
  const st = statSync(path);
  return [realpathSync(path), st.dev, st.ino, st.size, st.mtimeMs, st.ctimeMs].join(':');
};
function hashFile(path: string): string {
  const fd = openSync(realpathSync(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > 536_870_912) throw new Error('Некорректный файл сценария.');
    const hash = createHash('sha256');
    const bytes = Buffer.alloc(65_536);
    let total = 0;
    let count: number;
    while ((count = readSync(fd, bytes))) {
      total += count;
      if (total > st.size) throw new Error('Файл сценария изменён.');
      hash.update(bytes.subarray(0, count));
    }
    const after = fstatSync(fd);
    if (total !== st.size || after.size !== st.size || after.mtimeMs !== st.mtimeMs) throw new Error('Файл сценария изменён.');
    return hash.digest('hex');
  } finally { closeSync(fd); }
}
async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    // Dry-run: ни чтения установленной CLI, ни tmp, ни ProcessRunner.start.
    writeFileSync(1, JSON.stringify({
      scenario: 'P3-R2', armed: false, executor: 'B', productionAdmission: 'not_assessed', budget: R2_BUDGET,
      commands: buildR2Requests(executable, '<own-tmp>/project', 'vs-p3-r2-' + '0'.repeat(32), {})
        .map(({ executable: command, args: argv, timeoutMs }) => ({ executable: command, argv, timeoutMs })),
    }, null, 2) + '\n');
    return 0;
  }
  if (args.length !== 1 || args[0] !== '--run-p3-r2' || process.env.CODEX_R2_PLAN !== 'P3-R2-2026-10-20'
    || process.env.CODEX_BIN !== executable || process.env.CODEX_API_KEY !== undefined || process.platform !== 'darwin') {
    throw new Error('R2 отключён: необходимы отдельное разрешение B, --run-p3-r2, CODEX_R2_PLAN и закреплённый CODEX_BIN.');
  }
  const env = buildCodexEnv(process.env);
  const identity = new Map<string, string>();
  for (const pin of pins) {
    const before = statKey(pin.path);
    if (hashFile(pin.path) !== pin.sha256 || before !== statKey(pin.path)) throw new Error('CLI или Node отличаются от D02.');
    identity.set(pin.path, before);
  }
  const pathNode = (env.PATH ?? '').split(delimiter).map(dir => join(dir, 'node')).find(existsSync);
  if (!pathNode || realpathSync(pathNode) !== realpathSync(node) || realpathSync(process.execPath) !== realpathSync(node)) {
    throw new Error('Другой Node в процессе или PATH.');
  }
  identity.set('/usr/bin/cc', statKey('/usr/bin/cc'));
  identity.set(R2_SOURCE, statKey(R2_SOURCE));
  const sourceSha256 = hashFile(R2_SOURCE);
  const implementation = [
    ['entry', './codex-policy.probe.ts'],
    ['supervisor', '../helpers/codex/policy-probe.ts'],
    ['completion_export', '../helpers/codex/live-harness.ts'],
    ['runner', '../../src/adapters/process-runner/index.ts'],
    ['queue', '../../src/adapters/process-runner/queue.ts'],
    ['environment', '../../src/adapters/codex/args.ts'],
  ].map(([role, relative]) => {
    const path = fileURLToPath(new URL(relative!, import.meta.url));
    const before = statKey(path);
    const sha256 = hashFile(path);
    if (before !== statKey(path)) throw new Error('Файл сценария изменён.');
    identity.set(path, before);
    return { role, sha256 };
  });
  const evidence = join(mkdtempSync(join(tmpdir(), 'vs-codex-R2-evidence-')), 'results.json');
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  const startedAt = new Date().toISOString();
  try {
    const report = await runPolicyProbe({
      runner: createProcessRunner(), executable, provenance: 'live', env, signal: controller.signal,
      beforeStart: () => {
        try { return [...identity].every(([path, key]) => statKey(path) === key); } catch { return false; }
      },
      checkpoint: value => writeFileSync(evidence, JSON.stringify({
        schemaVersion: 1, startedAt, recordedAt: new Date().toISOString(), expectedVersion: '0.163.0',
        executable: pins.map(({ role, sha256 }) => ({ role, sha256 })), implementation, sourceSha256, budget: R2_BUDGET,
        report: value, p3: 'unconfirmed', execPolicy: 'not_assessed', extensions: 'not_assessed',
        limitations: ['sandbox_command_only', 'runtime_reads_not_audited', 'configuration_layers_not_audited',
          'network_effects_not_attested', 'detached_children_not_guaranteed'],
      }, null, 2) + '\n', { mode: 0o600 }),
    });
    writeFileSync(1, JSON.stringify({ scenario: report.scenario, status: report.status,
      reason: report.reason, attempts: report.attempts, cleanup: report.cleanup, evidence }) + '\n');
    return report.status === 'observed' && report.cleanup === 'removed' ? 0 : 1;
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
let exitCode = 1;
try { exitCode = await main(); } catch (error) {
  // Текст собственных ошибок закрыт; сообщения ОС/CLI с путями и конфигурацией не экспортируются.
  writeFileSync(2, (error instanceof Error && [
    'Некорректный файл сценария.', 'Файл сценария изменён.', 'CLI или Node отличаются от D02.', 'Другой Node в процессе или PATH.',
  ].includes(error.message) ? error.message : 'R2 не запущен либо остановлен: предварительные условия или запись evidence не подтверждены.') + '\n');
} finally {
  // Вывод и evidence записаны синхронно. Живой handle после unconfirmed exit не
  // удерживает сам стенд; выход стенда не подтверждает exit потомка или cleanup.
  process.exit(exitCode);
}
