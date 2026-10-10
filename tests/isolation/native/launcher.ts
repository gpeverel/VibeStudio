/** Немодельный прототип: привязывает SBPL/proxy к фактическому ProcessRunner.
 * Не подключён к Claude adapter; положительного AccessVerification не выдаёт.
 */
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import type { ProcessRequest, ProcessRunner, ProcessRun } from '../../../src/core/ports/process-runner.ts';

export function assertSingleLinkTree(root: string): void {
  const stat = lstatSync(root);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) throw new Error('Alias or special file rejected');
  if (stat.isDirectory()) for (const name of readdirSync(root)) assertSingleLinkTree(join(root, name));
}
export function nativeProfile(workspace: string, runtime: string, protectedPaths: readonly string[], brokerPort: number, executables: readonly string[]): string {
  if (process.platform !== 'darwin' || !Number.isInteger(brokerPort) || brokerPort < 1 || brokerPort > 65535) throw new Error('Unsupported native profile');
  const roots = [workspace, runtime, ...protectedPaths, ...executables];
  if (roots.some(path => !isAbsolute(path) || realpathSync(path) !== path)) throw new Error('Canonical absolute paths required');
  const inside = (root: string, path: string) => { const rel = relative(root, path); return !rel || (!rel.startsWith('..') && !isAbsolute(rel)); };
  if (inside(workspace, runtime) || inside(runtime, workspace) || protectedPaths.some(path => inside(path, runtime) || inside(runtime, path))) throw new Error('Overlapping writable root');
  assertSingleLinkTree(workspace); assertSingleLinkTree(runtime);
  const q = JSON.stringify;
  return [
    '(version 1)', '(deny default)', '(allow process-exec process-fork)',
    '(allow signal (target same-sandbox))', '(allow sysctl-read)',
    '(allow file-read-metadata (vnode-type DIRECTORY))',
    '(allow file-read* (literal "/") (subpath "/System/Library") (subpath "/usr/lib") (subpath "/usr/share/icu") (subpath "/usr/bin") (subpath "/bin"))',
    '(allow file-read* (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))',
    `(allow file-read* (subpath ${q(workspace)}) (subpath ${q(runtime)}) ${executables.map(path => `(literal ${q(path)})`).join(' ')})`,
    `(allow file-write* (subpath ${q(runtime)}))`,
    `(deny file-write* (subpath ${q(workspace)}) ${protectedPaths.map(path => `(subpath ${q(path)})`).join(' ')})`,
    `(allow network-outbound (remote ip "localhost:${brokerPort}"))`,
  ].join('\n');
}
export function startNativeProbe(runner: ProcessRunner, profile: string, brokerPort: number, request: ProcessRequest): ProcessRun {
  // Пользовательские proxy/NO_PROXY не могут изменить выбранный маршрут.
  const env = Object.fromEntries(Object.entries(request.env).filter(([key]) => !/proxy/i.test(key)));
  return runner.start({ ...request, executable: '/usr/bin/sandbox-exec', args: ['-p', profile, request.executable, ...request.args],
    env: { ...env, HTTPS_PROXY: `http://127.0.0.1:${brokerPort}`, HTTP_PROXY: `http://127.0.0.1:${brokerPort}`, NO_PROXY: '' } });
}
