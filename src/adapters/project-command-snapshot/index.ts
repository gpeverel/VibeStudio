import type { ProjectCommandRequest, ProjectCommandSnapshotPort } from '../../core/ports/project-command-snapshot.ts';
import type {
  ProjectCommandCoverage, ProjectCommandSnapshot, ProjectCommandSnapshotIssue,
} from '../../shared/project-command-consent.ts';
import { nodeSnapshotFs, sha256, type SnapshotFs } from './file-reader.ts';
import { analyze, DEFAULT_LIMITS, type Analysis, type SnapshotLimits } from './resolver.ts';

export type { SnapshotFileHandle, SnapshotFileStat, SnapshotFs } from './file-reader.ts';
export type { SnapshotLimits } from './resolver.ts';
export { nodeSnapshotFs } from './file-reader.ts';

export interface ProjectCommandSnapshotDeps {
  readonly fs?: SnapshotFs;
  readonly limits?: Partial<SnapshotLimits>;
}

const PROFILE = 'project-command-v1';
const PURPOSES: ReadonlySet<string> = new Set(['setup', 'test', 'check', 'build', 'push', 'publish', 'destructive']);

function emptyCoverage(): ProjectCommandCoverage {
  return { profile: PROFILE, inputs: [], limitations: ['filesystem_race_after_capture'] };
}

function blocked(reason: ProjectCommandSnapshotIssue, coverage = emptyCoverage()): ProjectCommandSnapshot {
  return { status: 'blocked', reason, coverage };
}

/** Плотный массив строк без NUL: пропуски в sparse-массиве `every` не видит. */
function isStringArray(value: unknown): value is readonly string[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const item: unknown = index in value ? value[index] : undefined;
    if (typeof item !== 'string' || item.includes('\0')) return false;
  }
  return true;
}

function oneOf(value: unknown, allowed: readonly string[]): boolean {
  return typeof value === 'string' && allowed.includes(value);
}

/** Порт принимает запрос только от доверенной композиции, но форма проверяется: ошибка — invalid_request.
 * Каждое поле читается один раз и копируется: геттер не может вернуть другое значение при анализе.
 * Вызывается внутри try: исключение геттера или прокси не выходит из capture. */
function copyRequest(value: unknown): ProjectCommandRequest | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const request = value as Partial<Record<keyof ProjectCommandRequest, unknown>>;
  const text = (item: unknown): item is string => typeof item === 'string' && item !== '' && !item.includes('\0');
  const { projectId, projectRoot, operationId, purpose, cwd } = request;
  if (!text(projectId) || !text(projectRoot) || !text(operationId) || !text(cwd)) return undefined;
  if (!projectRoot.startsWith('/') || !cwd.startsWith('/')) return undefined;
  if (typeof purpose !== 'string' || !PURPOSES.has(purpose)) return undefined;
  const permissions = request.permissions as Record<string, unknown> | null | undefined;
  if (typeof permissions !== 'object' || permissions === null) return undefined;
  const { fileSystem, network, elevated } = permissions;
  if (!oneOf(fileSystem, ['read-only', 'workspace-write', 'unrestricted'])) return undefined;
  if (!oneOf(network, ['denied', 'allowed']) || typeof elevated !== 'boolean') return undefined;
  const rawEnv = request.env as Record<string, unknown> | null | undefined;
  if (typeof rawEnv !== 'object' || rawEnv === null || Array.isArray(rawEnv)) return undefined;
  const env: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const key of Object.keys(rawEnv)) {
    const item = rawEnv[key];
    if (key === '' || key.includes('=') || key.includes('\0') || typeof item !== 'string' || item.includes('\0')) return undefined;
    env[key] = item;
  }
  const rawCommand = request.command as Record<string, unknown> | null | undefined;
  if (typeof rawCommand !== 'object' || rawCommand === null) return undefined;
  const { kind, args, executable, inputFiles, script } = rawCommand;
  if (!isStringArray(args)) return undefined;
  const base = {
    projectId, projectRoot, operationId, cwd, env,
    purpose: purpose as ProjectCommandRequest['purpose'],
    permissions: {
      fileSystem: fileSystem as ProjectCommandRequest['permissions']['fileSystem'],
      network: network as ProjectCommandRequest['permissions']['network'],
      elevated,
    },
  };
  if (kind === 'direct' && text(executable) && isStringArray(inputFiles)) {
    return { ...base, command: { kind: 'direct', executable, args: [...args], inputFiles: [...inputFiles] } };
  }
  if (kind === 'npm-script' && text(script)) return { ...base, command: { kind: 'npm-script', script, args: [...args] } };
  return undefined;
}

/** Детерминированная сериализация: ключи по алфавиту, без пробелов; порядок массивов значим. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Fingerprint связывает весь запрос и содержимое входов. Значения env входят только как SHA-256, сам
 * хэш не передаёт наружу argv, тела scripts или абсолютные пути. Приватный материал связывает
 * канонический корень и фактические пути executable: перенос также меняет согласованный контекст.
 * Время изменения не участвует: идентичность содержимого — байты.
 */
function fingerprintOf(request: ProjectCommandRequest, analysis: Analysis): string {
  const command = request.command;
  return sha256(stable({
    profile: PROFILE,
    projectId: request.projectId,
    operationId: request.operationId,
    purpose: request.purpose,
    root: sha256(analysis.realRoot),
    cwd: analysis.cwd,
    command: command.kind === 'direct'
      ? { kind: command.kind, executable: command.executable, args: command.args, inputFiles: [...command.inputFiles].sort() }
      : { kind: command.kind, script: command.script, args: command.args },
    permissions: {
      fileSystem: request.permissions.fileSystem, network: request.permissions.network, elevated: request.permissions.elevated,
    },
    env: Object.fromEntries(Object.keys(request.env).sort().map((name) => [name, sha256(request.env[name] ?? '')])),
    inputs: analysis.inputs.map(({ path, kind, digest, target }) => ({ path, kind, digest, target })),
    limitations: analysis.limitations,
  }));
}

export function createProjectCommandSnapshotPort(deps: ProjectCommandSnapshotDeps = {}): ProjectCommandSnapshotPort {
  const fs = deps.fs ?? nodeSnapshotFs;
  const limits: SnapshotLimits = { ...DEFAULT_LIMITS, ...deps.limits };
  return {
    async capture(request: ProjectCommandRequest): Promise<ProjectCommandSnapshot> {
      try {
        const copied = copyRequest(request);
        if (!copied) return blocked('invalid_request');
        const analysis = await analyze(fs, limits, copied);
        const coverage: ProjectCommandCoverage = {
          profile: PROFILE,
          inputs: analysis.inputs.map(({ path, kind, digest }) => ({ path, kind, digest })),
          limitations: analysis.limitations,
        };
        const first = analysis.issues[0];
        if (first) return blocked(first.code, coverage);
        return { status: 'known', fingerprint: fingerprintOf(copied, analysis), coverage };
      } catch {
        // Сообщения ошибок могут содержать пути и значения; наружу — только закрытая причина.
        return blocked('snapshot_failed');
      }
    },
  };
}
