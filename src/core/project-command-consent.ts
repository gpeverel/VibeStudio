import type {
  ProjectCommandConsentBlockReason, ProjectCommandConsentDecision, ProjectCommandCoverage,
  ProjectCommandSnapshot,
} from '../shared/project-command-consent.ts';
import type { ProjectCommandRequest, ProjectCommandSnapshotPort } from './ports/project-command-snapshot.ts';

type KnownSnapshot = Extract<ProjectCommandSnapshot, { status: 'known' }>;
interface Challenge {
  readonly id: string;
  readonly request: ProjectCommandRequest;
  readonly context: string;
  readonly fingerprint: string;
}
interface Consent {
  readonly id: string;
  readonly context: string;
  readonly fingerprint: string;
}
interface OperationState {
  consent?: Consent;
  challenge?: Challenge;
  invalidated: boolean;
  revision: number;
}

export interface ProjectCommandConsentPolicy {
  evaluate(request: ProjectCommandRequest): Promise<ProjectCommandConsentDecision>;
  /** Только доверенный обработчик явного решения пользователя. Не вызывать из модели.
   * Подтверждает ранее показанный снимок; новое содержимое требует нового вопроса. */
  confirm(challengeId: string): Promise<ProjectCommandConsentDecision>;
  /** Повторное чтение непосредственно перед будущим запуском. Ничего не исполняет. */
  recheck(request: ProjectCommandRequest): Promise<ProjectCommandConsentDecision>;
  /** Отзыв синхронный: незавершённая проверка не может восстановить этот допуск. */
  revoke(consentId: string): boolean;
}

let instanceSequence = 0;

/** P4: только память доверенного приложения. Durable store/IPC/исполнитель — P5.
 * Все проверки сериализованы, чтобы поздний старый снимок не оживлял отозванный допуск.
 * operationId обозначает одну именованную операцию экземпляра, включая её проект.
 * IDs — ссылки на частное состояние, не аутентификация пользовательского решения. */
export function createProjectCommandConsent(port: ProjectCommandSnapshotPort): ProjectCommandConsentPolicy {
  const instance = ++instanceSequence;
  let sequence = 0;
  let tail: Promise<void> = Promise.resolve();
  const operations = new Map<string, OperationState>();
  const challenges = new Map<string, Challenge>();

  function enqueue(work: () => Promise<ProjectCommandConsentDecision>): Promise<ProjectCommandConsentDecision> {
    const result = tail.then(work);
    tail = result.then(() => undefined, () => undefined);
    return result;
  }

  function stateFor(operationId: string): OperationState {
    let state = operations.get(operationId);
    if (!state) {
      state = { invalidated: false, revision: 0 };
      operations.set(operationId, state);
    }
    return state;
  }

  function invalidate(state: OperationState): void {
    if (state.challenge) challenges.delete(state.challenge.id);
    state.consent = undefined;
    state.challenge = undefined;
    state.invalidated = true;
    ++state.revision;
  }

  async function capture(request: ProjectCommandRequest): Promise<ProjectCommandSnapshot> {
    try {
      // Копирование отделяет частное состояние от изменяемых объектов адаптера.
      const snapshot = await port.capture(request);
      const coverage = copyCoverage(snapshot.coverage);
      if (snapshot.status === 'blocked' && snapshotIssues.has(snapshot.reason)) {
        return { status: 'blocked', reason: snapshot.reason, coverage };
      }
      if (snapshot.status === 'known' && typeof snapshot.fingerprint === 'string'
          && /^[a-f0-9]{64}$/.test(snapshot.fingerprint)
          && coverage.inputs.some(input => input.digest !== null)) {
        return { status: 'known', fingerprint: snapshot.fingerprint, coverage };
      }
    } catch {
      // Сырые Error.message/stack могут содержать env, argv или тела scripts.
    }
    return { status: 'blocked', reason: 'snapshot_failed', coverage: emptyCoverage() };
  }

  function allowed(consent: Consent, snapshot: KnownSnapshot): ProjectCommandConsentDecision {
    return { status: 'allowed', consentId: consent.id, fingerprint: snapshot.fingerprint,
      coverage: snapshot.coverage };
  }

  function evaluate(request: ProjectCommandRequest): Promise<ProjectCommandConsentDecision> {
    // Обязательно до первого await/очереди: вызывающий не меняет будущий вопрос задним числом.
    const copied = copyRequest(request);
    const operationId = safeOperationId(request);
    return enqueue(async () => {
      if (!copied) {
        if (operationId) invalidate(stateFor(operationId));
        return blocked('invalid_request');
      }
      const state = stateFor(copied.operationId);
      if (separatePurposes.has(copied.purpose)) {
        invalidate(state);
        return blocked('separate_authorization_required');
      }
      const context = JSON.stringify(copied);
      const startedAt = state.revision;
      const snapshot = await capture(copied);
      if (startedAt !== state.revision) {
        invalidate(state);
        return blocked('stale_challenge', snapshot.coverage);
      }
      if (snapshot.status === 'blocked') {
        invalidate(state);
        return snapshot;
      }
      if (state.consent) {
        if (state.consent.context === context && state.consent.fingerprint === snapshot.fingerprint) {
          return allowed(state.consent, snapshot);
        }
        invalidate(state);
      }
      if (state.challenge && (state.challenge.context !== context
          || state.challenge.fingerprint !== snapshot.fingerprint)) invalidate(state);
      if (!state.challenge) {
        const challenge: Challenge = { id: `challenge-${instance}-${++sequence}`, request: copied,
          context, fingerprint: snapshot.fingerprint };
        state.challenge = challenge;
        challenges.set(challenge.id, challenge);
      }
      return { status: 'needs_consent', reason: state.invalidated ? 'invalidated' : 'not_granted',
        challengeId: state.challenge.id, fingerprint: snapshot.fingerprint, coverage: snapshot.coverage };
    });
  }

  function confirm(challengeId: string): Promise<ProjectCommandConsentDecision> {
    return enqueue(async () => {
      const challenge = challenges.get(challengeId);
      if (!challenge) return blocked('unknown_challenge');
      const state = stateFor(challenge.request.operationId);
      // Одноразовость: погашаем до чтения, в том числе для неудачного подтверждения.
      challenges.delete(challengeId);
      state.challenge = undefined;
      const startedAt = state.revision;
      const snapshot = await capture(challenge.request);
      if (startedAt !== state.revision) {
        invalidate(state);
        return blocked('stale_challenge', snapshot.coverage);
      }
      if (snapshot.status === 'blocked') {
        invalidate(state);
        return snapshot;
      }
      if (snapshot.fingerprint !== challenge.fingerprint) {
        invalidate(state);
        return blocked('stale_challenge', snapshot.coverage);
      }
      const consent: Consent = { id: `consent-${instance}-${++sequence}`,
        context: challenge.context, fingerprint: snapshot.fingerprint };
      state.consent = consent;
      state.invalidated = false;
      return allowed(consent, snapshot);
    });
  }

  function revoke(consentId: string): boolean {
    for (const state of operations.values()) {
      if (state.consent?.id === consentId) {
        invalidate(state);
        return true;
      }
    }
    return false;
  }

  return { evaluate, confirm, recheck: evaluate, revoke };
}

const separatePurposes = new Set(['push', 'publish', 'destructive']);
const purposes = new Set(['setup', 'test', 'check', 'build', ...separatePurposes]);
const snapshotIssues = new Set([
  'invalid_request', 'missing_input', 'unreadable_input', 'non_regular_input', 'ambiguous_path',
  'outside_project', 'unsupported_command', 'unknown_dependency', 'ambiguous_manifest',
  'dependency_cycle', 'unstable_input', 'limit_exceeded', 'snapshot_failed',
]);
const limitations = new Set([
  'runtime_dependencies_not_attested', 'system_toolchain_not_attested', 'filesystem_race_after_capture',
]);
const inputKinds = new Set(['file', 'manifest', 'configuration', 'lockfile', 'executable', 'script']);

function emptyCoverage(): ProjectCommandCoverage {
  return { profile: 'project-command-v1', inputs: [], limitations: ['filesystem_race_after_capture'] };
}
function blocked(reason: ProjectCommandConsentBlockReason,
  coverage = emptyCoverage()): ProjectCommandConsentDecision {
  return { status: 'blocked', reason, coverage };
}

function copyCoverage(value: ProjectCommandCoverage): ProjectCommandCoverage {
  if (value.profile !== 'project-command-v1' || !Array.isArray(value.inputs)
      || !Array.isArray(value.limitations) || Array.from(value.limitations).some(item => !limitations.has(item))) {
    throw new Error('invalid coverage');
  }
  return { profile: 'project-command-v1', limitations: [...value.limitations], inputs: Array.from(value.inputs).map(input => {
    if (typeof input.path !== 'string' || !input.path || input.path.startsWith('/')
        || input.path.includes('\0') || !inputKinds.has(input.kind)
        || (input.digest !== null && (typeof input.digest !== 'string' || !/^[a-f0-9]{64}$/.test(input.digest)))) {
      throw new Error('invalid input identity');
    }
    return { path: input.path, kind: input.kind, digest: input.digest };
  }) };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every(key => expected.includes(key));
}
function string(value: unknown): value is string {
  return typeof value === 'string' && !value.includes('\0');
}
function copyStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const copy: unknown[] = Array.from(value);
  return copy.every(string) ? copy : undefined;
}
function safeOperationId(value: unknown): string | undefined {
  try { return record(value) && string(value.operationId) ? value.operationId : undefined; }
  catch { return undefined; }
}

function copyRequest(value: unknown): ProjectCommandRequest | undefined {
  try {
    if (!record(value) || !keys(value, ['projectId', 'projectRoot', 'operationId', 'purpose',
      'command', 'cwd', 'permissions', 'env'])) return undefined;
    const { projectId, projectRoot, operationId, purpose, command, cwd, permissions, env } = value;
    if (!string(projectId) || !projectId || !string(projectRoot) || !projectRoot
        || !string(operationId) || !operationId || !string(cwd) || !cwd
        || !string(purpose) || !purposes.has(purpose) || !record(command)
        || !record(permissions) || !keys(permissions, ['fileSystem', 'network', 'elevated'])
        || !record(env)) return undefined;
    const { fileSystem, network, elevated } = permissions;
    if (typeof fileSystem !== 'string' || !['read-only', 'workspace-write', 'unrestricted'].includes(fileSystem)
        || typeof network !== 'string' || !['denied', 'allowed'].includes(network)
        || typeof elevated !== 'boolean') return undefined;
    const entries = Object.entries(env);
    if (entries.some(([key, item]) => !key || key.includes('=') || !string(key) || !string(item))) {
      return undefined;
    }
    const { kind, executable, args, inputFiles, script } = command;
    const copiedArgs = copyStrings(args);
    if (!copiedArgs) return undefined;
    let copiedCommand: ProjectCommandRequest['command'];
    if (kind === 'direct' && keys(command, ['kind', 'executable', 'args', 'inputFiles'])
        && string(executable) && executable) {
      const copiedFiles = copyStrings(inputFiles);
      if (!copiedFiles) return undefined;
      copiedCommand = Object.freeze({ kind: 'direct', executable,
        args: Object.freeze(copiedArgs), inputFiles: Object.freeze(copiedFiles.sort()) });
    } else if (kind === 'npm-script' && keys(command, ['kind', 'script', 'args']) && string(script) && script) {
      copiedCommand = Object.freeze({ kind: 'npm-script', script, args: Object.freeze(copiedArgs) });
    } else return undefined;
    return Object.freeze({ projectId, projectRoot, operationId,
      purpose: purpose as ProjectCommandRequest['purpose'], command: copiedCommand, cwd,
      permissions: Object.freeze({ fileSystem: fileSystem as ProjectCommandRequest['permissions']['fileSystem'],
        network: network as ProjectCommandRequest['permissions']['network'], elevated }),
      env: Object.freeze(Object.fromEntries(entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))) as ProjectCommandRequest['env'] });
  } catch { return undefined; }
}
