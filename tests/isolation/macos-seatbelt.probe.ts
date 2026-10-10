/** Немодельная лаборатория 0C. Не AccessVerifier и не производственный launcher.
 * MACOS_ISOLATION_PROBE=1 sh scripts/with-node.sh node --experimental-transform-types tests/isolation/macos-seatbelt.probe.ts
 * Нужен запуск вне внешнего sandbox, чтобы проверять собственную границу Seatbelt.
 * Только свои временные файлы и два локальных HTTP-сервера; Claude/Keychain не вызываются.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, symlinkSync, linkSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir, release } from 'node:os';
import { join } from 'node:path';
import { createProcessRunner } from '../../src/adapters/process-runner/index.ts';
import type { ProcessResult } from '../../src/core/ports/process-runner.ts';

if (process.env.MACOS_ISOLATION_PROBE !== '1' || process.platform !== 'darwin') {
  throw new Error('Нужны macOS и MACOS_ISOLATION_PROBE=1; Claude не запускается.');
}
const runner = createProcessRunner();
const root = realpathSync(mkdtempSync(join(tmpdir(), 'vs-seatbelt-')));
const artifacts = mkdtempSync(join(tmpdir(), 'vs-seatbelt-evidence-'));
const workspace = join(root, 'worktree');
const runtime = join(root, 'runtime');
const outside = join(root, 'outside');
const git = join(root, 'main', '.git');
for (const dir of [workspace, runtime, outside, git]) mkdirSync(dir, { recursive: true });
const secret = join(outside, 'control.txt');
const ref = join(git, 'HEAD');
writeFileSync(secret, 'OUTSIDE-CONTROL');
writeFileSync(ref, 'ref: refs/heads/main\n');
writeFileSync(join(workspace, 'README.md'), 'WORKSPACE-CONTROL');
symlinkSync(secret, join(workspace, 'link'));
symlinkSync(secret, join(runtime, 'link'));
linkSync(secret, join(workspace, 'hardlink'));
linkSync(secret, join(runtime, 'hardlink'));
const records: { name: string; exitCode: number | null; signal: string | null; error?: string; stdout: string; stderrBytes: number }[] = [];
const servers: Server[] = [];
const redact = (s: string): string => s.split(root).join('<STAND>').split(process.execPath).join('<NODE>');
const quote = (s: string): string => JSON.stringify(s); // SBPL string, не shell.

async function capture(executable: string, args: string[], env: Record<string, string> = {}): Promise<{ stdout: string; result: ProcessResult; stderrBytes: number }> {
  const run = runner.start({ executable, args, cwd: workspace, env, stdin: '', timeoutMs: 5_000, stopGraceMs: 200, drainTimeoutMs: 300, maxQueueBytes: 65_536 });
  const chunks: Buffer[] = [];
  let stderrBytes = 0;
  await Promise.all([
    (async () => { for await (const c of run.stdout) chunks.push(Buffer.from(c)); })(),
    (async () => { for await (const c of run.stderr) stderrBytes += c.byteLength; })(),
  ]);
  return { stdout: Buffer.concat(chunks).toString('utf8'), result: await run.done, stderrBytes };
}
async function server(): Promise<{ port: number; hits: () => number }> {
  let hits = 0;
  const s = createServer((_req, res) => { hits++; res.end('LOCAL-CONTROL'); });
  servers.push(s);
  await new Promise<void>((resolve, reject) => { s.once('error', reject); s.listen(0, '127.0.0.1', resolve); });
  const address = s.address();
  assert(address && typeof address !== 'string');
  return { port: address.port, hits: () => hits };
}
function profile(port: number): string {
  return [
    '(version 1)', '(deny default)', '(allow process-exec process-fork)',
    '(allow signal (target same-sandbox))', '(allow sysctl-read)',
    '(allow file-read-metadata (vnode-type DIRECTORY))',
    '(allow file-read* (literal "/") (subpath "/System/Library") (subpath "/usr/lib") (subpath "/usr/bin") (subpath "/bin"))',
    '(allow file-read* (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))',
    `(allow file-read* (subpath ${quote(workspace)}) (subpath ${quote(runtime)}))`,
    `(allow file-write* (subpath ${quote(runtime)}))`,
    `(deny file-write* (subpath ${quote(outside)}) (subpath ${quote(git)}) (subpath ${quote(workspace)}))`,
    `(allow network-outbound (remote ip "127.0.0.1:${port}"))`,
  ].join('\n');
}
let outcome = 'failed';
try {
  const allowed = await server();
  const denied = await server();
  const sbpl = profile(allowed.port);
  writeFileSync(join(artifacts, 'profile.redacted.sb'), redact(sbpl));
  const probe = async (name: string, executable: string, args: string[], sandboxed = true) => {
    const r = await capture(sandboxed ? '/usr/bin/sandbox-exec' : executable, sandboxed ? ['-p', sbpl, executable, ...args] : args);
    records.push({ name, ...r.result, stdout: redact(r.stdout), stderrBytes: r.stderrBytes });
    assert.equal(r.result.error, undefined, name);
    assert.equal(r.result.signal, null, name);
    return r;
  };
  const allowedRead = await probe('read-inside-positive', '/bin/cat', [join(workspace, 'README.md')]);
  assert.equal(allowedRead.result.exitCode, 0);
  assert.equal(allowedRead.stdout, 'WORKSPACE-CONTROL');
  assert.notEqual((await probe('read-outside-negative', '/bin/cat', [secret])).result.exitCode, 0);
  assert.notEqual((await probe('read-symlink-negative', '/bin/cat', [join(workspace, 'link')])).result.exitCode, 0);
  assert.equal((await probe('runtime-write-positive', '/usr/bin/touch', [join(runtime, 'created')])).result.exitCode, 0);
  for (const [name, path] of [
    ['workspace-write-negative', join(workspace, 'new')],
    ['protected-write-negative', secret], ['git-write-negative', ref],
    ['runtime-symlink-write-negative', join(runtime, 'link')],
  ]) assert.notEqual((await probe(name!, '/usr/bin/touch', [path!])).result.exitCode, 0);
  const inherited = await probe('child-read-negative', '/bin/sh', ['-c', 'exec /bin/cat "$1"', 'probe', secret]);
  assert.notEqual(inherited.result.exitCode, 0);
  // Проверка hardlink — наблюдение, а не ожидание защиты, которой SBPL не обещает.
  await probe('hardlink-read-observation', '/bin/cat', [join(workspace, 'hardlink')]);
  await probe('hardlink-write-observation', '/bin/sh', ['-c', 'printf CHANGED > "$1"', 'probe', join(runtime, 'hardlink')]);
  const args = (port: number): string[] => ['--silent', '--show-error', '--noproxy', '*', '--max-time', '2', `http://127.0.0.1:${port}/`];
  // Контроль: оба локальных сервера доступны вне исследуемого профиля.
  assert.equal((await probe('network-positive-control', '/usr/bin/curl', args(denied.port), false)).stdout, 'LOCAL-CONTROL');
  const deniedHitsBefore = denied.hits();
  assert.equal((await probe('network-allowed-port', '/usr/bin/curl', args(allowed.port))).stdout, 'LOCAL-CONTROL');
  assert.notEqual((await probe('network-other-port-negative', '/usr/bin/curl', args(denied.port))).result.exitCode, 0);
  assert.equal(denied.hits(), deniedHitsBefore);
  assert.equal(readFileSync(ref, 'utf8'), 'ref: refs/heads/main\n');
  outcome = 'observations-complete';
} finally {
  writeFileSync(join(artifacts, 'observations.json'), JSON.stringify({
    kind: 'laboratory-not-access-verification', outcome, darwinRelease: release(), node: process.version,
    modelCalls: 0, claudeInvocations: 0, keychainQueries: 0,
    profileHash: existsSync(join(artifacts, 'profile.redacted.sb')) ? createHash('sha256').update(readFileSync(join(artifacts, 'profile.redacted.sb'))).digest('hex') : null,
    records, outsideContentAfter: readFileSync(secret, 'utf8'),
    limits: ['No domain proxy tested', 'No native CLI/auth tested', 'System read exceptions', 'Hardlinks only observed', 'No managed policy audit', 'No setsid containment'],
  }, null, 2));
  await Promise.all(servers.map(s => new Promise<void>(resolve => { s.closeAllConnections(); s.close(() => resolve()); })));
  rmSync(root, { recursive: true, force: true });
  console.info(`Немодельные артефакты Seatbelt: ${artifacts}; это НЕ verified/evidence для AccessVerifier.`);
}
