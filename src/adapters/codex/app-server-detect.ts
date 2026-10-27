import { tmpdir } from 'node:os';
import type { AgentDetectOptions } from '../../core/ports/agent.ts';
import type { ProcessRunner } from '../../core/ports/process-runner.ts';
import { buildCodexEnv } from './args.ts';
import { resolveCodexBinary } from './detect.ts';
import type { CodexAppServerDetection } from './app-server-contracts.ts';

/** Три конечные немодельные диагностики; исходный вывод не экспортируется. */
export async function detectAppServer(runner: ProcessRunner, options: AgentDetectOptions = {}): Promise<CodexAppServerDetection> {
  const env = buildCodexEnv(options.env ?? process.env);
  const binaryPath = await resolveCodexBinary({ ...options, env });
  const result: CodexAppServerDetection = { status: 'unavailable', binaryPath, version: null, auth: 'unknown',
    capabilities: { appServer: false, strictConfig: false, loginStatus: false }, unavailable: [] };
  if (!binaryPath) { result.unavailable.push({ reason: 'binary_missing', detail: 'Codex CLI не найден' }); return result; }
  const capture = async (args: string[]) => {
    const run = runner.start({ executable: binaryPath, args, cwd: tmpdir(), env, stdin: '', timeoutMs: 5000,
      stopGraceMs: 100, drainTimeoutMs: 500, maxQueueBytes: 262144 });
    let bytes = 0;
    const read = async (stream: AsyncIterable<Uint8Array>): Promise<string> => {
      const chunks: Uint8Array[] = [];
      try { for await (const chunk of stream) { bytes += chunk.byteLength; if (bytes > 262144) throw new Error('limit'); chunks.push(chunk); } }
      catch { await run.kill(); throw new Error('stream'); }
      return Buffer.concat(chunks).toString('utf8');
    };
    const [out, err, finished] = await Promise.all([read(run.stdout), read(run.stderr), run.done]);
    const c = finished.completion;
    if (finished.error || c.process.state !== 'exited' || c.process.exitCode !== finished.exitCode || c.process.signal !== null
      || c.stdout !== 'ended' || c.stderr !== 'ended' || c.wait !== 'settled' || c.issues.length) throw new Error('completion');
    return { out, err, code: finished.exitCode };
  };
  try {
    const version = await capture(['--version']);
    result.version = version.code === 0 ? version.out.match(/^codex(?:-cli)?\s+(\d+\.\d+\.\d+)\s*$/m)?.[1] ?? null : null;
    const help = await capture(['app-server', '--help']);
    result.capabilities.appServer = help.code === 0 && /^\s+--listen\b/m.test(help.out) && /stdio:\/\//.test(help.out);
    result.capabilities.strictConfig = help.code === 0 && /^\s+--strict-config\b/m.test(help.out);
    const auth = await capture(['login', 'status']);
    result.auth = auth.code === 0 ? 'authenticated' : auth.code === 1 && /^Not logged in\s*$/.test(auth.err) && !auth.out.trim() ? 'unauthenticated' : 'unknown';
    result.capabilities.loginStatus = result.auth !== 'unknown';
    if (result.auth !== 'authenticated') result.unavailable.push({ reason: 'not_authenticated', detail: 'Штатная авторизация Codex не подтверждена' });
    if (!result.version || !result.capabilities.appServer || !result.capabilities.strictConfig) result.unavailable.push({ reason: 'capability_missing', detail: 'CLI не подтвердил обязательный интерфейс app-server' });
  } catch { result.unavailable.push({ reason: 'spawn_failed', detail: 'Диагностика app-server не завершилась штатно' }); }
  result.status = result.unavailable.length ? 'unavailable' : 'available'; return result;
}
