import { existsSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createProcessRunner } from '../../src/adapters/process-runner/index.ts';
import type { ProcessRequest, ProcessRun } from '../../src/core/ports/process-runner.ts';
import { Stand, pidAlive, waitFor } from '../helpers/claude/stand.ts';

const stands: Stand[] = [];
function stand(): Stand { const s = new Stand(); stands.push(s); return s; }
afterEach(() => { while (stands.length) stands.pop()?.cleanup(); });

const runner = createProcessRunner();
const base = (s: Stand, overrides: Partial<ProcessRequest> = {}): ProcessRequest => ({
  executable: process.execPath, args: [], cwd: s.dir, env: { PATH: '' }, stdin: '', ...overrides,
});
async function collect(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts).toString('utf8');
}
const node = (script: string): string[] => ['-e', script];

describe('0C ProcessRunner: жизненный цикл на реальных дочерних процессах', () => {
  it('stdout и stderr разделены; большой промпт доходит через stdin, а не argv', async () => {
    const s = stand();
    const big = 'ж'.repeat(300_000);
    const run = runner.start(base(s, {
      args: node(`let d='';process.stdin.setEncoding('utf8').on('data',c=>d+=c).on('end',()=>{process.stdout.write('len='+d.length);process.stderr.write('E')})`),
      stdin: big,
    }));
    const [out, err, result] = await Promise.all([collect(run.stdout), collect(run.stderr), run.done]);
    expect(out).toBe(`len=${big.length}`);
    expect(err).toBe('E');
    expect(result).toMatchObject({ exitCode: 0, signal: null });
    expect(result.error).toBeUndefined();
  });

  it('аргументы с метасимволами shell передаются буквально (без shell)', async () => {
    const s = stand();
    const hostile = `$(touch ${s.path('PWNED')}); \`id\` | "x" 'y' && echo z`;
    const run = runner.start(base(s, { args: [...node('process.stdout.write(process.argv[1])'), hostile] }));
    const [out] = await Promise.all([collect(run.stdout), collect(run.stderr), run.done]);
    expect(out).toBe(hostile);
    expect(existsSync(s.path('PWNED'))).toBe(false);
  });

  it('env дочернего процесса — ровно переданный объект, окружение родителя не копируется', async () => {
    const s = stand();
    process.env.VS_PARENT_SECRET = 'must-not-leak';
    try {
      const run = runner.start(base(s, {
        env: { ONLY_THIS: '1' },
        args: node('process.stdout.write(JSON.stringify(Object.keys(process.env).sort()))'),
      }));
      const [out] = await Promise.all([collect(run.stdout), collect(run.stderr), run.done]);
      const keys = JSON.parse(out) as string[];
      expect(keys).toContain('ONLY_THIS');
      expect(keys).not.toContain('VS_PARENT_SECRET');
    } finally { delete process.env.VS_PARENT_SECRET; }
  });

  it('ошибка spawn (нет бинарника) даёт результат spawn_failed, а не исключение', async () => {
    const s = stand();
    const run = runner.start(base(s, { executable: s.path('нет-такого-claude') }));
    const result = await run.done;
    expect(result.error).toBe('spawn_failed');
    expect(result.exitCode).not.toBe(0);
    await expect(collect(run.stdout)).resolves.toBe('');
  });

  it('ненулевой код выхода отражается в результате', async () => {
    const s = stand();
    const run = runner.start(base(s, { args: node('process.exit(7)') }));
    expect(await run.done).toMatchObject({ exitCode: 7 });
  });

  it('таймаут завершает зависший процесс с error=timeout', async () => {
    const s = stand();
    const started = Date.now();
    const run = runner.start(base(s, { args: node('setInterval(()=>{},1000)'), timeoutMs: 200, stopGraceMs: 100, drainTimeoutMs: 200 }));
    const result = await run.done;
    expect(result.error).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('interrupt идемпотентен; процесс, игнорирующий SIGTERM, убивается принудительно', async () => {
    const s = stand();
    const run = runner.start(base(s, {
      args: node(`process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)`),
      stopGraceMs: 100, drainTimeoutMs: 300,
    }));
    const reader = run.stdout[Symbol.asyncIterator]();
    await reader.next(); // процесс запущен, обработчик SIGTERM установлен
    const [a, b] = await Promise.all([run.interrupt(), run.interrupt()]);
    expect(a).toBeUndefined();
    expect(b).toBeUndefined();
    const first = await run.done;
    await run.interrupt();
    await run.kill();
    expect(await run.done).toBe(first);
    expect(first.signal).toBe('SIGKILL');
  });

  it('kill и interrupt после завершения безопасны и не меняют результат', async () => {
    const s = stand();
    const run = runner.start(base(s, { args: node('process.exit(0)') }));
    const result = await run.done;
    await run.kill();
    await run.interrupt();
    expect(await run.done).toEqual(result);
  });

  it('остановка уничтожает дочерние процессы, принадлежащие запуску', async () => {
    const s = stand();
    const pidFile = s.path('child.pid');
    const run = runner.start(base(s, {
      args: node(`const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000)`),
      stopGraceMs: 100, drainTimeoutMs: 300,
    }));
    expect(await waitFor(() => existsSync(pidFile))).toBe(true);
    const childPid = Number(readFileSync(pidFile, 'utf8'));
    expect(pidAlive(childPid)).toBe(true);
    await run.interrupt();
    await run.done;
    expect(await waitFor(() => !pidAlive(childPid))).toBe(true);
  });

  it('потомок, держащий pipes после выхода родителя, не подвешивает done и не остаётся жить', async () => {
    const s = stand();
    const pidFile = s.path('orphan.pid');
    const run = runner.start(base(s, {
      args: node(`const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));process.exit(0)`),
      drainTimeoutMs: 300,
    }));
    const started = Date.now();
    await run.done;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await waitFor(() => existsSync(pidFile))).toBe(true);
    expect(await waitFor(() => !pidAlive(Number(readFileSync(pidFile, 'utf8'))))).toBe(true);
  });

  it('вывод сверх лимита очереди при непрочитанном stdout даёт output_limit', async () => {
    const s = stand();
    const run = runner.start(base(s, {
      args: node(`const l='x'.repeat(1024)+'\\n';(async()=>{for(let i=0;i<200000;i++){if(!process.stdout.write(l))await new Promise(r=>process.stdout.once('drain',r))}})()`),
      maxQueueBytes: 64 * 1024, stopGraceMs: 100, drainTimeoutMs: 300, timeoutMs: 20_000,
    }));
    const result = await run.done; // потребитель stdout не читает вообще
    expect(result.error).toBe('output_limit');
  });

  it('done не зависит от чтения потребителем stdout (малый вывод)', async () => {
    const s = stand();
    const run: ProcessRun = runner.start(base(s, { args: node('process.stdout.write("hi")') }));
    expect(await run.done).toMatchObject({ exitCode: 0 });
  });

  it('медленный потребитель в пределах лимита получает все данные без потерь', async () => {
    const s = stand();
    const run = runner.start(base(s, {
      args: node(`process.stdout.write('a'.repeat(20000))`), maxQueueBytes: 1024 * 1024,
    }));
    const parts: Buffer[] = [];
    for await (const chunk of run.stdout) { parts.push(Buffer.from(chunk)); await new Promise(r => setTimeout(r, 5)); }
    expect(Buffer.concat(parts).length).toBe(20000);
    await run.done;
  });
});
