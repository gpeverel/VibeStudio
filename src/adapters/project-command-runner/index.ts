import { realpath } from 'node:fs/promises';
import { sep } from 'node:path';
import type { ProcessRequest, ProcessRunner } from '../../core/ports/process-runner.ts';
import type { ProjectCommandRunner } from '../../core/ports/project-command-runner.ts';
import type { ProjectCommandRequest } from '../../core/ports/project-command-snapshot.ts';
import type { ProjectCommandConsentDecision, ProjectCommandPurpose } from '../../shared/project-command-consent.ts';

export interface ProjectCommandRunnerOptions {
  runner: ProcessRunner;
}

/** Push, публикация и разрушительные операции никогда не выполняются по согласию на команду проекта. */
const SEPARATE_AUTHORIZATION: ReadonlySet<ProjectCommandPurpose> = new Set(['push', 'publish', 'destructive']);

/** Предел одного запуска: setup и проверки конечны. Значение вызывающего не может его отключить. */
export const MAX_COMMAND_TIMEOUT_MS = 30 * 60_000;

const EMPTY_COVERAGE = { profile: 'project-command-v1', inputs: [], limitations: [] } as const;

function blocked(reason: Extract<ProjectCommandConsentDecision, { status: 'blocked' }>['reason']): { status: 'blocked'; decision: ProjectCommandConsentDecision } {
  return { status: 'blocked', decision: { status: 'blocked', reason, coverage: EMPTY_COVERAGE } };
}

/** Дочерние объекты замораживаются независимо от состояния родителя: Object.freeze(request) неглубок. */
function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value === 'object' && value !== null && !seen.has(value)) {
    seen.add(value);
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child, seen);
  }
  return value;
}

/** Запрос процесса строится из того же замороженного объекта, который проверила политика. */
function processRequest(request: ProjectCommandRequest, timeoutMs: number): ProcessRequest {
  const { command } = request;
  const common = { cwd: request.cwd, env: request.env, stdin: '', timeoutMs } as const;
  if (command.kind === 'npm-script') {
    // Аргументы после «--» получает только основной script; pre/post выполняет сам npm, как учитывает снимок P4.
    return { executable: 'npm', args: ['run', command.script, ...(command.args.length ? ['--', ...command.args] : [])], ...common };
  }
  return { executable: command.executable, args: command.args, ...common };
}

async function insideProject(request: ProjectCommandRequest): Promise<boolean> {
  try {
    const [root, cwd] = await Promise.all([realpath(request.projectRoot), realpath(request.cwd)]);
    return cwd === root || cwd.startsWith(root.endsWith(sep) ? root : root + sep);
  } catch {
    return false;
  }
}

/**
 * Запускает именованную команду проекта только после повторной проверки согласия того же запроса.
 * Нет универсального exec: запрос приходит от доверенной композиции, а решение — от её колбэка
 * `recheck`; флаги разрешения от renderer или модели не принимаются. Между recheck и spawn остаётся
 * гонка файловой системы (см. пределы покрытия P4): она не устраняется и не скрывается.
 */
export function createProjectCommandRunner(options: ProjectCommandRunnerOptions): ProjectCommandRunner {
  return {
    async start(request, authorization, timeoutMs) {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_COMMAND_TIMEOUT_MS) {
        return blocked('invalid_request');
      }
      // Без копии: recheck и процесс получают один и тот же объект. Он замораживается на месте,
      // поэтому ни вызывающий, ни колбэк не могут изменить его между проверкой и запуском.
      const frozen = deepFreeze(request);
      if (SEPARATE_AUTHORIZATION.has(frozen.purpose)) return blocked('separate_authorization_required');
      if (!await insideProject(frozen)) return blocked('outside_project');

      const decision = await authorization.recheck(frozen);
      if (decision.status !== 'allowed') return { status: 'blocked', decision };
      // Решение должно относиться именно к выданному согласию и снимку, а не к чужому допуску.
      if (decision.consentId !== authorization.consentId || decision.fingerprint !== authorization.fingerprint) {
        return blocked('stale_challenge');
      }
      return { status: 'started', run: options.runner.start(processRequest(frozen, timeoutMs)) };
    },
  };
}
