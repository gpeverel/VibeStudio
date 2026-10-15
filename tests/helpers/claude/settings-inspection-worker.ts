import { EventEmitter } from 'node:events';
import { lstatSync, rmSync } from 'node:fs';
import { Socket } from 'node:net';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectSettings } from './settings-inspection.ts';
import type { InspectionChild } from './settings-inspection.ts';
import { MAX_INSPECTION_IPC_BYTES, projectInspectionReport } from './settings-inspection-supervisor.ts';
import type { SupervisorToWorker } from './settings-inspection-supervisor.ts';

/** Собственные pipe endpoints; raw CLI stdout/stderr не пересылаются через process.send.
 * У worker нет настоящего ChildProcess Claude и нет process.kill/PID kill. */
export function runInspectionWorker(ownedCwd = false): void {
  let run: ReturnType<typeof inspectSettings> | undefined;
  let child: InspectionChild | undefined;
  let started = false, closing = false, terminated = false, nextSignal = 0;
  let metadataBefore: InspectionMetadata | undefined;
  let remoteBefore: InspectionMetadata | undefined;
  let cwdIdentity: { dev: number; ino: number } | undefined;
  let remotePath: string | undefined;
  const pending = new Map<number, { resolve(value: boolean): void; reject(error: Error): void }>();
  const send = (message: object, callback?: () => void) => {
    try {
      if (!process.connected || !process.send || Buffer.byteLength(JSON.stringify(message)) > MAX_INSPECTION_IPC_BYTES) { fail(); return; }
      process.send(message, undefined, undefined, (error: Error | null) => { if (error) fail(); else callback?.(); });
    } catch { fail(); }
  };
  const fail = () => {
    if (closing) return;
    closing = true;
    for (const request of pending.values()) request.reject(Object.assign(new Error('Канал владельца недоступен'), { code: 'EIO' }));
    pending.clear();
    run?.stop();
    for (const stream of [child?.stdin, child?.stdout, child?.stderr]) stream?.destroy();
    process.exit(1);
  };
  process.on('disconnect', fail);
  process.on('SIGTERM', () => { terminated = true; if (run) run.stop(); else fail(); });
  process.on('message', (raw: unknown) => {
    if (closing) return;
    // Все сообщения создаёт владелец; ограничения проверяются до использования полей.
    if (!raw || typeof raw !== 'object' || !('type' in raw)) { fail(); return; }
    const message = raw as SupervisorToWorker;
    if (message.type === 'start') {
      if (started || terminated || !/^\d{1,24}$/.test(message.startedNs) || !Number.isSafeInteger(message.cliPid) || message.cliPid <= 0) { fail(); return; }
      started = true;
      const passed = Number(process.hrtime.bigint() - BigInt(message.startedNs)) / 1_000_000;
      const startedAt = performance.now() - passed;
      if (!Number.isFinite(passed) || passed < 0 || passed >= message.budget.response) { send({ type: 'failed' }, fail); return; }
      try {
        const emitter = new EventEmitter();
        const stdin = new Socket({ fd: 3, readable: false, writable: true });
        const stdout = new Socket({ fd: 4, readable: true, writable: false });
        const stderr = new Socket({ fd: 5, readable: true, writable: false });
        child = Object.assign(emitter, { stdin, stdout, stderr, pid: message.cliPid,
          unref() { stdin.unref(); stdout.unref(); stderr.unref(); },
          kill(signal: 'SIGTERM' | 'SIGKILL') {
            const id = ++nextSignal;
            if (id > 2 || closing) return Promise.resolve(false);
            return new Promise<boolean>((resolve, reject) => {
              pending.set(id, { resolve, reject }); send({ type: 'signal_request', id, signal });
            });
          },
        }) as unknown as InspectionChild; // EventEmitter.on возвращает facade, а не настоящий ChildProcess.
        if (ownedCwd) {
          if (!message.artifactsBefore) { fail(); return; }
          metadataBefore = message.artifactsBefore.cwd;
          remoteBefore = message.artifactsBefore.remote;
          cwdIdentity = lstatSync(process.cwd());
          const config = process.env.CLAUDE_CONFIG_DIR ?? (process.env.HOME ? join(process.env.HOME, '.claude') : undefined);
          if (config && isAbsolute(config)) remotePath = join(config, 'remote-settings.json');
        }
        run = inspectSettings(() => child!, {
          startedAt,
          onSettingsAccepted: () => send({ type: 'settings_accepted' }),
        });
        void run.done.then(report => {
          const safe = projectInspectionReport(report);
          if (!safe) { send({ type: 'failed' }, fail); return; }
          let artifacts: InspectionArtifacts | undefined;
          if (ownedCwd) {
            artifacts = { cwdBefore: metadataBefore!, cwdAfter: inspectionMetadata(process.cwd()),
              remoteBefore: remoteBefore ?? { state: 'unavailable' }, remoteAfter: remotePath ? inspectionMetadata(remotePath) : { state: 'unavailable' },
              cleanup: 'unconfirmed' };
            if (report.completion.process.state === 'exited') {
              try {
                const current = lstatSync(process.cwd());
                if (current.dev !== cwdIdentity?.dev || current.ino !== cwdIdentity.ino || !current.isDirectory()) throw new Error('Cwd изменён');
                rmSync(process.cwd(), { recursive: true, force: false }); artifacts.cleanup = 'removed';
              }
              catch { artifacts.cleanup = 'failed'; }
            }
          }
          // Уборка/metadata выполняются под внешним надзором, до конечного IPC.
          send({ type: 'report', report: safe, ...(artifacts ? { artifacts } : {}) }, () => { closing = true; process.exit(0); });
        }).catch(() => send({ type: 'failed' }, fail));
      } catch { send({ type: 'failed' }, fail); }
    } else if (!started) fail();
    else if (message.type === 'cli_exit') (child as unknown as EventEmitter).emit('exit', message.exitCode, message.signal);
    else if (message.type === 'cli_error') (child as unknown as EventEmitter).emit('error', new Error('Ошибка собственного процесса'));
    else if (message.type === 'signal_result') {
      const request = pending.get(message.id);
      if (!request) { fail(); return; }
      pending.delete(message.id);
      if (message.result.status === 'sent') request.resolve(true);
      else if (message.result.errorCode) request.reject(Object.assign(new Error('Сигнал не подтверждён'), { code: message.result.errorCode }));
      else request.resolve(false);
    } else fail();
  });
  send({ type: 'ready' });
}

export type InspectionMetadata = { state: 'missing' | 'unavailable' } | {
  state: 'present'; kind: 'file' | 'directory' | 'symlink' | 'other'; size: number; mtimeMs: number;
};
export interface InspectionArtifacts {
  cwdBefore: InspectionMetadata; cwdAfter: InspectionMetadata; remoteBefore: InspectionMetadata; remoteAfter: InspectionMetadata;
  cleanup: 'removed' | 'failed' | 'unconfirmed';
}
export function inspectionMetadata(path: string): InspectionMetadata {
  try {
    const stat = lstatSync(path); // Только lstat: ни содержимого, ни разыменования конечного симлинка.
    return { state: 'present', kind: stat.isSymbolicLink() ? 'symlink' : stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other',
      size: stat.size, mtimeMs: stat.mtimeMs };
  } catch (error) { return { state: (error as { code?: string }).code === 'ENOENT' ? 'missing' : 'unavailable' }; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.send || process.argv[2] !== '--inspection-worker' || process.argv.length > 4
    || (process.argv[3] !== undefined && process.argv[3] !== '--owned-cwd')) process.exitCode = 2;
  else runInspectionWorker(process.argv[3] === '--owned-cwd');
}
