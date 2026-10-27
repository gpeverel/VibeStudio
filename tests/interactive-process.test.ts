import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { createInteractiveProcessRunner } from '../src/adapters/process-runner/interactive.ts';
import type { ProcessRequest } from '../src/core/ports/process-runner.ts';
const request = (script: string, more: Partial<ProcessRequest> = {}): ProcessRequest => ({ executable: process.execPath,
  args: ['-e', script], cwd: tmpdir(), env: { PATH: '/usr/bin:/bin' }, stdin: '', timeoutMs: 3000, stopGraceMs: 50,
  drainTimeoutMs: 500, maxQueueBytes: 4096, ...more });
async function drain(stream: AsyncIterable<Uint8Array>) { let text = ''; for await (const chunk of stream) text += Buffer.from(chunk).toString('utf8'); return text; }
describe('Двусторонний ProcessRunner: реальные дочерние Node-процессы', () => {
  it('передаёт несколько сообщений и получает ответы до EOF stdin', async () => {
    const run = createInteractiveProcessRunner().start(request('process.stdin.on("data", x => process.stdout.write(x));'));
    const out = run.stdout[Symbol.asyncIterator](); const err = drain(run.stderr);
    await run.send('первое\n'); expect(Buffer.from((await out.next()).value!).toString()).toBe('первое\n');
    await run.send('второе\n'); expect(Buffer.from((await out.next()).value!).toString()).toBe('второе\n');
    run.closeInput(); expect((await out.next()).done).toBe(true); expect(await err).toBe('');
    expect((await run.done).completion).toMatchObject({ process: { state: 'exited', exitCode: 0 }, stdout: 'ended', stderr: 'ended', issues: [] });
    await expect(run.send('поздно')).rejects.toThrow();
  });
  it('Stop завершает собственную группу и сохраняет результаты сигналов', async () => {
    const run = createInteractiveProcessRunner().start(request('setInterval(()=>{},1000);'));
    const reads = Promise.all([drain(run.stdout), drain(run.stderr)]); await run.interrupt(); await reads;
    const result = await run.done; expect(result.completion.process.state).toBe('exited');
    expect(result.completion.signals).toContainEqual(expect.objectContaining({ signal: 'SIGTERM', status: 'sent' }));
  });
  it('ограничивает исходящее сообщение', async () => {
    const run = createInteractiveProcessRunner().start(request('process.stdin.resume();'));
    const reads = Promise.all([drain(run.stdout), drain(run.stderr)]);
    await expect(run.send('x'.repeat(4097))).rejects.toThrow('stdin_limit'); await reads;
    expect((await run.done).completion.issues).toContainEqual(expect.objectContaining({ code: 'stdin_failed' }));
  });
  it('останавливает процесс при переполнении очереди вывода', async () => {
    const run = createInteractiveProcessRunner().start(request('process.stdout.write("x".repeat(1000000));setInterval(()=>{},1000);'));
    const result = await run.done; await Promise.all([drain(run.stdout), drain(run.stderr)]);
    expect(result.completion.issues).toContainEqual(expect.objectContaining({ code: 'output_limit' }));
  });
  it('отсутствующий executable не выдаёт успешное завершение', async () => {
    const run = createInteractiveProcessRunner().start(request('', { executable: '/nonexistent/vibestudio-codex-rpc' }));
    await Promise.all([drain(run.stdout), drain(run.stderr)]);
    expect((await run.done).completion.process.state).toBe('not_started'); await expect(run.send('{}')).rejects.toThrow();
  });
  it('deadline завершает процесс с открытым stdin', async () => {
    const run = createInteractiveProcessRunner().start(request('process.stdin.resume();', { timeoutMs: 100 }));
    await Promise.all([drain(run.stdout), drain(run.stderr)]);
    expect((await run.done).completion.issues).toContainEqual(expect.objectContaining({ code: 'timeout' }));
  });
});
