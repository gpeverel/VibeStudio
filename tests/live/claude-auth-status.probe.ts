import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, mkdtempSync, openSync, readSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildClaudeEnv } from '../../src/adapters/claude/args.ts';
import { createProcessRunner } from '../../src/adapters/process-runner/index.ts';
import { AUTH_STATUS_LIMITS, collectAuthStatus } from '../helpers/claude/auth-status-observation.ts';

const binary = '/opt/homebrew/bin/claude';
const resolved = '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe';
const sha256 = '0116ee2e0a513900b633d9951367f18747686478e2b462805b8c31609f047f70';
const size = 239_695_888;

/** Статика regular file; CLI не вызывается и executable не импортируется. */
function preflight(): ReturnType<typeof statSync> {
  if (process.env.CLAUDE_BIN !== binary || realpathSync(binary) !== resolved) throw new Error('Executable не согласован.');
  if (['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'].some(name => process.env[name] !== undefined))
    throw new Error('Источник авторизации не согласован.');
  const fd = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size !== size || (before.mode & 0o111) === 0) throw new Error('Executable не совпал.');
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(1_048_576);
    for (let position = 0; position < size;) {
      const read = readSync(fd, buffer, 0, Math.min(buffer.length, size - position), position);
      if (!read) throw new Error('Чтение executable не завершено.');
      hash.update(buffer.subarray(0, read)); position += read;
    }
    const after = fstatSync(fd);
    if (hash.digest('hex') !== sha256 || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('Executable изменился.');
    return after;
  } finally { closeSync(fd); }
}

async function main(): Promise<number> {
  if (process.env.LIVE !== '1' || process.env.AUTH_STATUS_PROBE !== '1') {
    console.error('Нужны отдельное разрешение, LIVE=1 и AUTH_STATUS_PROBE=1.');
    return 2;
  }
  let stage: 'preflight' | 'observation' | 'evidence' = 'preflight';
  try {
    const identity = preflight();
    const env = buildClaudeEnv(process.env);
    const evidenceDir = mkdtempSync(join(tmpdir(), 'vs-auth-status-evidence-'));
    const evidenceFile = join(evidenceDir, 'results.json');
    const current = statSync(binary);
    if (!identity || realpathSync(binary) !== resolved || current.dev !== identity.dev || current.ino !== identity.ino
      || current.size !== identity.size || current.mtimeMs !== identity.mtimeMs) throw new Error('Executable изменился.');
    stage = 'observation';
    const startedAt = new Date().toISOString();
    const observation = await collectAuthStatus({ runner: createProcessRunner(), executable: resolved, cwd: tmpdir(), env });
    stage = 'evidence';
    writeFileSync(evidenceFile, JSON.stringify({ schemaVersion: 1, origin: 'real-local-nonmodel-auth-status', startedAt,
      executable: { path: binary, resolved, sha256, size }, argv: ['auth', 'status'], cwd: 'os.tmpdir()',
      envNames: Object.keys(env).sort(), cliAttempts: 1, modelCalls: 0, limits: AUTH_STATUS_LIMITS,
      independentSupervisor: false, observation }, null, 2), { mode: 0o600 });
    console.info(`Немодельная auth-проба: ${evidenceFile}`);
    return observation.status === 'authenticated' ? 0 : observation.status === 'unauthenticated' ? 1 : 2;
  } catch {
    console.error(`Немодельная auth-проба не завершена: ${stage}.`);
    return 2;
  }
}

// После конечного cleanup и попытки записи evidence завершаем только этот Node-процесс.
// Это не подтверждает выход неподтверждённого CLI handle или detached-потомков.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main().then(code => process.exit(code), () => process.exit(2));
