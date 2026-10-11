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
const settingsFile = join(root, 'one-run.settings.json');
writeFileSync(settingsFile, JSON.stringify({ enabledPlugins: { 'cc-plugin-agents-md@builtin': false, 'cc-plugin-plugin-authoring@builtin': false } }));
const sbpl = [
  '(version 1)', '(allow default)',
  '(deny network*)', '(deny file-write*)', '(deny file-read*)',
  '(allow file-read-metadata (vnode-type DIRECTORY))',
  '(allow file-read* (literal "/") (subpath "/System/Library") (subpath "/usr/lib") (subpath "/usr/bin") (subpath "/bin"))',
  '(allow file-read* (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))',
  ...(process.env.MACOS_AUTH_NULL === '1' ? ['(allow file-write-data (literal "/dev/null"))'] : []),
  ...(process.env.MACOS_AUTH_ICU === '1' ? ['(allow file-read* (subpath "/usr/share/icu"))'] : []),
  ...(process.env.MACOS_AUTH_KEYCHAIN === '1' ? [`(allow file-read* (subpath ${JSON.stringify(join(homedir(), 'Library/Keychains'))}) (subpath "/Library/Keychains"))`] : []),
  ...(process.env.MACOS_AUTH_PLUGINS === '1' ? [
    `(allow file-read* (literal ${JSON.stringify(join(config, 'settings.json'))}) (literal ${JSON.stringify(join(config, 'plugins/installed_plugins.json'))}))`,
    '(allow file-read* (subpath "/Library/Application Support/ClaudeCode") (subpath "/Library/Managed Preferences"))',
  ] : []),
  `(allow file-read* (literal ${JSON.stringify(cli)}) (literal ${JSON.stringify(join(homedir(), '.claude.json'))}) (literal ${JSON.stringify(join(config, '.credentials.json'))}))`,
  `(allow file-read* file-write* (subpath ${JSON.stringify(root)}))`,
].join('\n');
const results: object[] = [];
try {
  const settings = settingsFile;
  const commands = process.env.MACOS_AUTH_PLUGINS === '1'
    ? [['--safe-mode', '--restricted', '--settings', settings, '--help'],
      ['--safe-mode', '--restricted', '--setting-sources', '', 'plugin', 'list', '--help'],
      ['--safe-mode', '--restricted', '--setting-sources', '', 'plugin', 'list', '--json'],
      ['--safe-mode', '--restricted', '--setting-sources', '', '--settings', settings, 'plugin', 'list', '--json']]
    : [['--help'], ['--safe-mode', '--restricted', 'auth', 'status']];
  for (const args of commands) {
    const run = runner.start({ executable: '/usr/bin/sandbox-exec', args: ['-p', sbpl, cli, ...args], cwd: root,
      env: buildClaudeEnv({ ...process.env, TMPDIR: root }), stdin: '', timeoutMs: 10_000, stopGraceMs: 1_000, drainTimeoutMs: 1_000, maxQueueBytes: 65_536 });
    const parts: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const errors: Buffer[] = [];
    await Promise.all([
      (async () => { for await (const c of run.stdout) { stdoutBytes += c.byteLength; if (stdoutBytes <= 65_536) parts.push(Buffer.from(c)); else await run.kill(); } })(),
      (async () => { for await (const c of run.stderr) { stderrBytes += c.byteLength; if (stderrBytes <= 16_384) errors.push(Buffer.from(c)); } })(),
    ]);
    const done = await run.done;
    // Полный stdout/stderr не сохраняется: auth status может содержать email/account.
    let authenticated: boolean | null = null;
    let authMethod: string | null = null;
    let builtinPlugins: object[] | null = null;
    const helpOptions = args.includes('plugin') && args.includes('--help')
      ? Buffer.concat(parts).toString('utf8').split('\n').filter(line => /^\s+-/.test(line)).map(line => line.trim().split(/\s{2,}/)[0]) : undefined;
    if (args.includes('auth') && stdoutBytes <= 65_536) {
      try {
        const parsed = JSON.parse(Buffer.concat(parts).toString('utf8')) as { loggedIn?: unknown; authMethod?: unknown };
        if (typeof parsed.loggedIn === 'boolean') authenticated = parsed.loggedIn;
        if (parsed.authMethod === 'claude.ai' || parsed.authMethod === 'api_key' || parsed.authMethod === 'none') authMethod = parsed.authMethod;
      } catch { /* Неизвестная форма остаётся неподтверждённой, сырой ответ скрыт. */ }
    }
    if (args.includes('plugin') && stdoutBytes <= 65_536) {
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'));
        const entries = Array.isArray(parsed) ? parsed : null;
        if (entries) builtinPlugins = entries.flatMap((item: unknown) => {
          if (!item || typeof item !== 'object') return [];
          const p = item as Record<string, unknown>;
          const id = typeof p.id === 'string' ? p.id : p.name;
          return typeof id === 'string' && /^cc-plugin-[a-z-]+(?:@builtin)?$/.test(id)
            ? [{ id, enabled: typeof p.enabled === 'boolean' ? p.enabled : null }] : [];
        });
      } catch { /* Неизвестный формат не подменяем подтверждением. */ }
    }
    // Только системная причина --help: не сохраняем auth stdout, env или содержимое файлов.
    const diagnostic = !args.includes('auth') ? Buffer.concat(errors).toString('utf8')
      .split('\n').filter(line => !/^\d+ \|/.test(line) && /(?:^[A-Za-z]*[Ee]rror:|EACCES|EPERM|ENOENT|^\s*(?:syscall|path|code):)/.test(line))
      .map(line => line.split(root).join('<STAND>').split(cli).join('<CLI>').split(homedir()).join('<HOME>')
        .replace(/(?:sk-ant-|sk-)[A-Za-z0-9_-]+/g, '<REDACTED>')
        .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '<EMAIL>'))
      .join('\n').slice(0, 4096) : undefined;
    results.push({ argv: args.map(arg => arg.split(root).join('<STAND>')), ...done, stdoutBytes, stderrBytes, authenticated, authMethod, builtinPlugins, diagnostic, helpOptions });
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
