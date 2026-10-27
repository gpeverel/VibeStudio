import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { delimiter, isAbsolute } from 'node:path';
import { buildAgentInstructions } from '../../core/agent-instructions.ts';
import type { AgentAdapter, AgentDiagnostic, AgentEvent, AgentRunCompletion, AgentRunResult, NormalizedPayload, ProcessCompletion } from '../../core/ports/agent.ts';
import type { ProcessRun, ProcessRunner, ProcessResult } from '../../core/ports/process-runner.ts';
import { createProcessRunner } from '../process-runner/index.ts';
import { createInteractiveProcessRunner } from '../process-runner/interactive.ts';
import type { InteractiveProcessRunner } from '../process-runner/interactive.ts';
import { BoundedQueue } from '../process-runner/queue.ts';
import { buildCodexEnv, forbiddenEnvNames } from './args.ts';
import { CODEX_LIMITATIONS } from './contracts.ts';
import type { CodexThreadBinding } from './contracts.ts';
import { CODEX_PUBLIC_CONTEXT } from './extensions.ts';
import { isCodexThreadRef, validateCodexProfile } from './profile.ts';
import { appServerArgs, checkThreadPolicy, inspectAppServerConfig } from './app-server-policy.ts';
import { detectAppServer } from './app-server-detect.ts';
import type { CodexAppServerCapabilities, CodexAppServerDetection, CodexAppServerRequest } from './app-server-contracts.ts';
import { CodexRpc, object, RpcError } from './rpc.ts';
import type { JsonObject } from './rpc.ts';

export interface AppServerBinding extends CodexThreadBinding { transport: 'app-server'; profile: 'codex-app-server-read-v1' }
export interface CodexAppServerOptions {
  binaryPath?: string;
  env?: Readonly<Record<string, string>>;
  runner?: ProcessRunner;
  interactiveRunner?: InteractiveProcessRunner;
  /** Только доверенная композиция/тесты, никогда IPC. */
  detect?: () => Promise<CodexAppServerDetection>;
  verifyThread?: (binding: AppServerBinding) => boolean | Promise<boolean>;
  timeoutMs?: number;
  stopGraceMs?: number;
  maxQueueBytes?: number;
}
const clean = (c: ProcessCompletion): boolean => c.process.state === 'exited' && c.process.exitCode === 0 && c.process.signal === null
  && c.stdout === 'ended' && c.stderr === 'ended' && c.wait === 'settled' && c.issues.length === 0;
const emptyCompletion = (): ProcessCompletion => ({ process: { state: 'not_started' }, stdout: 'not_started', stderr: 'not_started',
  wait: 'settled', issues: [], signals: [], descendants: 'not_guaranteed' });
const identity = async (path: string): Promise<string> => { const s = await stat(path); if (!s.isFile()) throw new Error('binary'); return [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(':'); };
const freeze = <T>(value: T): T => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const item of Object.values(value)) freeze(item); } return value; };

/** Процесс на ход; официальный RPC добавляет только собственную developer-инструкцию приложения.
 * Resume принимает собственный thread с привязкой, не path/history и не произвольные injected items. */
export function createCodexAppServerAdapter(options: CodexAppServerOptions = {}): AgentAdapter<CodexAppServerRequest, CodexAppServerCapabilities> {
  const env = buildCodexEnv(options.env ?? process.env);
  const runner = options.runner ?? createProcessRunner();
  const interactive = options.interactiveRunner ?? createInteractiveProcessRunner();
  const timeoutMs = options.timeoutMs ?? 120_000, graceMs = options.stopGraceMs ?? 2000, queueBytes = options.maxQueueBytes ?? 1_048_576;
  for (const value of [timeoutMs, graceMs, queueBytes]) if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new Error('Некорректный лимит app-server');
  const known = new Set<string>(), sequences = new Map<string, number>();
  const bindingKey = (b: AppServerBinding): string => JSON.stringify([b.sessionId, b.participantId, b.workspaceId, b.cwd, b.threadId, b.transport, b.profile]);
  return {
    detect: request => options.detect ? options.detect() : detectAppServer(runner, { binaryPath: request?.binaryPath ?? options.binaryPath, env: request?.env ?? env }),
    start: async input => {
      let request: CodexAppServerRequest;
      try { request = freeze(structuredClone(input)); } catch { request = input; }
      const meta = object(request) ?? {};
      const queue = new BoundedQueue<AgentEvent>(queueBytes, e => Buffer.byteLength(JSON.stringify(e)), 512);
      const diagnostics: AgentDiagnostic[] = [{ code: 'codex_limitations', detail: CODEX_LIMITATIONS.join(',') }];
      const seqKey = JSON.stringify([meta.sessionId, meta.participantId]);
      const wrap = (payload: NormalizedPayload): AgentEvent => {
        const seq = (sequences.get(seqKey) ?? 0) + 1; sequences.set(seqKey, seq);
        return { schemaVersion: 1, eventId: randomUUID(), sessionId: String(meta.sessionId ?? ''), turnId: String(meta.turnId ?? ''),
          participantId: String(meta.participantId ?? ''), seq, timestamp: new Date().toISOString(), ...payload };
      };
      let resolveDone!: (result: AgentRunCompletion) => void;
      const done = new Promise<AgentRunCompletion>(resolve => { resolveDone = resolve; });
      let finished = false, stopped = false, attempted = false, lostHandle = false;
      let last: ProcessResult | undefined, rpc: CodexRpc | undefined, threadId: string | undefined, turnId: string | undefined;
      let current: ProcessRun | undefined, failure: RpcError | undefined, turnResult: AgentRunResult | undefined;
      let finalText = '', textBytes = 0;
      let stopTimer: ReturnType<typeof setTimeout> | undefined;
      const extraIssues: ProcessCompletion['issues'][number][] = [];
      const tools = new Map<string, string>();
      let abort!: (error: RpcError) => void;
      const aborted = new Promise<never>((_resolve, reject) => { abort = reject; }); void aborted.catch(() => undefined);
      const step = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, aborted]);
      const stopProcess = async (hard: boolean): Promise<void> => {
        try { if (current) await (hard ? current.kill() : current.interrupt()); }
        catch { extraIssues.push({ code: 'signal_failed', operation: hard ? 'kill' : 'interrupt', detail: 'Остановка app-server не подтверждена' }); }
      };
      const fail = (error: RpcError): void => { failure ??= error; abort(error); void stopProcess(true); };
      const emit = (payload: NormalizedPayload): void => { if (!finished && !queue.push(wrap(payload))) fail(new RpcError('output_limit', 'Превышен лимит очереди событий')); };
      let resolveTurn!: () => void;
      const turnEnded = new Promise<void>(resolve => { resolveTurn = resolve; });
      const notify = (message: JsonObject): void => {
        const method = message.method, p = object(message.params);
        if (!p) throw new Error('params');
        if (typeof method === 'string' && (method.startsWith('mcpServer/') || method.startsWith('hook/'))) {
          fail(new RpcError('profile_unsupported', 'Обнаружена активность отключённого расширения')); return;
        }
        // Только собственный загруженный thread; служебные уведомления до него не являются модельными событиями.
        if (!threadId) return;
        if (p.threadId !== undefined && p.threadId !== threadId) throw new Error('foreign_thread');
        if (method === 'turn/started') {
          const id = object(p.turn)?.id; if (typeof id !== 'string' || turnId && turnId !== id) throw new Error('turn'); turnId = id; return;
        }
        if (typeof method === 'string' && (method.startsWith('item/') || method === 'turn/completed')) {
          const id = method === 'turn/completed' ? object(p.turn)?.id : p.turnId;
          if (!turnId || id !== turnId) throw new Error('foreign_turn');
        }
        if (method === 'item/agentMessage/delta') {
          if (typeof p.itemId !== 'string' || typeof p.delta !== 'string') throw new Error('delta');
          textBytes += Buffer.byteLength(p.delta); if (textBytes > 262144) throw new Error('text_limit');
          emit({ type: 'text', messageId: p.itemId, mode: 'delta', text: p.delta });
        } else if (method === 'item/started' || method === 'item/completed') {
          const item = object(p.item); if (!item || typeof item.id !== 'string' || typeof item.type !== 'string') throw new Error('item');
          if (item.type === 'agentMessage' && method === 'item/completed') {
            if (typeof item.text !== 'string') throw new Error('text');
            textBytes += Buffer.byteLength(item.text); if (textBytes > 262144) throw new Error('text_limit');
            if (item.phase === 'final_answer') finalText = item.text;
            emit({ type: 'text', messageId: item.id, mode: 'snapshot', text: item.text });
          } else if (item.type === 'commandExecution') {
            if (method === 'item/started') {
              if (tools.has(item.id)) throw new Error('duplicate_tool'); tools.set(item.id, 'command_execution');
              emit({ type: 'tool_started', toolCallId: item.id, tool: 'command_execution', inputPreview: '' });
            } else {
              if (!tools.has(item.id)) throw new Error('tool_without_start'); tools.delete(item.id);
              emit({ type: 'tool_finished', toolCallId: item.id, isError: item.exitCode !== 0 });
            }
          } else if (!['agentMessage', 'userMessage', 'reasoning', 'plan'].includes(item.type)) {
            fail(new RpcError('profile_unsupported', 'Обнаружен инструмент вне профиля чтения'));
          }
        } else if (method === 'turn/completed') {
          if (turnResult) throw new Error('duplicate_turn');
          const turn = object(p.turn);
          turnResult = turn?.status === 'completed' && !tools.size ? { kind: 'success', text: finalText }
            : turn?.status === 'interrupted' ? { kind: 'interrupted' }
              : { kind: 'error', reason: 'unknown', detail: 'Ход app-server завершился ошибкой' };
          resolveTurn();
        } else if (method === 'error') {
          fail(new RpcError('unknown', 'app-server сообщил об ошибке хода'));
        }
      };
      const timer = setTimeout(() => fail(new RpcError('timeout', 'Превышено время хода app-server')), timeoutMs);
      const track = <T extends ProcessRun>(start: () => T): T => {
        if (stopped || finished || failure) throw new RpcError('unknown', 'Запуск отменён');
        attempted = true;
        let run: T; try { run = start(); } catch (cause) { lostHandle = true; throw cause; }
        current = run;
        void run.done.then(result => { last = result; }, () => { lostHandle = true; }); return run;
      };
      const perform = async (): Promise<AgentRunResult> => {
        if (!object(request) || request.profile?.kind !== 'codex-app-server-read-v1'
          || ['sessionId', 'turnId', 'participantId', 'workspaceId', 'cwd', 'prompt'].some(k => typeof meta[k] !== 'string' || !(meta[k] as string).trim())
          || typeof request.resume !== 'boolean' || request.maxTurns !== undefined || !object(request.env)
          || forbiddenEnvNames(request.env).length || Object.hasOwn(env, 'CODEX_API_KEY') || Object.hasOwn(request.env, 'CODEX_API_KEY')
          || request.model !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(request.model)
          || request.resume && request.persistSession === false) throw new RpcError('invalid_request', 'Некорректный запрос app-server');
        const launchEnv = { ...env, ...request.env };
        if (!isAbsolute(launchEnv.HOME ?? '') || !(launchEnv.PATH ?? '').split(delimiter).every(isAbsolute)
          || ['HOME', 'CODEX_HOME'].some(key => request.env[key] !== undefined && request.env[key] !== env[key])) throw new RpcError('invalid_request', 'Подмена окружения CLI запрещена');
        const issues = validateCodexProfile({ ...request.profile, kind: 'codex-sandbox-read-v1' }, request.cwd);
        if (issues.length) throw new RpcError(issues[0]!.reason, issues[0]!.detail);
        if (request.resume) {
          if (!isCodexThreadRef(request.thread)) throw new RpcError('invalid_request', 'Нужна собственная ссылка Codex');
          const binding: AppServerBinding = { threadId: request.thread.threadId, sessionId: request.sessionId, participantId: request.participantId,
            workspaceId: request.workspaceId, cwd: request.cwd, transport: 'app-server', profile: 'codex-app-server-read-v1' };
          if (!known.has(bindingKey(binding)) && !await step(Promise.resolve(options.verifyThread?.(binding) ?? false))) throw new RpcError('invalid_request', 'История не принадлежит этому участнику и workspace');
        } else if (request.thread !== undefined) throw new RpcError('invalid_request', 'Первый ход не принимает ссылку на историю');
        if (known.size >= 4096 || sequences.size > 4096) throw new RpcError('output_limit', 'Превышен размер реестра адаптера');
        const args = await step(appServerArgs(request.cwd, launchEnv));
        const detection = await step(options.detect ? options.detect() : detectAppServer({ start: r => track(() => runner.start(r)) }, { binaryPath: options.binaryPath, env: launchEnv }));
        if (detection.status !== 'available' || detection.auth !== 'authenticated' || !detection.binaryPath || detection.unavailable.length
          || !Object.values(detection.capabilities).every(Boolean)) throw new RpcError(detection.unavailable[0]?.reason ?? 'capability_missing', 'CLI или авторизация app-server не подтверждены');
        if (detection.version !== '0.163.0' || process.platform !== 'darwin' || process.arch !== 'arm64') throw new RpcError('profile_unsupported', 'app-server проверен только для Codex 0.163.0 на macOS arm64');
        const before = await step(identity(detection.binaryPath));
        if (JSON.stringify(args) !== JSON.stringify(await step(appServerArgs(request.cwd, launchEnv))) || before !== await step(identity(detection.binaryPath))) throw new RpcError('practical_admission_blocked', 'Конфигурация изменилась во время допуска');
        const processRun = track(() => interactive.start({ executable: detection.binaryPath!, args, cwd: request.cwd, env: launchEnv,
          stdin: '', timeoutMs, stopGraceMs: graceMs, drainTimeoutMs: 2000, maxQueueBytes: Math.max(queueBytes, 1_048_576) }));
        rpc = new CodexRpc(processRun, notify);
        await step(rpc.call('initialize', { clientInfo: { name: 'vibestudio', version: '0.0.0' }, capabilities: { experimentalApi: true } }));
        await step(rpc.notifyInitialized());
        const config = inspectAppServerConfig(await step(rpc.call('config/read', { cwd: request.cwd, includeLayers: false })), request.cwd);
        const settings = { cwd: request.cwd, approvalPolicy: 'never', permissions: 'vibestudio-read-v1', runtimeWorkspaceRoots: [request.cwd],
          developerInstructions: '', config, ...(request.model ? { model: request.model } : {}) };
        const response = await step(rpc.call(request.resume ? 'thread/resume' : 'thread/start', request.resume
          ? { ...settings, threadId: request.thread.threadId, excludeTurns: true }
          : { ...settings, historyMode: 'paginated', dynamicTools: [], ephemeral: request.persistSession === false }));
        threadId = checkThreadPolicy(response, request.cwd, request.resume ? request.thread.threadId : undefined);
        if (request.persistSession !== false) known.add(bindingKey({ threadId, sessionId: request.sessionId, participantId: request.participantId,
          workspaceId: request.workspaceId, cwd: request.cwd, transport: 'app-server', profile: 'codex-app-server-read-v1' }));
        emit({ type: 'run_started', agentSessionId: threadId });
        // Добавляем реальную инструкцию через официальный API, не меняя старые сообщения или файлы истории.
        await step(rpc.call('thread/inject_items', { threadId, items: [{ type: 'message', role: 'developer',
          content: [{ type: 'input_text', text: buildAgentInstructions({ resume: request.resume }) + '\n\n' + CODEX_PUBLIC_CONTEXT }] }] }));
        const started = await step(rpc.call('turn/start', { threadId, input: [{ type: 'text', text: request.prompt, text_elements: [] }],
          permissions: 'vibestudio-read-v1', approvalPolicy: 'never' }));
        const startedId = object(started.turn)?.id;
        if (typeof startedId !== 'string' || turnId && turnId !== startedId) throw new RpcError('protocol_incompatible', 'Неверный ID хода');
        turnId = startedId;
        await step(Promise.race([turnEnded, rpc.closed.then(() => { if (!turnResult) throw rpc!.error ?? new RpcError('missing_result', 'Нет завершения хода'); })]));
        processRun.closeInput(); await step(rpc.closed);
        if (rpc.error) throw rpc.error;
        return turnResult ?? { kind: 'error', reason: 'missing_result', detail: 'Нет результата хода' };
      };
      void (async () => {
        let result: AgentRunResult;
        try { result = await perform(); }
        catch (cause) { const error = failure ?? (cause instanceof RpcError ? cause : new RpcError('spawn_failed', 'Не удалось выполнить ход app-server')); result = { kind: 'error', reason: error.reason, detail: error.message }; }
        if (current && (!last || rpc && !turnResult || result.kind !== 'success')) await stopProcess(true);
        if (current) {
          const wait = await Promise.race([current.done, new Promise<undefined>(resolve => { const deadline = setTimeout(() => resolve(undefined), 2500); deadline.unref(); })]).catch(() => undefined);
          if (wait) last = wait; else lostHandle = true;
        }
        let completion = last?.completion ?? emptyCompletion();
        if (lostHandle || attempted && !last) completion = { ...completion, process: { state: 'unconfirmed' }, wait: 'deadline',
          issues: [...completion.issues, { code: 'exit_unconfirmed', operation: 'wait', detail: 'Завершение запуска не подтверждено' }] };
        if (extraIssues.length) completion = { ...completion, issues: [...completion.issues, ...extraIssues] };
        if (stopped) result = { kind: 'interrupted' };
        else if (failure) result = { kind: 'error', reason: failure.reason, detail: failure.message };
        else if (result.kind === 'success' && !clean(completion)) {
          const code = completion.issues[0]?.code;
          result = { kind: 'error', reason: code === 'stdin_failed' || code === 'unsupported_platform' ? 'spawn_failed' : code ?? 'exit_unconfirmed',
            detail: 'Выход и потоки app-server не подтверждены' };
        }
        finished = true; clearTimeout(timer); clearTimeout(stopTimer);
        const final = freeze({ ...result, stopAccepted: stopped, completion }) as AgentRunCompletion;
        queue.finish(wrap({ type: 'run_finished', result: final })); resolveDone(final);
      })();
      const stop = async (hard: boolean): Promise<void> => {
        if (finished) { await done; return; }
        if (stopped) { if (hard) { abort(new RpcError('unknown', 'Остановка')); await stopProcess(true); } await done; return; }
        stopped = true;
        if (!hard && rpc && threadId && turnId) {
          stopTimer = setTimeout(() => { abort(new RpcError('unknown', 'Остановка')); void stopProcess(true); }, graceMs);
          void rpc.call('turn/interrupt', { threadId, turnId }).catch(() => { abort(new RpcError('unknown', 'Остановка')); void stopProcess(true); });
        } else { abort(new RpcError('unknown', 'Остановка')); await stopProcess(hard); }
        await done;
      };
      return { events: queue, diagnostics, done, interrupt: () => stop(false), kill: () => stop(true) };
    },
  };
}
