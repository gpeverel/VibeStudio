import type { AgentEvent, AgentRunCompletion, ProcessCompletion } from '../shared/agent.ts';
import type { ProjectCommandConsentDecision } from '../shared/project-command-consent.ts';
import type { ConfirmSetupRequest, CreateSessionRequest, EventsAvailable, OperationKind, OperationView,
  ProjectView, ReadEventsRequest, RevokeConsentRequest, SelectProjectRequest, SendTurnRequest,
  SessionCommandRequest, SessionStatus, SessionView, SoloError, SoloErrorCode, SoloEvent, SoloEventPayload } from '../shared/solo.ts';
import type { AgentRun } from './ports/agent.ts';
import type { GitOperationStore, GitPort } from './ports/git.ts';
import type { Journal } from './ports/journal.ts';
import type { ProcessRun } from './ports/process-runner.ts';
import type { ProjectCommandRunner } from './ports/project-command-runner.ts';
import type { ProjectCommandRequest } from './ports/project-command-snapshot.ts';
import type { Clock, Fingerprinter, IdGen } from './ports/runtime.ts';
import type { SoloAgentPort } from './ports/solo-agent.ts';
import { StoreError } from './ports/store.ts';
import type { NewSoloEvent, OperationRecord, ParticipantRecord, ProjectRecord, SessionRecord,
  Store, StoreWrite, TurnRecord, WorkspaceRecord } from './ports/store.ts';
import type { WorkspaceFiles } from './ports/workspace-files.ts';
import type { ProjectCommandConsentPolicy } from './project-command-consent.ts';
import { completionConfirmed, completionSuccessful, soloOutcome, unconfirmedCompletion } from './solo-strategy.ts';

export class SoloEngineError extends Error {
  constructor(readonly code: SoloErrorCode, message: string) { super(message); this.name = 'SoloEngineError'; }
}
export type EngineFaultPoint = 'after_intent' | 'before_effect' | 'after_effect' | 'before_result' | 'after_result';
export interface SessionEngineOptions {
  store: Store; git: GitPort; files: WorkspaceFiles; agents: SoloAgentPort;
  commands: ProjectCommandRunner; consent: ProjectCommandConsentPolicy; journal: Journal;
  clock: Clock; ids: IdGen; fingerprints: Fingerprinter;
  /** Только чтение доказанного результата компенсации; неизвестный исход не разрешает повтор. */
  gitOperations?: Pick<GitOperationStore, 'get'>;
  setupRequest(project: ProjectRecord, workspace: WorkspaceRecord): ProjectCommandRequest;
  stopTimeoutMs?: number;
  faultInjector?: (point: EngineFaultPoint, operation: OperationRecord) => void | Promise<void>;
}
interface Context { session: SessionRecord; workspace: WorkspaceRecord; participant: ParticipantRecord; project: ProjectRecord }
interface Active {
  operationId: string; sessionId: string; workspaceId: string; turnId: string | null;
  stopAccepted: boolean; signalFailed: boolean; finalized: boolean; run?: AgentRun | ProcessRun;
  interrupting?: Promise<void>;
}
const terminal = new Set(['completed', 'failed', 'uncertain']);
const limitations = ['cli_configuration_not_audited', 'os_isolation_not_attested', 'network_not_restricted', 'detached_children_not_guaranteed'];

/** Один владелец Store в main. Намерения фиксируются до любого внешнего эффекта.
 * Восстановление неизвестного эффекта никогда не означает его автоматический повтор. */
export function createSessionEngine(options: SessionEngineOptions) {
  const { store, ids, clock } = options;
  const instanceId = ids.next();
  const active = new Map<string, Active>();
  const tasks = new Set<Promise<void>>();
  const listeners = new Set<(notice: EventsAvailable) => void>();
  const pendingSelections = new Map<string, Promise<ProjectView | null>>();
  let failed = false, recovered = false, journalFailed = false, shuttingDown = false;
  const stopTimeout = options.stopTimeoutMs ?? 6000;

  function error(code: SoloErrorCode, message: string): never { throw new SoloEngineError(code, message); }
  function available(): void {
    if (failed || store.failed) error('store_failed', 'Запись состояния недоступна. Новые запуски остановлены.');
    if (!recovered || shuttingDown) error('recovery_required', 'Приложение восстанавливает или завершает работу.');
  }
  function storage<T>(work: () => T, sessionId?: string | null): T {
    try { return work(); } catch (cause) {
      if (store.failed || cause instanceof StoreError && cause.code === 'store_failed') {
        failed = true;
        for (const item of active.values()) { item.stopAccepted = true; if (item.run) void safeInterrupt(item); }
        error('store_failed', 'Не удалось записать состояние. Активным запускам отправлена остановка.');
      }
      if (cause instanceof StoreError && cause.code === 'request_conflict') error('request_conflict', 'requestId уже относится к другому содержимому.');
      if (cause instanceof StoreError && cause.code === 'constraint') {
        if (sessionId) void diagnostic(sessionId, 'store_constraint', cause.message).catch(() => undefined);
        error('busy', 'Операция конфликтует с сохранённым состоянием.');
      }
      throw cause;
    }
  }
  function announce(events: readonly SoloEvent[]): void {
    const latest = new Map<string, number>();
    for (const event of events) latest.set(event.sessionId, event.seq);
    for (const [sessionId, seq] of latest) for (const listener of listeners) {
      try { listener({ sessionId, seq }); } catch { /* UI не откатывает commit. */ }
    }
  }
  function commit(write: StoreWrite): void {
    const sessionId = write.events?.[0]?.sessionId ?? write.sessions?.[0]?.id ?? write.operations?.[0]?.sessionId;
    announce(storage(() => store.commit(write), sessionId));
  }
  function event(sessionId: string, payload: SoloEventPayload): NewSoloEvent {
    return { id: ids.next(), sessionId, timestamp: clock.now(), payload };
  }
  function state(session: SessionRecord, status: SessionStatus, detail: string): SessionRecord {
    return { ...session, status, detail, updatedAt: clock.now() };
  }
  function opPatch(operation: OperationRecord, patch: Partial<OperationRecord>): OperationRecord {
    return { ...operation, ...patch, updatedAt: clock.now() };
  }
  function fingerprint(kind: OperationKind, request: object): string { return options.fingerprints.digest(canonical({ kind, request })); }
  function repeated(kind: OperationKind, request: { requestId: string }): OperationRecord | undefined {
    available();
    const existing = store.findOperation(request.requestId);
    if (existing && existing.fingerprint !== fingerprint(kind, request)) error('request_conflict', 'requestId уже относится к другой команде.');
    return existing;
  }
  function operation(kind: OperationKind, request: { requestId: string }, context?: Context): OperationRecord {
    const now = clock.now();
    return { id: ids.next(), requestId: request.requestId, kind, sessionId: context?.session.id ?? null,
      workspaceId: context?.workspace.id ?? null, projectId: context?.project.id ?? null, turnId: null,
      fingerprint: fingerprint(kind, request), status: 'pending', phase: 'intent_saved', error: null,
      result: null, createdAt: now, updatedAt: now };
  }
  function begin(op: OperationRecord, write?: StoreWrite) {
    const result = storage(() => store.beginOperation(op, write), op.sessionId); announce(result.events); return result;
  }
  function context(sessionId: string): Context {
    const session = store.getSession(sessionId);
    if (!session) error('not_found', 'Сессия не найдена.');
    const workspace = store.getSessionWorkspace(sessionId), participant = store.getSessionParticipant(sessionId);
    const project = store.getProject(session.projectId);
    if (!workspace || !participant || !project || workspace.sessionId !== sessionId
        || participant.sessionId !== sessionId || participant.workspaceId !== workspace.id) error('foreign_entity', 'Принадлежность workspace и участника не подтверждена.');
    return { session, workspace, participant, project };
  }
  function free(c: Context): void {
    if (c.session.status === 'recovery_required') error('recovery_required', 'Сессия требует сверки после неопределённого исхода.');
    const lease = store.getLease(c.workspace.id);
    if (lease && lease.state !== 'released') error(lease.state === 'uncertain' ? 'recovery_required' : 'busy',
      lease.state === 'uncertain' ? 'Исход предыдущего запуска не подтверждён.' : 'В этой рабочей области уже выполняется операция.');
    if (c.workspace.state !== 'ready') error('recovery_required', 'Рабочая область недоступна или требует сверки.');
  }
  async function checkpoint(point: EngineFaultPoint, op: OperationRecord): Promise<void> { await options.faultInjector?.(point, op); }
  async function finishCompensatedCreation(op: OperationRecord): Promise<boolean> {
    if (op.kind !== 'create_session' || !op.sessionId || !options.gitOperations) return false;
    const saved = await options.gitOperations.get(op.id), c = context(op.sessionId);
    if (!saved || saved.kind !== 'create' || saved.requestId !== op.id || saved.phase !== 'completed'
        || !saved.error || saved.cleanupError || saved.workspaceResult || !saved.creation
        || !['completed', 'not_needed'].includes(saved.creation.cleanup)
        || saved.identity.projectPath !== c.project.canonicalPath || saved.identity.workspacePath !== c.workspace.path
        || saved.identity.sessionId !== c.session.id || saved.identity.branch !== c.workspace.branch
        || saved.identity.baseRef !== c.workspace.baseRef) return false;
    if (saved.creation.cleanup === 'not_needed' && (saved.creation.branchCreated || saved.creation.baseRefCreated || saved.creation.worktreeCreated)) return false;
    if (await options.files.inspect(c.workspace) !== 'missing') return false;
    const detail = 'Создать рабочую область не удалось. Подтверждён откат созданных ресурсов; автоматического повтора нет.';
    commit({ operations: [opPatch(op, { status: 'failed', phase: 'result_saved', error: { code: 'workspace_failed', message: detail } })],
      sessions: [state(c.session, 'error', detail)], workspaces: [{ ...c.workspace, state: 'missing', setupDecision: null }],
      leases: [{ workspaceId: c.workspace.id, operationId: op.id, state: 'released' }],
      events: [event(c.session.id, { type: 'session_state', status: 'error', detail }),
        event(c.session.id, { type: 'diagnostic', code: 'workspace_creation_compensated', detail: `Git: ${saved.error.code}; cleanup: ${saved.creation.cleanup}.` })] });
    return true;
  }
  function launch(op: OperationRecord, work: () => Promise<void>): void {
    const task = work().catch(async cause => {
      if (failed || store.failed) {
        failed = true;
        for (const item of active.values()) { item.stopAccepted = true; if (item.run) void safeInterrupt(item); }
        return;
      }
      try {
        const current = store.getOperation(op.id);
        if (!current || terminal.has(current.status)) return;
        if (current.kind === 'stop' || current.kind === 'revoke_consent') {
          // Команда управления не владеет слотом исходного запуска и не меняет его результат.
          const detail = 'Команда управления завершилась ошибкой. Состояние исходного запуска и его блокировка сохранены.';
          commit({ operations: [opPatch(current, { status: 'failed', phase: 'result_saved',
            error: { code: current.kind === 'stop' ? 'signal_failed' : 'internal_error', message: detail } })],
            events: current.sessionId ? [event(current.sessionId, { type: 'diagnostic', code: 'control_operation_failed', detail })] : [] });
          return;
        }
        if (await finishCompensatedCreation(current)) return;
        const item = active.get(op.id);
        // После вызова start исключение не доказывает, что дочерний процесс не появился.
        const uncertain = current.phase !== 'intent_saved' || Boolean(item?.run);
        if (item?.run) { item.stopAccepted = true; void safeInterrupt(item); }
        const detail = cause instanceof SoloEngineError ? cause.message : 'Операция завершилась ошибкой; исход внешнего эффекта требует проверки.';
        if (op.sessionId && op.workspaceId) {
          const c = context(op.sessionId), status = uncertain ? 'recovery_required' : 'error';
          commit({ operations: [opPatch(current, { status: uncertain ? 'uncertain' : 'failed', phase: uncertain ? 'uncertain' : 'result_saved',
            error: { code: uncertain ? 'recovery_required' : 'internal_error', message: detail } })],
          sessions: [state(c.session, status, detail)],
          turns: current.turnId ? [{ ...store.getTurn(current.turnId)!, status: uncertain ? 'uncertain' : 'failed', endedAt: clock.now() }] : [],
          leases: [{ workspaceId: op.workspaceId, operationId: op.id, state: uncertain ? 'uncertain' : 'released' }],
          events: [event(op.sessionId, { type: 'session_state', status, detail })] });
        }
      } catch { failed = true; }
    }).finally(() => { tasks.delete(task); });
    tasks.add(task);
  }
  async function diagnostic(sessionId: string, code: string, detail: string): Promise<void> {
    if (journalFailed) return;
    try { await options.journal.append({ timestamp: clock.now(), sessionId, code, detail }); }
    catch {
      journalFailed = true;
      if (!failed && !store.failed) commit({ events: [event(sessionId, { type: 'diagnostic', code: 'journal_failed',
        detail: 'Диагностический журнал недоступен. История состояния сохраняется в SQLite.' })] });
    }
  }
  function projectView(project: ProjectRecord): ProjectView {
    return { id: project.id, name: project.name, configVersion: project.configVersion,
      setup: project.config.setup ? commandLabel(project.config.setup) : null };
  }
  function getSession(request: { sessionId: string }): SessionView {
    const c = context(request.sessionId), lease = store.getLease(c.workspace.id);
    const idle = !lease || lease.state === 'released';
    const ready = c.workspace.state === 'ready' && ['not_configured', 'completed'].includes(c.workspace.setupState);
    const writable = !failed && !store.failed && recovered && !shuttingDown;
    const canSend = idle && ready && writable && !['recovery_required', 'preparing'].includes(c.session.status);
    const turns = store.listTurns(c.session.id);
    const command = c.project.config.setup ? setupRequest(c.project, c.workspace) : null;
    return { id: c.session.id, projectId: c.project.id, title: c.session.title, status: c.session.status, detail: c.session.detail,
      participant: { id: c.participant.id, cli: c.participant.cli, profile: c.participant.profile, context: c.participant.context },
      workspace: { id: c.workspace.id, state: c.workspace.state, branch: c.workspace.branch },
      setup: { state: c.workspace.setupState, command: c.project.config.setup ? commandLabel(c.project.config.setup) : null,
        decision: c.workspace.setupDecision, completion: c.workspace.setupCompletion,
        ...(command ? { execution: { cwd: command.cwd, configVersion: c.workspace.configVersion,
          environmentNames: Object.keys(command.env).sort(), permissions: { ...command.permissions } } } : {}) },
      result: turns.at(-1)?.result ?? null, limitations,
      actions: { send: canSend && ['new', 'available'].includes(c.participant.context), newConversation: canSend,
        stop: writable && [...active.values()].some(item => item.sessionId === c.session.id && !item.finalized),
        prepareSetup: writable && idle && c.workspace.state === 'ready' && ['pending', 'needs_consent'].includes(c.workspace.setupState),
        reason: !writable ? 'Запуск недоступен: приложение не может безопасно сохранять состояние.'
          : !idle ? 'Предыдущая операция ещё не завершена или её исход неизвестен.'
          : !ready ? 'Сначала завершите подготовку рабочей области.'
          : ['missing', 'unknown'].includes(c.participant.context) ? 'Продолжение недоступно. Можно явно начать новый диалог с потерей контекста.' : null },
      updatedAt: c.session.updatedAt };
  }

  async function selectProject(request: SelectProjectRequest, choose: () => Promise<string | null>): Promise<ProjectView | null> {
    const old = repeated('select_project', request);
    if (old) {
      if (old.error) error(old.error.code, old.error.message);
      const pending = pendingSelections.get(old.id); if (pending) return pending;
      const found = old.result?.projectId ? store.getProject(old.result.projectId) : undefined;
      return found ? projectView(found) : null;
    }
    const accepted = begin(operation('select_project', request)), op = accepted.operation;
    if (!accepted.created) {
      if (op.error) error(op.error.code, op.error.message);
      const saved = op.result?.projectId ? store.getProject(op.result.projectId) : undefined;
      return saved ? projectView(saved) : null;
    }
    const task = (async () => {
      try {
        const path = await choose();
        if (!path) { commit({ operations: [opPatch(op, { status: 'completed', phase: 'result_saved', result: { projectId: null } })] }); return null; }
        const inspected = await options.files.inspectProject(path);
        const existing = store.findProjectByPath(inspected.canonicalPath);
        const project: ProjectRecord = { ...inspected, id: existing?.id ?? ids.next(),
          configVersion: existing ? existing.configVersion + (canonical(existing.config) === canonical(inspected.config) ? 0 : 1) : 1 };
        commit({ projects: [project], operations: [opPatch(op, { status: 'completed', phase: 'result_saved', projectId: project.id, result: { projectId: project.id } })] });
        return projectView(project);
      } catch (cause) {
        if (!failed && !store.failed) commit({ operations: [opPatch(op, { status: 'failed', phase: 'result_saved', error: { code: 'workspace_failed', message: 'Не удалось открыть выбранный Git-проект.' } })] });
        throw cause;
      } finally { pendingSelections.delete(op.id); }
    })();
    pendingSelections.set(op.id, task); return task;
  }

  async function createSession(request: CreateSessionRequest): Promise<OperationView> {
    const old = repeated('create_session', request); if (old) return viewOperation(old);
    const project = store.getProject(request.projectId); if (!project) error('not_found', 'Проект не найден.');
    const sessionId = ids.next(), workspaceId = ids.next(), participantId = ids.next(), now = clock.now();
    const session: SessionRecord = { id: sessionId, projectId: project.id, title: request.title ?? project.name,
      status: 'preparing', detail: 'Создаётся изолированная рабочая область.', createdAt: now, updatedAt: now };
    const workspace: WorkspaceRecord = { id: workspaceId, sessionId, path: options.files.allocatePath(sessionId), branch: `vs/${sessionId}`,
      baseRef: project.defaultBranch, initialBaseSha: null, state: 'creating', setupState: project.config.setup ? 'pending' : 'not_configured',
      setupDecision: null, setupCompletion: null, configVersion: project.configVersion };
    const participant: ParticipantRecord = { id: participantId, sessionId, workspaceId, cli: request.cli,
      profile: request.cli === 'claude' ? 'practical-local-v1' : 'codex-app-server-read-v1', agentSessionId: null, context: 'new' };
    const op = operation('create_session', request, { session, workspace, participant, project });
    const accepted = begin(op, { sessions: [session], workspaces: [workspace], participants: [participant],
      leases: [{ workspaceId, operationId: op.id, state: 'held' }], events: [event(sessionId, { type: 'session_state', status: session.status, detail: session.detail })] });
    if (!accepted.created) return viewOperation(accepted.operation);
    launch(op, async () => {
      await checkpoint('after_intent', op);
      const pending = opPatch(op, { status: 'running', phase: 'effect_pending' });
      commit({ operations: [pending], events: [event(sessionId, { type: 'diagnostic', code: 'workspace_effect_pending',
        detail: 'Намерение сохранено. Следующий шаг может создать Git-worktree.' })] });
      await checkpoint('before_effect', pending); available();
      const result = await options.git.createWorkspace({ requestId: op.id, projectPath: project.canonicalPath,
        workspacePath: workspace.path, sessionId, branch: workspace.branch, baseRef: workspace.baseRef });
      await checkpoint('after_effect', pending);
      const created: WorkspaceRecord = { ...workspace, state: 'ready', initialBaseSha: result.baseSha };
      await options.files.copyFiles(project, created);
      const decision = project.config.setup ? await options.consent.evaluate(setupRequest(project, created)) : null;
      const status = decision ? 'needs_consent' : 'ready';
      const detail = decision ? 'Подготовка требует отдельного решения на команду проекта.' : 'Рабочая область готова. Доступен профиль чтения.';
      await checkpoint('before_result', pending);
      commit({ workspaces: [{ ...created, setupDecision: decision, setupState: decision ? 'needs_consent' : 'not_configured' }],
        sessions: [state(session, status, detail)], operations: [opPatch(pending, { status: 'completed', phase: 'result_saved', result: { sessionId } })],
        leases: [{ workspaceId, operationId: op.id, state: 'released' }],
        events: [event(sessionId, { type: 'session_state', status, detail }),
          ...(decision ? [event(sessionId, { type: 'setup', state: 'needs_consent', decision, completion: null })] : [])] });
      await checkpoint('after_result', pending); await diagnostic(sessionId, 'workspace_ready', 'Подготовлена рабочая область.');
    });
    return viewOperation(op);
  }

  function setupRequest(project: ProjectRecord, workspace: WorkspaceRecord): ProjectCommandRequest {
    const request = freeze(JSON.parse(JSON.stringify(options.setupRequest(project, workspace))) as ProjectCommandRequest);
    if (request.projectId !== project.id || request.projectRoot !== workspace.path || request.cwd !== workspace.path
        || request.operationId !== `setup:${workspace.id}` || request.purpose !== 'setup'
        || canonical(request.command) !== canonical(project.config.setup)) error('invalid_request', 'Неверная область именованной подготовки.');
    return request;
  }
  async function setup(request: SessionCommandRequest | ConfirmSetupRequest, confirm: boolean): Promise<OperationView> {
    const kind = confirm ? 'confirm_setup' : 'prepare_setup', old = repeated(kind, request); if (old) return viewOperation(old);
    const c = context(request.sessionId); free(c);
    if (!c.project.config.setup || !['pending', 'needs_consent'].includes(c.workspace.setupState)) error('invalid_transition', 'Повтор уже исполненной или прерванной подготовки требует новой рабочей области.');
    if (confirm && (!('challengeId' in request) || c.workspace.setupDecision?.status !== 'needs_consent'
        || c.workspace.setupDecision.challengeId !== request.challengeId)) error('consent_blocked', 'Запрос согласия не принадлежит этой сессии или устарел.');
    const op = operation(kind, request, c), item: Active = { operationId: op.id, sessionId: c.session.id,
      workspaceId: c.workspace.id, turnId: null, stopAccepted: false, signalFailed: false, finalized: false };
    const accepted = begin(op, { leases: [{ workspaceId: c.workspace.id, operationId: op.id, state: 'held' }] });
    if (!accepted.created) return viewOperation(accepted.operation);
    active.set(op.id, item);
    launch(op, async () => {
      await checkpoint('after_intent', op);
      const command = setupRequest(c.project, c.workspace);
      const decision = confirm ? await options.consent.confirm((request as ConfirmSetupRequest).challengeId) : await options.consent.evaluate(command);
      if (decision.status !== 'allowed' || item.stopAccepted) { finishBlockedSetup(op, item, decision); return; }
      const pending = opPatch(op, { status: 'running', phase: 'effect_pending' });
      commit({ operations: [pending], sessions: [state(c.session, 'preparing', 'Выполняется согласованная подготовка.')],
        workspaces: [{ ...c.workspace, setupState: 'running', setupDecision: decision }],
        events: [event(c.session.id, { type: 'setup', state: 'running', decision, completion: null })] });
      await checkpoint('before_effect', pending); available();
      if (item.stopAccepted) { finishBlockedSetup(pending, item, decision); return; }
      const started = await options.commands.start(command, { consentId: decision.consentId, fingerprint: decision.fingerprint,
        recheck: async current => {
          if (current !== command || item.stopAccepted || failed || store.failed) return blockedConsent();
          const verdict = await options.consent.recheck(command);
          return item.stopAccepted || failed || store.failed ? blockedConsent() : verdict;
        } }, c.project.config.setupTimeoutMs);
      if (started.status === 'blocked') { finishBlockedSetup(pending, item, started.decision); return; }
      item.run = started.run;
      if (item.stopAccepted || failed || store.failed) void safeInterrupt(item);
      await checkpoint('after_effect', pending);
      if (item.finalized || failed || store.failed) return;
      commit({ operations: [opPatch(pending, { phase: 'effect_started', result: { processIdentity: {
        runId: ids.next(), applicationInstanceId: instanceId, pid: started.run.pid, cwd: command.cwd,
        requestedExecutable: command.command.kind === 'direct' ? command.command.executable : 'npm', spawnObservedAt: clock.now(), osCreatedAt: null,
      } } })], events: [event(c.session.id, { type: 'diagnostic', code: 'setup_process_started', detail: 'Получен дескриптор управляемого запуска подготовки.' })] });
      const drains = Promise.all([drain(started.run.stdout), drain(started.run.stderr)]);
      const result = await started.run.done;
      await bounded(drains, stopTimeout).catch(() => { item.signalFailed = true; });
      if (item.finalized || failed || store.failed) return;
      await checkpoint('before_result', pending);
      await item.interrupting;
      if (item.finalized || failed || store.failed) return;
      const completion = withSignalFailure(result.completion, item.signalFailed);
      const confirmed = completionConfirmed(completion), success = confirmed && !item.stopAccepted && completion.process.state === 'exited'
        && completion.process.exitCode === 0 && completion.issues.length === 0;
      const latest = context(c.session.id), status = !confirmed ? 'recovery_required' : success ? 'ready' : item.stopAccepted ? 'interrupted' : 'error';
      const setupState = !confirmed ? 'uncertain' : success ? 'completed' : 'failed';
      const detail = success ? 'Подготовка завершена.' : !confirmed ? 'Завершение подготовки не подтверждено. Повтор заблокирован.' : 'Подготовка не завершена успешно. Создайте новую рабочую область.';
      commit({ sessions: [state(latest.session, status, detail)], workspaces: [{ ...latest.workspace, setupState, setupCompletion: completion }],
        operations: [opPatch(store.getOperation(op.id)!, { status: !confirmed ? 'uncertain' : success ? 'completed' : 'failed', phase: !confirmed ? 'uncertain' : 'result_saved' }), ...stopResults(item, confirmed)],
        leases: [{ workspaceId: item.workspaceId, operationId: op.id, state: confirmed ? 'released' : 'uncertain' }],
        events: [event(c.session.id, { type: 'session_state', status, detail }), event(c.session.id, { type: 'setup', state: setupState, decision, completion })] });
      item.finalized = true; active.delete(op.id); await checkpoint('after_result', pending);
    });
    return viewOperation(op);
  }
  function finishBlockedSetup(op: OperationRecord, item: Active, decision: ProjectCommandConsentDecision): void {
    const c = context(item.sessionId), status = item.stopAccepted ? 'interrupted' : 'needs_consent';
    const detail = item.stopAccepted ? 'Подготовка остановлена до запуска команды.' : 'Команда не запущена: требуется актуальное конкретное согласие.';
    commit({ sessions: [state(c.session, status, detail)], workspaces: [{ ...c.workspace, setupState: 'needs_consent', setupDecision: decision }],
      operations: [opPatch(op, { status: 'completed', phase: 'result_saved' }), ...stopResults(item, true)],
      leases: [{ workspaceId: item.workspaceId, operationId: op.id, state: 'released' }],
      events: [event(item.sessionId, { type: 'session_state', status, detail }), event(item.sessionId, { type: 'setup', state: 'needs_consent', decision, completion: null })] });
    item.finalized = true; active.delete(op.id);
  }
  async function revokeConsent(request: RevokeConsentRequest): Promise<OperationView> {
    const old = repeated('revoke_consent', request); if (old) return viewOperation(old);
    const c = context(request.sessionId), saved = store.getConsent(request.consentId);
    if (!saved || saved.operationId !== `setup:${c.workspace.id}` || saved.projectId !== c.project.id) error('foreign_entity', 'Согласие не принадлежит этой рабочей области.');
    const accepted = begin(operation('revoke_consent', request, c)), op = accepted.operation;
    if (!accepted.created) return viewOperation(op);
    storage(() => options.consent.revoke(request.consentId));
    const final = opPatch(op, { status: 'completed', phase: 'result_saved' });
    commit({ operations: [final], workspaces: [{ ...c.workspace, setupDecision: null }],
      events: [event(c.session.id, { type: 'diagnostic', code: 'consent_revoked', detail: 'Согласие отозвано. Уже начатая команда этим не останавливается.' })] });
    return viewOperation(final);
  }

  async function sendTurn(request: SendTurnRequest): Promise<OperationView> {
    const old = repeated('send_turn', request); if (old) return viewOperation(old);
    const c = context(request.sessionId); free(c);
    if (!['not_configured', 'completed'].includes(c.workspace.setupState)) error('invalid_transition', 'Подготовка рабочей области не завершена.');
    if (request.conversation === 'continue' && ['missing', 'unknown'].includes(c.participant.context)) error('history_missing', 'История CLI недоступна. Новый диалог требует явного выбора.');
    const op = operation('send_turn', request, c), now = clock.now(), turnId = ids.next(); op.turnId = turnId;
    const turn: TurnRecord = { id: turnId, participantId: c.participant.id, sessionId: c.session.id, workspaceId: c.workspace.id,
      seq: (store.listTurns(c.session.id).at(-1)?.seq ?? 0) + 1, prompt: request.prompt, conversation: request.conversation,
      status: 'starting', operationId: op.id, startedAt: now, endedAt: null, result: null,
      processIdentity: { runId: ids.next(), applicationInstanceId: instanceId, cwd: c.workspace.path } };
    const participant: ParticipantRecord = request.conversation === 'new' ? { ...c.participant, agentSessionId: null, context: 'new' } : c.participant;
    const item: Active = { operationId: op.id, sessionId: c.session.id, workspaceId: c.workspace.id, turnId,
      stopAccepted: false, signalFailed: false, finalized: false };
    const detail = request.conversation === 'new' && c.participant.agentSessionId ? 'Начат новый диалог. Контекст прежней CLI-беседы не передаётся.' : 'Запускается ход в профиле чтения.';
    const accepted = begin(op, { participants: [participant], turns: [turn], sessions: [state(c.session, 'running', detail)],
      leases: [{ workspaceId: c.workspace.id, operationId: op.id, state: 'held' }],
      events: [event(c.session.id, { type: 'user_message', turnId, text: request.prompt, conversation: request.conversation }),
        event(c.session.id, { type: 'session_state', status: 'running', detail })] });
    if (!accepted.created) return viewOperation(accepted.operation);
    active.set(op.id, item);
    launch(op, async () => {
      await checkpoint('after_intent', op);
      if (participant.agentSessionId) {
        const history = await options.agents.history(participant, c.workspace);
        if (history !== 'available') {
          commit({ participants: [{ ...participant, context: history }], events: [event(c.session.id, {
            type: 'recovery', code: 'history_missing', detail: 'История CLI недоступна. Продолжение не запускалось.' })] });
          await finishAgent(op, item, missingHistoryResult(), undefined); return;
        }
      }
      if (item.stopAccepted) { await finishAgent(op, item, notStartedResult(), undefined); return; }
      const pending = opPatch(op, { status: 'running', phase: 'effect_pending' });
      commit({ operations: [pending], events: [event(c.session.id, { type: 'diagnostic', code: 'agent_effect_pending',
        detail: 'Намерение сохранено. Следующий шаг может запустить закреплённую CLI.' })] });
      await checkpoint('before_effect', pending); available();
      if (item.stopAccepted) { await finishAgent(op, item, notStartedResult(), undefined); return; }
      const run = await options.agents.start({ participant, turn, workspace: c.workspace, onProcessStarted: identity => {
        if (item.finalized || failed || store.failed) error('store_failed', 'Новый процесс после завершения управления запуском запрещён.');
        const current = store.getTurn(turnId)!;
        commit({ turns: [{ ...current, processIdentity: { ...current.processIdentity!, ...identity, osCreatedAt: null } }],
          events: [event(c.session.id, { type: 'diagnostic', code: 'cli_process_started', detail: 'Сохранены доступные метаданные собственного процесса CLI; принадлежность после restart ими не подтверждается.' })] });
      } }); item.run = run;
      if (item.stopAccepted || failed || store.failed) void safeInterrupt(item);
      await checkpoint('after_effect', pending);
      if (item.finalized || failed || store.failed) return;
      commit({ operations: [opPatch(pending, { phase: 'effect_started' })], turns: [{ ...store.getTurn(turnId)!, status: item.stopAccepted ? 'stopping' : 'running' }],
        events: [event(c.session.id, { type: 'diagnostic', code: 'agent_handle_received', detail: 'Получен управляемый запуск адаптера; результат задачи ещё не известен.' })] });
      let terminalEvent: Extract<AgentEvent, { type: 'run_finished' }> | undefined, streamFailed = false;
      const pump = (async () => {
        let receivedCount = 0;
        for await (const received of run.events) {
          if (failed || store.failed) break;
          if (received.sessionId !== c.session.id || received.participantId !== participant.id || received.turnId !== turnId) throw new SoloEngineError('foreign_entity', 'Адаптер прислал событие чужого хода.');
          if (item.finalized) {
            if (received.type === 'run_finished') commit({ events: [event(c.session.id, { type: 'diagnostic', code: 'late_agent_result',
              detail: `Поздний результат задачи: ${received.result.kind}. Состояние и блокировка workspace не изменены.` })] });
            break;
          }
          if (received.type === 'run_finished') { if (terminalEvent) throw new Error('duplicate terminal'); terminalEvent = received; continue; }
          if (terminalEvent) throw new Error('event after terminal');
          const current = store.getParticipant(participant.id)!;
          commit({ participants: received.type === 'run_started' ? [{ ...current, agentSessionId: received.agentSessionId, context: 'available' }] : [],
            events: [{ id: received.eventId, sessionId: c.session.id, timestamp: received.timestamp, payload: { type: 'agent', event: received } }] });
          if (++receivedCount % 32 === 0) await delay(0);
        }
      })().catch(() => { streamFailed = true; if (!item.finalized) void safeInterrupt(item); });
      let result = await run.done;
      await bounded(pump, stopTimeout).catch(() => { streamFailed = true; });
      if (streamFailed || !terminalEvent || canonical(terminalEvent.result) !== canonical(result)) {
        result = { kind: 'error', reason: 'protocol_incompatible', detail: 'Поток и завершение адаптера не согласованы.',
          stopAccepted: result.stopAccepted, completion: streamFailed ? { ...result.completion,
            issues: [...result.completion.issues, { code: 'stream_failed', operation: 'stdout', detail: 'Поток событий не подтверждён.' }] } : result.completion };
      }
      await finishAgent(pending, item, result, terminalEvent);
    });
    return viewOperation(op);
  }
  async function finishAgent(op: OperationRecord, item: Active, input: AgentRunCompletion, supplied: AgentEvent | undefined): Promise<void> {
    if (item.finalized || failed || store.failed) return;
    await checkpoint('before_result', op);
    await item.interrupting;
    if (item.finalized || failed || store.failed) return;
    const c = context(item.sessionId), turn = store.getTurn(item.turnId!)!;
    const completion = withSignalFailure(input.completion, item.signalFailed);
    const result: AgentRunCompletion = item.stopAccepted ? { kind: 'interrupted', stopAccepted: true, completion }
      : input.kind === 'success' && !completionSuccessful(completion)
        ? { kind: 'error', reason: 'nonzero_exit', detail: 'Ответ модели не подтверждён успешным завершением процесса.', stopAccepted: input.stopAccepted, completion }
        : { ...input, completion };
    const status = soloOutcome(result, item.stopAccepted), confirmed = completionConfirmed(completion);
    const detail = status === 'answered' ? 'Ответ получен. Автоматические проверки не запускались.'
      : status === 'recovery_required' ? 'Завершение запуска не подтверждено. Новые эффекты заблокированы.'
      : status === 'interrupted' ? 'Ход остановлен.' : result.kind === 'error' ? result.detail : 'Ход не завершён успешно.';
    const finished: AgentEvent = { schemaVersion: 1, eventId: supplied?.eventId ?? ids.next(), sessionId: c.session.id,
      turnId: turn.id, participantId: c.participant.id, seq: supplied?.seq ?? 1, timestamp: clock.now(), type: 'run_finished', result };
    commit({ sessions: [state(c.session, status, detail)], turns: [{ ...turn, result, endedAt: clock.now(),
      status: !confirmed ? 'uncertain' : status === 'answered' ? 'completed' : status === 'interrupted' ? 'interrupted' : 'failed' }],
      operations: [opPatch(store.getOperation(op.id)!, { status: !confirmed ? 'uncertain' : status === 'answered' || status === 'interrupted' ? 'completed' : 'failed',
        phase: !confirmed ? 'uncertain' : 'result_saved', error: status === 'error' ? { code: 'adapter_unavailable', message: detail } : null }), ...stopResults(item, confirmed)],
      leases: [{ workspaceId: c.workspace.id, operationId: op.id, state: confirmed ? 'released' : 'uncertain' }],
      events: [{ id: finished.eventId, sessionId: c.session.id, timestamp: finished.timestamp, payload: { type: 'agent', event: finished } },
        event(c.session.id, { type: 'session_state', status, detail }),
        ...(item.stopAccepted && input.kind === 'success' ? [event(c.session.id, { type: 'diagnostic', code: 'late_agent_result',
          detail: 'После принятого Stop получен результат success. Он сохранён как наблюдение, продолжение не запускается.' })] : [])] });
    item.finalized = true; active.delete(op.id); await checkpoint('after_result', op);
    await diagnostic(c.session.id, 'turn_finished', `Состояние хода: ${status}`);
  }
  function stopResults(item: Active, confirmed: boolean): OperationRecord[] {
    return store.listOperations().filter(op => op.kind === 'stop' && op.sessionId === item.sessionId
      && op.workspaceId === item.workspaceId && !terminal.has(op.status)).map(op => opPatch(op, {
      status: confirmed ? 'completed' : 'uncertain', phase: confirmed ? 'result_saved' : 'uncertain',
      error: confirmed ? null : { code: 'recovery_required', message: 'Завершение запуска не подтверждено.' } }));
  }
  async function safeInterrupt(item: Active): Promise<void> {
    if (!item.run) return;
    const run = item.run;
    item.interrupting ??= (async () => {
      try { await bounded(Promise.resolve().then(() => run.interrupt()), stopTimeout); }
      catch { item.signalFailed = true; }
    })();
    await item.interrupting;
  }
  async function stop(request: SessionCommandRequest): Promise<OperationView> {
    const old = repeated('stop', request); if (old) return viewOperation(old);
    const c = context(request.sessionId), item = [...active.values()].find(value => value.sessionId === request.sessionId && !value.finalized);
    const op = operation('stop', request, c); op.turnId = item?.turnId ?? null;
    if (!item) {
      if (store.getLease(c.workspace.id)?.state === 'uncertain') error('recovery_required', 'После перезапуска нет доказанного владения процессом. Сигнал старому PID не отправляется.');
      const complete = opPatch(op, { status: 'completed', phase: 'result_saved' }); return viewOperation(begin(complete).operation);
    }
    const firstStop = !item.stopAccepted;
    const accepted = begin(op, { sessions: [state(c.session, 'stopping', 'Остановка принята. Ожидается подтверждение выхода.')],
      turns: item.turnId ? [{ ...store.getTurn(item.turnId)!, status: 'stopping' }] : [],
      events: [event(c.session.id, { type: 'session_state', status: 'stopping', detail: 'Остановка принята. Ожидается подтверждение выхода.' })] });
    if (!accepted.created) return viewOperation(accepted.operation);
    item.stopAccepted = true;
    if (firstStop) {
      launch(op, async () => {
        await safeInterrupt(item);
        if (item.finalized || failed || store.failed) return;
        const wait = item.run?.done;
        if (wait) await bounded<unknown>(wait, stopTimeout).catch(() => undefined);
        else await delay(stopTimeout);
        // В норме consume завершает запись; отдельный конечный deadline не зависит от исправности адаптера.
        await delay(0);
        if (item.finalized || failed || store.failed) return;
        if (item.turnId) await finishAgent(store.getOperation(item.operationId)!, item,
          { kind: 'interrupted', stopAccepted: true, completion: withSignalFailure(unconfirmedCompletion(), item.signalFailed) }, undefined);
        else {
          const latest = context(item.sessionId), detail = 'Завершение подготовки не подтверждено.';
          commit({ sessions: [state(latest.session, 'recovery_required', detail)],
            workspaces: [{ ...latest.workspace, setupState: 'uncertain', setupCompletion: unconfirmedCompletion() }],
            operations: [opPatch(store.getOperation(item.operationId)!, { status: 'uncertain', phase: 'uncertain' }), ...stopResults(item, false)],
            leases: [{ workspaceId: item.workspaceId, operationId: item.operationId, state: 'uncertain' }],
            events: [event(item.sessionId, { type: 'session_state', status: 'recovery_required', detail })] });
          item.finalized = true; active.delete(item.operationId);
        }
      });
    }
    return viewOperation(op);
  }

  async function recover(): Promise<void> {
    if (recovered) return;
    for (const op of store.listOperations()) {
      if (terminal.has(op.status)) continue;
      if (!op.sessionId || !op.workspaceId) {
        commit({ operations: [opPatch(op, { status: 'failed', phase: 'result_saved', error: { code: 'recovery_required', message: 'Команда прервана перезапуском.' } })] }); continue;
      }
      const c = context(op.sessionId), physical = await options.files.inspect(c.workspace);
      if (await finishCompensatedCreation(op)) continue;
      if (op.kind === 'stop' && store.getLease(c.workspace.id)?.state === 'released') {
        commit({ operations: [opPatch(op, { status: 'completed', phase: 'result_saved' })],
          events: [event(op.sessionId, { type: 'diagnostic', code: 'stop_reconciled', detail: 'Предыдущий управляемый запуск уже завершён по сохранённому результату.' })] });
        continue;
      }
      const neverAttempted = op.phase === 'intent_saved' && ['send_turn', 'prepare_setup', 'confirm_setup'].includes(op.kind);
      const detail = neverAttempted ? 'Ход прерван до попытки запуска. Автоматического повтора нет.'
        : 'Исход операции после сбоя неизвестен. Повтор и сигналы старому PID заблокированы.';
      const status = neverAttempted ? 'interrupted' : 'recovery_required';
      commit({ operations: [opPatch(op, { status: neverAttempted ? 'failed' : 'uncertain', phase: neverAttempted ? 'result_saved' : 'uncertain', error: { code: 'recovery_required', message: detail } })],
        sessions: [state(c.session, status, detail)], workspaces: [{ ...c.workspace, state: physical === 'missing' ? 'missing' : c.workspace.state,
          setupDecision: null, setupState: c.workspace.setupState === 'running' ? 'uncertain' : c.workspace.setupState }],
        turns: op.turnId ? [{ ...store.getTurn(op.turnId)!, status: neverAttempted ? 'interrupted' : 'uncertain', endedAt: clock.now() }] : [],
        leases: op.kind === 'stop' || op.kind === 'revoke_consent' ? [] : [{ workspaceId: op.workspaceId, operationId: op.id, state: neverAttempted ? 'released' : 'uncertain' }],
        events: [event(op.sessionId, { type: 'recovery', code: 'effect_uncertain', detail }), event(op.sessionId, { type: 'session_state', status, detail })] });
    }
    for (const session of store.listSessions()) {
      const c = context(session.id), physical = await options.files.inspect(c.workspace);
      const participant = c.participant.agentSessionId ? { ...c.participant, context: await options.agents.history(c.participant, c.workspace) } : c.participant;
      const workspace = { ...c.workspace, setupDecision: null as ProjectCommandConsentDecision | null };
      const events: NewSoloEvent[] = [];
      let updated = session;
      if (physical !== 'present') {
        workspace.state = physical === 'missing' ? 'missing' : 'uncertain';
        const knownRollback = physical === 'missing' && c.workspace.state === 'missing' && session.status === 'error'
          && store.getLease(c.workspace.id)?.state === 'released';
        if (!knownRollback) updated = state(session, 'recovery_required', 'Рабочая область отсутствует или её принадлежность не подтверждена. История сохранена.');
        events.push(event(session.id, { type: 'recovery', code: 'workspace_missing', detail: updated.detail }));
      } else if (c.project.config.setup && ['pending', 'needs_consent', 'completed'].includes(c.workspace.setupState)
          && store.getLease(c.workspace.id)?.state !== 'uncertain') {
        workspace.setupDecision = await options.consent.evaluate(setupRequest(c.project, workspace));
        if (workspace.setupState !== 'completed') workspace.setupState = 'needs_consent';
        events.push(event(session.id, { type: 'setup', state: workspace.setupState, decision: workspace.setupDecision, completion: workspace.setupCompletion }));
      }
      if (participant.context === 'missing' || participant.context === 'unknown') events.push(event(session.id, {
        type: 'recovery', code: 'history_missing', detail: 'История CLI недоступна. Продолжение запрещено; новый диалог возможен только явно.' }));
      commit({ sessions: [updated], participants: [participant], workspaces: [workspace], events });
    }
    recovered = true;
  }
  async function waitForIdle(): Promise<void> { while (tasks.size) await Promise.all([...tasks]); }
  async function shutdown(): Promise<void> {
    shuttingDown = true;
    for (const item of active.values()) {
      item.stopAccepted = true; await safeInterrupt(item);
    }
    await bounded(waitForIdle(), stopTimeout * 2).catch(() => undefined);
  }
  return { recover, waitForIdle, shutdown, selectProject, createSession, sendTurn, stop, revokeConsent,
    prepareSetup: (request: SessionCommandRequest) => setup(request, false),
    confirmSetup: (request: ConfirmSetupRequest) => setup(request, true),
    listProjects: () => store.listProjects().map(projectView),
    listSessions: () => store.listSessions().map(session => getSession({ sessionId: session.id })), getSession,
    readEvents: (request: ReadEventsRequest) => { context(request.sessionId); return store.readEvents(request.sessionId, request.after, request.limit); },
    onEventsAvailable: (listener: (notice: EventsAvailable) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
export type SessionEngine = ReturnType<typeof createSessionEngine>;
export function soloError(cause: unknown): SoloError {
  if (cause instanceof SoloEngineError) return { code: cause.code, message: cause.message };
  if (cause instanceof StoreError) return { code: cause.code === 'request_conflict' ? 'request_conflict' : 'store_failed', message: 'Хранилище не может безопасно выполнить операцию.' };
  return { code: 'internal_error', message: 'Не удалось выполнить операцию. Проверьте состояние сессии.' };
}
function viewOperation(op: OperationRecord): OperationView {
  return { id: op.id, requestId: op.requestId, sessionId: op.sessionId, kind: op.kind, status: op.status, error: op.error };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freeze); } return value; }
function commandLabel(command: NonNullable<ProjectRecord['config']['setup']>): string {
  const args = command.kind === 'npm-script' ? ['npm', 'run', command.script, ...(command.args.length ? ['--', ...command.args] : [])]
    : [command.executable, ...command.args];
  // Только отображение argv, без shell-исполнения; пробелы в одном аргументе видны пользователю.
  return args.map(arg => /^[A-Za-z0-9_./:-]+$/.test(arg) ? arg : JSON.stringify(arg)).join(' ');
}
function blockedConsent(): ProjectCommandConsentDecision { return { status: 'blocked', reason: 'stale_challenge',
  coverage: { profile: 'project-command-v1', inputs: [], limitations: ['filesystem_race_after_capture'] } }; }
function withSignalFailure(completion: ProcessCompletion, failed: boolean): ProcessCompletion {
  return !failed ? completion : { ...completion, issues: [...completion.issues, { code: 'signal_failed', operation: 'interrupt', detail: 'Остановка запуска не подтверждена.' }] };
}
function notStartedResult(): AgentRunCompletion { return { kind: 'interrupted', stopAccepted: true,
  completion: { process: { state: 'not_started' }, stdout: 'not_started', stderr: 'not_started', signals: [], issues: [], wait: 'settled', descendants: 'not_guaranteed' } }; }
function missingHistoryResult(): AgentRunCompletion { return { ...notStartedResult(), kind: 'error', stopAccepted: false,
  reason: 'invalid_request', detail: 'История CLI недоступна. Начните новый диалог явно, учитывая потерю контекста.' }; }
async function drain(stream: AsyncIterable<Uint8Array>): Promise<void> { for await (const chunk of stream) { void chunk; } }
async function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('deadline')), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}
function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }
