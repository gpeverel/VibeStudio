import { isAbsolute, relative, sep } from 'node:path';
import type { AgentErrorReason, AgentRunRequest, AgentDetection, PracticalLocalReadProfile } from '../../core/ports/agent.ts';
import type { ProcessRequest, ProcessRun } from '../../core/ports/process-runner.ts';

export const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'] as const;
export const BLOCKED_TOOLS = ['Bash', 'PowerShell', 'Edit', 'Write', 'NotebookEdit', 'Agent', 'Task', 'Skill', 'WebFetch', 'WebSearch'] as const;
export interface ProfileIssue { reason: AgentErrorReason; detail: string }

/** Причина отказа штатного запуска; успешные пробы сами по себе её не устраняют. */
export const UNVERIFIED_ACCESS_DETAIL = 'Штатная среда запуска не обеспечивает файловые границы профиля и сеть provider-only; '
  + 'эффективная managed-конфигурация не проверена, CLI-флаги не подтверждают отключение builtin plugins. '
  + 'POSIX-группа не охватывает потомков, вышедших через setsid. '
  + 'Нет AccessVerifier для обеспеченной и проверенной комбинации CLI, авторизации и профиля.';

/** Это точка подключения проверенной среды исполнения, а не флаг из renderer.
 * Проверка должна привязываться ко всей комбинации CLI/авторизации/профиля/cwd/env,
 * учитывать эффективную managed-конфигурацию, обеспеченные файловые/сетевые границы,
 * включать script/symlink/hooks/MCP/plugins и отдельно общий Git-каталог.
 * Штатного подтверждения в 0C нет: живые пробы не заменяют механизм изоляции. */
export interface AccessVerification {
  status: 'verified' | 'unverified' | 'unsupported';
  evidence: readonly string[];
  detail: string;
  /** Возможность запуска от того же доверенного backend, который проверил границы.
   * Одни строки evidence не разрешают обычный spawn. В production 0C реализации нет. */
  launch?: (request: ProcessRequest) => ProcessRun;
}
export interface AccessVerificationContext {
  detection: AgentDetection;
  request: AgentRunRequest;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
}
export type AccessVerifier = (context: AccessVerificationContext) => Promise<AccessVerification>;

export type PracticalAdmissionReason =
  | 'assessment_missing' | 'project_untrusted' | 'prerequisite_unknown'
  | 'configuration_conflict' | 'cli_unsupported' | 'assessment_failed';
export type PracticalAdmissionLimitation =
  | 'no_os_sandbox' | 'no_provider_only_network' | 'detached_children_not_guaranteed';

/** Допуск только конкретного practical-запроса; не AccessVerification и не launch.
 * В P1 ready используется исключительно synthetic-подстановками в тестах.
 * Реальная совместимость CLI/auth/builtin/managed остаётся задачей P2b. */
export type PracticalAdmission = {
  detail: string;
  /** Ready требует всех трёх ограничений v1: отсутствие данных не означает отсутствие ограничений. */
  limitations: readonly PracticalAdmissionLimitation[];
} & (
  | { status: 'ready' }
  | { status: 'blocked'; reason: PracticalAdmissionReason }
  | { status: 'unsupported'; reason: PracticalAdmissionReason }
);

/** Адаптер передаёт неизменяемый снимок до запуска и использует те же argv/env.
 * Оценщик подключается только доверенной композицией, никогда через IPC/модель. */
export interface PracticalAdmissionContext {
  readonly detection: AgentDetection;
  readonly request: AgentRunRequest & { profile: PracticalLocalReadProfile };
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}
export type PracticalAdmissionEvaluator = (context: PracticalAdmissionContext) => Promise<PracticalAdmission>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Явный неизвестный kind не интерпретируется как legacy, в том числе undefined. */
export function getAccessProfileKind(profile: unknown): 'legacy-strict' | 'practical-local-v1' | 'unknown' {
  if (!isRecord(profile)) return 'unknown';
  if (!('kind' in profile)) return 'legacy-strict';
  return profile.kind === 'practical-local-v1' ? 'practical-local-v1' : 'unknown';
}

function isStringList(value: unknown): value is readonly string[] {
  if (!Array.isArray(value)) return false;
  for (const item of value) if (typeof item !== 'string') return false;
  return true;
}

function absolutePath(value: unknown): value is string {
  return typeof value === 'string' && isAbsolute(value) && !value.includes('\0');
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

export function validateAccessProfile(profile: unknown, cwd: string): ProfileIssue[] {
  const issues: ProfileIssue[] = [];
  const invalid = (detail: string): void => { issues.push({ reason: 'profile_unsupported', detail }); };
  const kind = getAccessProfileKind(profile);
  if (!isRecord(profile) || kind === 'unknown') { invalid('Неизвестный вид профиля доступа'); return issues; }
  if (profile.mode !== 'read-only') { invalid('В 0C поддерживается только профиль read-only'); return issues; }
  const tools = isStringList(profile.tools) ? profile.tools : undefined;
  if (!tools || tools.some(tool => !(READ_ONLY_TOOLS as readonly string[]).includes(tool))) invalid('Набор инструментов должен быть закрытым набором чтения');
  if (!isStringList(profile.allow) || !tools || profile.allow.some(tool => !tools.includes(tool))) invalid('Allow не может расширять набор инструментов');
  if (!isStringList(profile.deny) || profile.deny.some(rule => rule.length > 512 || rule.includes('\0'))) invalid('Некорректный список deny');
  if (!absolutePath(cwd)) { invalid('cwd должен быть абсолютным путём без NUL'); return issues; }
  const config = profile.configPolicy;
  if (kind === 'practical-local-v1') {
    if (profile.projectTrust !== 'trusted') issues.push({
      reason: 'practical_admission_blocked', detail: 'project_untrusted: практический профиль требует явного доверия проекту',
    });
    if (!absolutePath(profile.workspaceRoot) || profile.workspaceRoot !== cwd) invalid('Ожидаемая область practical должна совпадать с cwd');
    if (!isRecord(config) || !Array.isArray(config.settingSources) || config.settingSources.length
      || config.projectHooks !== 'disabled' || config.projectMcp !== 'disabled' || config.projectPlugins !== 'disabled') {
      invalid('Проектные settings/hooks/MCP/plugins должны быть явно отключены');
    }
    if ('fs' in profile || 'network' in profile || (isRecord(config) && ['loadHooks', 'loadMcp', 'loadPlugins'].some(key => key in config))) {
      invalid('Практический профиль не принимает строгие обещания файловой, сетевой или builtin-изоляции');
    }
    return issues;
  }
  if (!isRecord(config) || !Array.isArray(config.settingSources) || config.settingSources.length || config.loadHooks !== false || config.loadMcp !== false || config.loadPlugins !== false) invalid('Автоматическая исполняемая конфигурация должна быть отключена');
  const fs = profile.fs;
  if (!isRecord(fs) || !Array.isArray(fs.writeRoots) || fs.writeRoots.length || !isStringList(fs.readRoots) || !isStringList(fs.runtimeWriteRoots) || !isStringList(fs.protectedPaths)) {
    invalid('Не заданы границы файлового доступа'); return issues;
  }
  if (fs.readRoots.length !== 1 || fs.readRoots[0] !== cwd) invalid('В минимальном профиле единственный корень чтения совпадает с cwd');
  if (fs.gitCommonDir !== undefined && !absolutePath(fs.gitCommonDir)) { invalid('Общий Git-каталог должен быть абсолютным путём'); return issues; }
  const gitPaths = typeof fs.gitCommonDir === 'string' ? [fs.gitCommonDir] : [];
  const paths = [...fs.readRoots, ...fs.runtimeWriteRoots, ...fs.protectedPaths, ...gitPaths];
  if (paths.some(path => !absolutePath(path))) { invalid('Границы должны быть абсолютными путями'); return issues; }
  const protectedPaths = [cwd, ...fs.protectedPaths, ...gitPaths];
  if (fs.runtimeWriteRoots.some(root => protectedPaths.some(path => inside(root, path) || inside(path, root)))) invalid('Служебные записи пересекаются с защищёнными путями');
  if (profile.network !== 'provider-only') invalid('Неподдерживаемая политика сети');
  return issues;
}
