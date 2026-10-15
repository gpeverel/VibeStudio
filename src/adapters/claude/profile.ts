import { createHash } from 'node:crypto';
import { isAbsolute, relative, sep } from 'node:path';
import type { AgentErrorReason, AgentRunRequest, AgentDetection, PracticalLocalReadProfile, RuntimeInventory, RuntimeInventoryEntry } from '../../core/ports/agent.ts';
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
  | 'configuration_conflict' | 'cli_unsupported' | 'assessment_failed'
  | 'context_changed' | 'runtime_inventory_unknown' | 'runtime_inventory_mismatch';
export type PracticalAdmissionLimitation =
  | 'no_os_sandbox' | 'no_provider_only_network' | 'detached_children_not_guaranteed' | 'cli_configuration_not_audited';
/** Обязательные границы принятой модели доверия, включая отсутствие полного аудита CLI. */
export const PRACTICAL_LIMITATIONS: readonly PracticalAdmissionLimitation[] = Object.freeze([
  'no_os_sandbox', 'no_provider_only_network', 'detached_children_not_guaranteed', 'cli_configuration_not_audited',
]);

/** Допуск только конкретного practical-запроса; не AccessVerification и не launch.
 * Ready без привязки сохраняет старую synthetic-подстановку P1.
 * Отпечаток и ожидание всегда присутствуют вместе, половинчатый допуск недопустим.
 * Production обязан возвращать ProductionPracticalAdmission с обоими полями. */
export type PracticalAdmission = {
  detail: string;
  /** Ready требует всех PRACTICAL_LIMITATIONS: отсутствие данных не означает отсутствие ограничений. */
  limitations: readonly PracticalAdmissionLimitation[];
} & (
  | { status: 'ready'; contextFingerprint?: never; expectedInventory?: never }
  | { status: 'ready'; contextFingerprint: string; expectedInventory: RuntimeInventoryExpectation }
  | { status: 'blocked'; reason: PracticalAdmissionReason }
  | { status: 'unsupported'; reason: PracticalAdmissionReason }
);

export type ProductionPracticalAdmission = Exclude<PracticalAdmission, { status: 'ready' }>
  | (Extract<PracticalAdmission, { status: 'ready' }> & {
    readonly contextFingerprint: string;
    readonly expectedInventory: RuntimeInventoryExpectation;
  });

/** Независимое предзапусковое ожидание, а не копия фактического init.
 * Необязательные категории проверяются, если для них есть отдельное ожидание.
 * Прочие сведения init остаются наблюдением и не становятся разрешением. */
export interface RuntimeInventoryExpectation {
  readonly tools: readonly string[];
  readonly plugins: readonly RuntimeInventoryEntry[];
  readonly mcpServers: readonly RuntimeInventoryEntry[];
  readonly cliVersion: string;
  readonly permissionMode: 'dontAsk';
  readonly skills?: readonly string[];
  readonly slashCommands?: readonly string[];
  readonly agents?: readonly string[];
}
export interface RuntimeInventoryIssue {
  readonly reason: 'runtime_inventory_unknown' | 'runtime_inventory_mismatch';
  readonly field: keyof RuntimeInventory | 'init';
  readonly detail: string;
}
export const MAX_INVENTORY_ITEMS = 64;
export const MAX_INVENTORY_NAME_BYTES = 128;

export function inventoryId(name: string): string {
  return `sha256:${createHash('sha256').update(name).digest('hex')}`;
}

const inventoryDigest = (value: unknown): value is string => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
function inventoryStrings(value: unknown, digestOnly = false): value is readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_INVENTORY_ITEMS) return false;
  for (const item of value) {
    if (typeof item !== 'string' || !(digestOnly ? inventoryDigest(item)
      : [...READ_ONLY_TOOLS, ...BLOCKED_TOOLS].some(tool => tool === item) || inventoryDigest(item))) return false;
  }
  return new Set(value).size === value.length;
}
function inventoryEntries(value: unknown): value is readonly RuntimeInventoryEntry[] {
  if (!Array.isArray(value) || value.length > MAX_INVENTORY_ITEMS) return false;
  const ids = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || !inventoryDigest(item.id) || typeof item.origin !== 'string'
      || !['project', 'user', 'builtin', 'managed'].includes(item.origin) || ids.has(item.id)) return false;
    ids.add(item.id);
  }
  return true;
}

export function isRuntimeInventoryExpectation(value: unknown): value is RuntimeInventoryExpectation {
  return isRecord(value) && inventoryStrings(value.tools) && inventoryEntries(value.plugins) && inventoryEntries(value.mcpServers)
    && typeof value.cliVersion === 'string' && /^\d+\.\d+\.\d+$/.test(value.cliVersion) && value.cliVersion.length <= 64
    && value.permissionMode === 'dontAsk'
    && (['skills', 'slashCommands', 'agents'] as const).every(key => !(key in value) || inventoryStrings(value[key], true));
}

/** Сравнение без вывода недоверенных значений в причины и диагностику. */
export function compareRuntimeInventory(actual: RuntimeInventory | undefined, expected: RuntimeInventoryExpectation): RuntimeInventoryIssue | undefined {
  const issue = (field: RuntimeInventoryIssue['field'], mismatch = false): RuntimeInventoryIssue => ({
    reason: mismatch ? 'runtime_inventory_mismatch' : 'runtime_inventory_unknown', field,
    detail: `${mismatch ? 'Расхождение' : 'Неподтверждённое поле'} runtime inventory: ${field}`,
  });
  if (!isRuntimeInventoryExpectation(expected) || !actual) return issue('init');
  const fields: (keyof RuntimeInventory)[] = ['tools', 'plugins', 'mcpServers', 'cliVersion', 'permissionMode'];
  for (const key of ['skills', 'slashCommands', 'agents'] as const) if (key in expected) fields.push(key);
  for (const key of fields) {
    const fact = actual[key];
    if (!fact || fact.provenance !== 'cli-init' || fact.state === 'unknown') return issue(key);
    if (fact.state === 'conflict') return issue(key, true);
    if (fact.state !== 'known') return issue(key);
    const value = fact.value;
    const wanted = expected[key];
    if (key === 'plugins' || key === 'mcpServers') {
      if (!inventoryEntries(value)) return issue(key);
      const signature = (entries: readonly RuntimeInventoryEntry[]): string => entries.map(entry => `${entry.id}:${entry.origin}`).sort().join(',');
      if (signature(value) !== signature(wanted as readonly RuntimeInventoryEntry[])) return issue(key, true);
    } else if (key === 'cliVersion' || key === 'permissionMode') {
      if (typeof value !== 'string') return issue(key);
      if (value !== wanted) return issue(key, true);
    } else {
      if (!inventoryStrings(value, key !== 'tools')) return issue(key);
      if ([...value].sort().join(',') !== [...wanted as readonly string[]].sort().join(',')) return issue(key, true);
    }
  }
  return undefined;
}

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
