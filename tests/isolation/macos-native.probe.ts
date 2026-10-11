/** MACOS_NATIVE_PROBE=1 sh scripts/with-node.sh node --experimental-transform-types tests/isolation/macos-native.probe.ts
 * Ни CLI, ни модель, ни Keychain не вызываются. Только принадлежащий стенду C helper.
 */
import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createProcessRunner } from '../../src/adapters/process-runner/index.ts';
import { assertSingleLinkTree, nativeProfile, startNativeProbe } from './native/launcher.ts';
import { startBroker } from './native/broker.ts';
import type { ProcessRun } from '../../src/core/ports/process-runner.ts';
if (process.env.MACOS_NATIVE_PROBE !== '1' || process.platform !== 'darwin') throw new Error('Requires opt-in macOS native probe');
const root = realpathSync(mkdtempSync(join(tmpdir(), 'vs-native-')));
const artifacts = mkdtempSync(join(tmpdir(), 'vs-native-evidence-'));
const workspace = join(root, 'worktree'), runtime = join(root, 'runtime'), outside = join(root, 'outside'), git = join(root, 'common-git');
for (const dir of [workspace, runtime, outside, git]) mkdirSync(dir);
writeFileSync(join(workspace, 'README'), 'INSIDE'); writeFileSync(join(outside, 'control'), 'OUTSIDE'); writeFileSync(join(git, 'HEAD'), 'GIT-CONTROL');
const runner = createProcessRunner();
const records: object[] = [];
async function capture(run: ProcessRun) {
  const stdout: Buffer[] = []; let stderrBytes = 0;
  await Promise.all([(async () => { for await (const c of run.stdout) stdout.push(Buffer.from(c)); })(), (async () => { for await (const c of run.stderr) stderrBytes += c.byteLength; })()]);
  return { ...await run.done, stdout: Buffer.concat(stdout).toString(), stderrBytes };
}
const upstream = createServer(socket => { socket.end('LOCAL-UPSTREAM'); });
await new Promise<void>((resolve, reject) => { upstream.once('error', reject); upstream.listen(0, '127.0.0.1', resolve); });
const addr = upstream.address(); assert(addr && typeof addr !== 'string');
const upstream6 = createServer(socket => { socket.end('LOCAL-IPV6'); });
await new Promise<void>((resolve, reject) => { upstream6.once('error', reject); upstream6.listen(0, '::1', resolve); });
const addr6 = upstream6.address(); assert(addr6 && typeof addr6 !== 'string');
let dials = 0;
// Явно локальный transport double; не утверждение доступа к настоящему provider.
const broker = await startBroker(['api.anthropic.com', 'private.invalid'], {
  resolve: async host => [host === 'private.invalid' ? '127.0.0.1' : '93.184.216.34'],
  dial: () => { dials++; return connect({ host: '127.0.0.1', port: addr.port }); },
});
try {
  linkSync(join(outside, 'control'), join(workspace, 'alias'));
  assert.throws(() => assertSingleLinkTree(workspace));
  rmSync(join(workspace, 'alias')); // Только собственный alias стенда.
  records.push({ name: 'preexisting-hardlink-rejected', passed: true });
  const helper = join(root, 'descendant');
  writeFileSync(join(root, 'descendant.c'), `#include <unistd.h>\n#include <fcntl.h>\n#include <stdio.h>\n#include <errno.h>\nint main(int n,char**v){ if(n!=2)return 3; pid_t p=fork(); if(p<0)return 4; if(p==0){if(setsid()<0){ int e=errno;int f=open(v[1],O_CREAT|O_WRONLY,0600);if(f>=0){dprintf(f,"SETSID_ERRNO_%d",e);close(f);}_exit(5);} close(0);close(1);close(2);sleep(1); int f=open(v[1],O_CREAT|O_WRONLY,0600); if(f<0)_exit(6); write(f,"ESCAPED",7);close(f);_exit(0);} puts("READY");fflush(stdout); for(;;)pause(); }\n`);
  const compiled = await capture(runner.start({ executable: '/usr/bin/cc', args: [join(root, 'descendant.c'), '-o', helper], cwd: root, env: { PATH: '/usr/bin:/bin', TMPDIR: root }, stdin: '', timeoutMs: 10000, maxQueueBytes: 65536 }));
  assert.equal(compiled.exitCode, 0, 'compile own helper');
  const profile = nativeProfile(workspace, runtime, [outside, git], broker.port, [helper]);
  writeFileSync(join(artifacts, 'profile.redacted.sb'), profile.split(root).join('<STAND>'));
  async function probe(name: string, executable: string, args: string[], stdin = '') {
    const result = await capture(startNativeProbe(runner, profile, broker.port, { executable, args, cwd: workspace, env: {}, stdin, timeoutMs: 4000, stopGraceMs: 200, drainTimeoutMs: 300, maxQueueBytes: 65536 }));
    records.push({ name, ...result }); assert.equal(result.error, undefined, name); return result;
  }
  assert.equal((await probe('inside-read', '/bin/cat', [join(workspace, 'README')])).stdout, 'INSIDE');
  assert.notEqual((await probe('outside-read-denied', '/bin/cat', [join(outside, 'control')])).exitCode, 0);
  assert.notEqual((await probe('common-git-write-denied', '/usr/bin/touch', [join(git, 'HEAD')])).exitCode, 0);
  assert.equal((await probe('runtime-write', '/usr/bin/touch', [join(runtime, 'ok')])).exitCode, 0);
  assert.notEqual((await probe('new-external-hardlink-denied', '/bin/ln', [join(outside, 'control'), join(runtime, 'alias')])).exitCode, 0);
  const nc = (port: number, authority: string, host = '127.0.0.1') => probe(authority, '/usr/bin/nc', ['-w', '1', host, String(port)], `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
  assert.match((await nc(broker.port, 'api.anthropic.com:443')).stdout, /200 Connection Established[\s\S]*LOCAL-UPSTREAM/);
  assert.match((await nc(broker.port, 'evil.invalid:443')).stdout, /403 Forbidden/);
  assert.match((await nc(broker.port, 'private.invalid:443')).stdout, /403 Forbidden/);
  assert.equal(dials, 1);
  assert.notEqual((await nc(addr.port, 'direct-ipv4')).exitCode, 0);
  const ipv6Control = await capture(runner.start({ executable: '/usr/bin/nc', args: ['-6', '-w', '1', '::1', String(addr6.port)], cwd: workspace, env: {}, stdin: '', timeoutMs: 4000 }));
  assert.match(ipv6Control.stdout, /LOCAL-IPV6/);
  records.push({ name: 'ipv6-positive-control-unwrapped', ...ipv6Control });
  assert.notEqual((await nc(addr6.port, 'direct-ipv6', '::1')).exitCode, 0);
  const marker = join(runtime, 'escaped');
  const run = startNativeProbe(runner, profile, broker.port, { executable: helper, args: [marker], cwd: workspace, env: {}, stdin: '', timeoutMs: 5000, stopGraceMs: 100, drainTimeoutMs: 100, maxQueueBytes: 65536 });
  let ready!: () => void;
  const readiness = new Promise<void>(resolve => { ready = resolve; });
  const chunks: Buffer[] = []; let stderrBytes = 0;
  const draining = Promise.all([(async () => { for await (const c of run.stdout) { chunks.push(Buffer.from(c)); if (Buffer.concat(chunks).toString().includes('READY')) ready(); } })(), (async () => { for await (const c of run.stderr) stderrBytes += c.byteLength; })()]);
  await Promise.race([readiness, run.done.then(() => { throw new Error('Helper did not become ready'); })]);
  await run.interrupt(); await draining;
  const stopped = { ...await run.done, stdout: Buffer.concat(chunks).toString(), stderrBytes };
  assert.equal(stopped.signal, 'SIGTERM');
  records.push({ name: 'stop-result', ...stopped });
  const presentAtDone = existsSync(marker);
  for (let i = 0; i < 30 && !existsSync(marker); i++) await delay(100);
  assert.equal(presentAtDone, false); assert.equal(readFileSync(marker, 'utf8'), 'ESCAPED');
  records.push({ name: 'setsid-survives-group-stop-under-same-seatbelt', ...stopped, markerAtDone: presentAtDone, markerAfterDone: true });
  assert.equal(readFileSync(join(git, 'HEAD'), 'utf8'), 'GIT-CONTROL');
} finally {
  await broker.close(); await Promise.all([upstream, upstream6].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  writeFileSync(join(artifacts, 'observations.json'), JSON.stringify({ modelCalls: 0, cliCalls: 0, productionReady: false, transport: 'local-double-no-provider-contact', records }, null, 2));
  rmSync(root, { recursive: true, force: true });
  console.info(`Native-прототип: ${artifacts}; не AccessVerification.`);
}
