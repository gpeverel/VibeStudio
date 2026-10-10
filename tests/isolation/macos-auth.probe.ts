/** Только локальная диагностика --help/auth status, без модели и сети.
 * MACOS_AUTH_PROBE=1 sh scripts/with-node.sh node --experimental-transform-types tests/isolation/macos-auth.probe.ts
 * Это лабораторный профиль для проверки совместимости auth, НЕ isolation backend.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProcessRunner } from '../../src/adapters/process-runner/index.ts';
import { buildClaudeEnv } from '../../src/adapters/claude/args.ts';
if (process.env.MACOS_AUTH_PROBE !== '1' || process.platform !== 'darwin') throw new Error('Нужны macOS и MACOS_AUTH_PROBE=1');
const runner = createProcessRunner();
const root = realpathSync(mkdtempSync(join(tmpdir(), 'vs-auth-probe-')));
const artifacts = mkdtempSync(join(tmpdir(), 'vs-auth-evidence-'));
const cli = realpathSync('/opt/homebrew/bin/claude');
const config = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
const sbpl = [
  '(version 1)', '(allow default)',
  '(deny network*)', '(deny file-write*)', '(deny file-read*)',
  '(allow file-read-metadata (vnode-type DIRECTORY))',
  '(allow file-read* (literal "/") (subpath "/System/Library") (subpath "/usr/lib") (subpath "/usr/bin") (subpath "/bin"))',
  '(allow file-read* (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))',
  `(allow file-read* (literal ${JSON.stringify(cli)}) (literal ${JSON.stringify(join(homedir(), '.claude.json'))}) (literal ${JSON.stringify(join(config, '.credentials.json'))}))`,
  `(allow file-read* file-write* (subpath ${JSON.stringify(root)}))`,
].join('\n');
const results: object[] = [];
try {
  for (const args of [['--help'], ['--safe-mode', '--restricted', 'auth', 'status']]) {
    const run = runner.start({ executable: '/usr/bin/sandbox-exec', args: ['-p', sbpl, cli, ...args], cwd: root,
      env: buildClaudeEnv(process.env), stdin: '', timeoutMs: 10_000, stopGraceMs: 1_000, drainTimeoutMs: 1_000, maxQueueBytes: 65_536 });
    const parts: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    await Promise.all([
      (async () => { for await (const c of run.stdout) { stdoutBytes += c.byteLength; if (stdoutBytes <= 65_536) parts.push(Buffer.from(c)); else await run.kill(); } })(),
      (async () => { for await (const c of run.stderr) stderrBytes += c.byteLength; })(),
    ]);
    const done = await run.done;
    // Полный stdout/stderr не сохраняется: auth status может содержать email/account.
    let authenticated: boolean | null = null;
    let authMethod: string | null = null;
    if (args.includes('auth') && stdoutBytes <= 65_536) {
      try {
        const parsed = JSON.parse(Buffer.concat(parts).toString('utf8')) as { loggedIn?: unknown; authMethod?: unknown };
        if (typeof parsed.loggedIn === 'boolean') authenticated = parsed.loggedIn;
        if (parsed.authMethod === 'claude.ai' || parsed.authMethod === 'api_key' || parsed.authMethod === 'none') authMethod = parsed.authMethod;
      } catch { /* Неизвестная форма остаётся неподтверждённой, сырой ответ скрыт. */ }
    }
    results.push({ argv: args, ...done, stdoutBytes, stderrBytes, authenticated, authMethod });
    if (done.exitCode !== 0 || done.signal || done.error) break;
  }
} finally {
  const redacted = sbpl.split(root).join('<STAND>').split(cli).join('<CLI>').split(config).join('<CONFIG>').split(homedir()).join('<HOME>');
  writeFileSync(join(artifacts, 'auth-compatibility.json'), JSON.stringify({
    origin: 'local-nonmodel-auth-diagnostic', modelCalls: 0, results, profile: redacted,
    productionReady: false, limitations: ['All non-file/non-network operations allowed, including Mach IPC', 'No token refresh/network tested', 'No effective managed policy attestation', 'No runtime-state writes tested'],
  }, null, 2));
  rmSync(root, { recursive: true, force: true });
  console.info(`Безопасные метаданные auth-пробы: ${artifacts}; raw stdout/stderr скрыты, это НЕ AccessVerification.`);
}
