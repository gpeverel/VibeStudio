/** Ограниченное немодельное исследование fork-deny. Максимум 10 CLI subcommands,
 * без --print, prompts, login, --version и модели. Отдельный baseline-режим:
 * ровно два auth status с обычной файловой доступностью, не production профиль.
 * Секреты/сырые потоки не сохраняются.
 * MACOS_FORK_PROBE=1 LIVE=1 sh scripts/with-node.sh node --experimental-transform-types tests/isolation/macos-fork.probe.ts
 */
import assert from 'node:assert/strict';
import { chmodSync, createReadStream, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProcessRunner } from '../../src/adapters/process-runner/index.ts';
import { buildClaudeEnv } from '../../src/adapters/claude/args.ts';
import type { ProcessResult } from '../../src/core/ports/process-runner.ts';
if (process.platform !== 'darwin' || process.env.MACOS_FORK_PROBE !== '1' || process.env.LIVE !== '1') throw new Error('Нужны macOS, MACOS_FORK_PROBE=1 и LIVE=1; модели не вызываются');
const root = realpathSync(mkdtempSync(join(tmpdir(), 'vs-fork-')));
const artifacts = mkdtempSync(join(tmpdir(), 'vs-fork-evidence-'));
const cli = realpathSync('/opt/homebrew/bin/claude');
const config = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
const runner = createProcessRunner();
const settings = join(root, 'settings.json');
writeFileSync(settings, JSON.stringify({ enabledPlugins: { 'cc-plugin-agents-md@builtin': false, 'cc-plugin-plugin-authoring@builtin': false } }));
const records: object[] = [];
let cliCalls = 0;
async function capture(executable: string, args: string[], env = buildClaudeEnv({ ...process.env, TMPDIR: root })): Promise<{ result: ProcessResult; stdout: string; stderrBytes: number }> {
  const run = runner.start({ executable, args, cwd: root, env, stdin: '', timeoutMs: 10000, stopGraceMs: 500, drainTimeoutMs: 500, maxQueueBytes: 65536 });
  const parts: Buffer[] = []; let stderrBytes = 0;
  await Promise.all([(async () => { for await (const c of run.stdout) parts.push(Buffer.from(c)); })(), (async () => { for await (const c of run.stderr) stderrBytes += c.byteLength; })()]);
  return { result: await run.done, stdout: Buffer.concat(parts).toString(), stderrBytes };
}
function profile(denyFork: boolean, processOnly = false): string {
  if (process.env.MACOS_FORK_AUTH_BASELINE === '1') return ['(version 1)', '(allow default)', '(deny network*)', ...(denyFork ? ['(deny process-fork)'] : [])].join('\n');
  return [
    '(version 1)', '(allow default)', '(deny network*)', '(deny file-write*)',
    ...(denyFork ? ['(deny process-fork)'] : []),
    ...(processOnly ? [] : [
      '(deny file-read*)', '(allow file-read-metadata (vnode-type DIRECTORY))',
      '(allow file-read* (literal "/") (subpath "/System/Library") (subpath "/usr/lib") (subpath "/usr/share/icu") (subpath "/usr/bin") (subpath "/bin"))',
      '(allow file-read* (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))',
      `(allow file-read* (literal ${JSON.stringify(cli)}) (literal ${JSON.stringify(join(homedir(), '.claude.json'))}) (literal ${JSON.stringify(join(config, '.credentials.json'))}) (literal ${JSON.stringify(join(config, 'settings.json'))}))`,
      `(allow file-read* (subpath ${JSON.stringify(join(homedir(), 'Library/Keychains'))}) (subpath "/Library/Keychains") (subpath "/Library/Application Support/ClaudeCode") (subpath "/Library/Managed Preferences"))`,
    ]),
    '(allow file-write-data (literal "/dev/null"))',
    `(allow file-read* file-write* (subpath ${JSON.stringify(root)}))`,
  ].join('\n');
}
const redact = (s: string) => s.split(root).join('<STAND>').split(cli).join('<CLI>').split(config).join('<CONFIG>').split(homedir()).join('<HOME>');
async function command(name: string, args: string[], denyFork: boolean, processOnly = false, trace = false) {
  assert(cliCalls < 10, 'CLI budget exhausted'); cliCalls++;
  const env = buildClaudeEnv({ ...process.env, TMPDIR: root });
  if (trace) env.PATH = `${root}:${env.PATH ?? '/usr/bin:/bin'}`;
  const r = await capture('/usr/bin/sandbox-exec', ['-p', profile(denyFork, processOnly), cli, ...args], env);
  let authenticated: boolean | null = null; let authMethod: string | null = null;
  if (args.includes('auth')) {
    try {
      const value = JSON.parse(r.stdout) as { loggedIn?: unknown; authMethod?: unknown };
      if (typeof value.loggedIn === 'boolean') authenticated = value.loggedIn;
      if (['claude.ai', 'api_key', 'none'].includes(String(value.authMethod))) authMethod = String(value.authMethod);
    } catch { /* Неизвестный ответ не выдаётся за подтверждение. */ }
  }
  const traceFile = join(root, 'security.trace');
  const traceLines = trace && existsSync(traceFile) ? readFileSync(traceFile, 'utf8').trim().split('\n') : [];
  // Только собственные заранее определённые метки; никаких аргументов -a/-s/-w и вывода security.
  assert(traceLines.every(line => /^(?:find-generic-password|other-security|exit-[0-9]+)$/.test(line)));
  records.push({ name, denyFork, processOnly, trace, argv: args.map(redact), ...r.result,
    stdoutBytes: Buffer.byteLength(r.stdout), stderrBytes: r.stderrBytes, authenticated, authMethod, securityTrace: traceLines });
  if (existsSync(traceFile)) rmSync(traceFile);
  return authenticated;
}
let complete = false;
try {
  assert.equal((await capture('/usr/bin/git', ['-c', 'init.templateDir=', '-c', 'core.hooksPath=/dev/null', 'init', '--quiet', root], { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' })).result.exitCode, 0);
  if (process.env.MACOS_FORK_AUTH_BASELINE === '1') {
    // Ровно два auth subcommands: нормальная файловая доступность, сеть закрыта.
    // Не production профиль; не запускаем модель/login и не переносим credentials.
    for (const deny of [false, true]) await command('auth-normal-files-control', ['--safe-mode', '--restricted', '--setting-sources', '', '--settings', settings, 'auth', 'status'], deny, true);
    complete = true;
  } else {
  const helper = join(root, 'process-control');
  writeFileSync(join(root, 'process-control.c'), '#include <unistd.h>\n#include <spawn.h>\n#include <errno.h>\n#include <stdio.h>\n#include <sys/wait.h>\n#include <string.h>\nextern char **environ;\nint main(int n,char**v){if(n!=2)return 3;pid_t p;int e=0;if(strcmp(v[1],"fork")==0){p=fork();if(p<0)e=errno;else if(p==0)_exit(0);}else{char *a[]={"/usr/bin/true",NULL};e=posix_spawn(&p,a[0],NULL,NULL,a,environ);}if(e){printf("DENIED errno=%d\\n",e);return e==EPERM?42:43;}int s;waitpid(p,&s,0);puts("CHILD_STARTED");return 0;}\n');
  assert.equal((await capture('/usr/bin/cc', [join(root, 'process-control.c'), '-o', helper])).result.exitCode, 0);
  for (const mode of ['fork', 'spawn']) for (const denyFork of [false, true]) {
    const r = await capture('/usr/bin/sandbox-exec', ['-p', profile(denyFork), helper, mode]);
    records.push({ name: `${mode}-${denyFork ? 'deny' : 'allow'}`, ...r.result, stdout: r.stdout.trim(), stderrBytes: r.stderrBytes });
    assert.equal(r.result.exitCode, denyFork ? 42 : 0); assert.match(r.stdout, denyFork ? /DENIED errno=1/ : /CHILD_STARTED/);
  }
  const flags = ['--safe-mode', '--restricted', '--setting-sources', '', '--settings', settings];
  for (const deny of [false, true]) {
    await command('help', [...flags, '--help'], deny);
    await command('auth-status', [...flags, 'auth', 'status'], deny);
    await command('plugin-list', [...flags, 'plugin', 'list', '--json'], deny);
  }
  // Исключаем прежний файловый confound: это диагностический read-unrestricted профиль,
  // не production доступ. Только auth status; transcript/session команды не выполняются.
  for (const deny of [false, true]) await command('auth-process-only', [...flags, 'auth', 'status'], deny, true);
  // Локализуем конкретный штатный helper без сохранения его аргументов или credentials.
  writeFileSync(join(root, 'security'), '#!/bin/sh\ncase "$1" in find-generic-password) printf "find-generic-password\\n" ;; *) printf "other-security\\n" ;; esac >> "' + root + '/security.trace"\n/usr/bin/security "$@"\nvs_exit=$?\nprintf "exit-%s\\n" "$vs_exit" >> "' + root + '/security.trace"\nexit "$vs_exit"\n');
  chmodSync(join(root, 'security'), 0o700);
  for (const deny of [false, true]) await command('auth-security-trace', [...flags, 'auth', 'status'], deny, true, true);
  complete = true;
  }
} finally {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(cli)) hash.update(chunk);
  writeFileSync(join(artifacts, 'observations.json'), JSON.stringify({ origin: 'real-local-nonmodel-fork-probe', complete,
    darwin: release(), node: process.version, cliHash: hash.digest('hex'), modelCalls: 0, cliCalls, productionReady: false, normalFilesAuthControl: process.env.MACOS_FORK_AUTH_BASELINE === '1',
    credentialEnvPresent: { apiKey: Boolean(process.env.ANTHROPIC_API_KEY), oauthToken: Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN), configDirSet: Boolean(process.env.CLAUDE_CONFIG_DIR) },
    records, allowProfile: redact(profile(false)), denyProfile: redact(profile(true)),
    processOnlyDenyProfile: redact(profile(true, true)), limitations: ['Auth subcommands only; no transcript access intended', 'Diagnostic Mach IPC unrestricted', 'No Read/Glob/Grep/persistence/resume model verification', 'Managed/builtin/runtime/inode/provider gates remain open'],
  }, null, 2));
  rmSync(root, { recursive: true, force: true });
  console.info(`Немодельные fork-наблюдения: ${artifacts}; это не AccessVerification.`);
}
