import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentCapabilities } from '../../core/ports/agent.ts';
import { CLAUDE_ENV_ALLOWLIST } from './args.ts';
import { BLOCKED_TOOLS, READ_ONLY_TOOLS, inventoryId } from './profile.ts';
import type { PracticalAdmissionContext, PracticalAdmissionEvaluator, PracticalAdmissionLimitation, PracticalAdmissionReason, ProductionPracticalAdmission, RuntimeInventoryExpectation } from './profile.ts';

/** Практический допуск Claude (P2b): чистый алгоритм над фактами + production-сборщик фактов.
 * Ready выдаётся только при известных обязательных предпосылках. Неизвестное остаётся неизвестным
 * и блокирует допуск: отсутствие managed-файла не доказывает отсутствие managed/MDM/server-политики.
 * Допуск привязан отпечатком к executable, версии, argv, значениям разрешённого env, cwd и профилю;
 * это предпусковая проверка и она не обещает отсутствия внешних гонок. */

/** Что подтверждает факт: real — наблюдение этого процесса; synthetic — подстановка теста. */
export type FactProvenance = 'real' | 'synthetic';
/** Причины — закрытые коды: свободный текст сборщика в detail не попадает. */
export type AdmissionFact<T, R extends string> =
  | { readonly state: 'known'; readonly value: T; readonly provenance: FactProvenance }
  | { readonly state: 'unknown'; readonly reason: R }
  | { readonly state: 'conflict'; readonly reason: R; /** Только метки из закрытого словаря managed-ключей. */ readonly items?: readonly string[] };
export type ExecutableFactReason = 'path_unknown' | 'unavailable' | 'not_regular_file';
export type ManagedFactReason = 'unobservable' | 'unreadable' | 'executable_config';

export interface ExecutableIdentity { readonly path: string; readonly size: number; readonly mtimeMs: number }
/** Для effective managed-политики нужны все три источника; файл — лишь один из них. */
export type ManagedSource = 'file' | 'os-policy' | 'server-managed';
export const REQUIRED_MANAGED_SOURCES: readonly ManagedSource[] = ['file', 'os-policy', 'server-managed'];
/** policyDigest — sha256 нормализованной effective-политики (не значения): разные политики дают разные отпечатки. */
export interface ManagedObservation {
  readonly observed: readonly ManagedSource[];
  readonly policyDigest: string;
  /** Явный известный итог: effective-политика не задаёт hooks/MCP/plugins/env/helpers/allow-права. */
  readonly executableConfig: 'none';
}

/** Собираемые (а не выводимые из запроса) факты. Подменяется только сбор, не оценка. */
export interface ClaudeAdmissionFacts {
  readonly executable: AdmissionFact<ExecutableIdentity, ExecutableFactReason>;
  readonly managed: AdmissionFact<ManagedObservation, ManagedFactReason>;
}
export type ClaudeFactCollector = (context: PracticalAdmissionContext) => Promise<ClaudeAdmissionFacts>;

export interface AdmissionProbes {
  readonly platform: NodeJS.Platform;
  stat(path: string): Promise<{ size: number; mtimeMs: number; isFile: boolean }>;
  readFile(path: string, maxBytes: number): Promise<string>;
}
const MAX_MANAGED_BYTES = 262_144;
const DETAIL_LIMIT = 480;
const defaultProbes: AdmissionProbes = {
  platform: process.platform,
  stat: async path => { const info = await stat(path); return { size: info.size, mtimeMs: info.mtimeMs, isFile: info.isFile() }; },
  readFile: async (path, maxBytes) => {
    const info = await stat(path);
    if (info.size > maxBytes) throw Object.assign(new Error('too large'), { code: 'EFBIG' });
    return readFile(path, 'utf8');
  },
};

/** Наблюдаемый контракт: init 2.1.295 (реальные replay). Любая другая версия unsupported до своего контракта. */
export const SUPPORTED_CLAUDE_VERSIONS: readonly string[] = ['2.1.295'];
/** Builtin-источники init под этим контрактом. Регистрация не доказывает исполнение handler. */
export const BUILTIN_PLUGIN_NAMES = ['cc-plugin-agents-md', 'cc-plugin-plugin-authoring'] as const;
/** Агенты init 2.1.295 из реальных replay. */
export const BUILTIN_AGENT_NAMES = ['claude', 'Explore', 'general-purpose', 'Plan'] as const;
const REQUIRED_CAPABILITIES: readonly (keyof AgentCapabilities)[] = [
  'streamJson', 'partialMessages', 'sessionId', 'restricted', 'safeMode', 'tools', 'settingSources', 'strictMcpConfig', 'permissionPrompts',
];
const PRACTICAL_LIMITATIONS: readonly PracticalAdmissionLimitation[] = ['no_os_sandbox', 'no_provider_only_network', 'detached_children_not_guaranteed'];
/** Env-учётные данные: видимый вход из них неотличим от штатного входа CLI. */
const CREDENTIAL_ENV = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'] as const;
const EXECUTABLE_MANAGED_KEYS = ['hooks', 'mcpServers', 'enabledPlugins', 'extraKnownMarketplaces', 'env', 'apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'statusLine', 'permissions'] as const;
const MANAGED_LABELS = ['managed-settings', 'managed-mcp'] as const;
const MANAGED_ITEMS: ReadonlySet<string> = new Set(MANAGED_LABELS.flatMap(label => EXECUTABLE_MANAGED_KEYS.map(key => `${label}.${key}`)));

/** Известные документированные пути файлов; перечень не исчерпывает managed-источники. */
function managedFilePaths(platform: NodeJS.Platform): string[] {
  const dir = platform === 'darwin' ? '/Library/Application Support/ClaudeCode'
    : platform === 'linux' ? '/etc/claude-code' : platform === 'win32' ? 'C:\\Program Files\\ClaudeCode' : '';
  return dir ? [join(dir, 'managed-settings.json'), join(dir, 'managed-mcp.json')] : [];
}
const errno = (cause: unknown): string => String((cause as { code?: unknown } | null)?.code ?? 'UNKNOWN').slice(0, 32);

/** Production-сборщик: только чтение файловой системы, без запуска процессов и без модели.
 * Effective managed (OS-политика, server-managed) документированным интерфейсом CLI до запуска
 * не наблюдается, поэтому на реальных данных managed остаётся unknown и допуск блокируется. */
export async function collectClaudeFacts(context: PracticalAdmissionContext, probes: AdmissionProbes = defaultProbes): Promise<ClaudeAdmissionFacts> {
  const executable = await collectExecutable(context.detection.binaryPath, probes);
  const managed = await collectManaged(probes);
  return { executable, managed };
}

async function collectExecutable(path: string | null, probes: AdmissionProbes): Promise<ClaudeAdmissionFacts['executable']> {
  if (!path) return { state: 'unknown', reason: 'path_unknown' };
  try {
    const info = await probes.stat(path);
    if (!info.isFile) return { state: 'conflict', reason: 'not_regular_file' };
    return { state: 'known', provenance: 'real', value: { path, size: info.size, mtimeMs: info.mtimeMs } };
  } catch { return { state: 'unknown', reason: 'unavailable' }; }
}

async function collectManaged(probes: AdmissionProbes): Promise<ClaudeAdmissionFacts['managed']> {
  let unreadable = false;
  const conflicts: string[] = [];
  for (const path of managedFilePaths(probes.platform)) {
    const label = path.endsWith('managed-mcp.json') ? 'managed-mcp' : 'managed-settings';
    let text: string;
    try { text = await probes.readFile(path, MAX_MANAGED_BYTES); }
    catch (cause) {
      // Отсутствие файла не доказывает отсутствие политики; недоступность — отдельная неизвестность.
      if (errno(cause) !== 'ENOENT') unreadable = true;
      continue;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { unreadable = true; continue; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { unreadable = true; continue; }
    // Только имена из закрытого списка: значения и прочие ключи не выдаются.
    for (const key of EXECUTABLE_MANAGED_KEYS) if (key in parsed && !isEmpty((parsed as Record<string, unknown>)[key])) conflicts.push(`${label}.${key}`);
  }
  if (conflicts.length) return { state: 'conflict', reason: 'executable_config', items: conflicts };
  return { state: 'unknown', reason: unreadable ? 'unreadable' : 'unobservable' };
}
const isEmpty = (value: unknown): boolean => value === undefined || value === null
  || (Array.isArray(value) && !value.length) || (typeof value === 'object' && !Array.isArray(value) && !Object.keys(value as object).length);

const BOOLEAN_FLAGS = ['--print', '--verbose', '--include-partial-messages', '--restricted', '--safe-mode', '--strict-mcp-config', '--disable-slash-commands', '--no-chrome', '--no-session-persistence'];
const VALUE_FLAGS = ['--input-format', '--output-format', '--setting-sources', '--mcp-config', '--tools', '--permission-mode', '--permission-prompts', '--disallowedTools',
  '--allowedTools', '--system-prompt-snapshot', '--append-system-prompt', '--session-id', '--resume', '--model', '--max-turns'];
const REQUIRED_BOOLEAN = BOOLEAN_FLAGS.filter(flag => flag !== '--no-session-persistence');
const FIXED_VALUES: Readonly<Record<string, string>> = {
  '--input-format': 'text', '--output-format': 'stream-json', '--setting-sources': '', '--mcp-config': '{"mcpServers":{}}',
  '--permission-mode': 'dontAsk', '--permission-prompts': 'none', '--system-prompt-snapshot': 'off',
};
const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every(item => b.includes(item)) && b.every(item => a.includes(item));
const list = (value: string): string[] => value.split(',').filter(Boolean);

/** Независимая проверка argv по запросу и профилю; значения в диагностику не попадают, только имена флагов. */
export function checkPracticalArgv(context: PracticalAdmissionContext): string | undefined {
  const { request } = context;
  const seen = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < context.args.length; index++) {
    const arg = context.args[index]!;
    if (BOOLEAN_FLAGS.includes(arg)) { if (flags.has(arg)) return `повтор аргумента ${arg}`; flags.add(arg); }
    else if (VALUE_FLAGS.includes(arg)) {
      const value = context.args[index + 1];
      if (value === undefined) return `у аргумента ${arg} нет значения`;
      if (seen.has(arg)) return `повтор аргумента ${arg}`;
      seen.set(arg, value); index++;
    } else return 'аргументы запуска содержат неразрешённый флаг или значение';
  }
  for (const flag of REQUIRED_BOOLEAN) if (!flags.has(flag)) return `отсутствует обязательный аргумент ${flag}`;
  for (const [flag, expected] of Object.entries(FIXED_VALUES)) if (seen.get(flag) !== expected) return `аргумент ${flag} не равен ожидаемому`;
  const profile = request.profile;
  const tools = list(seen.get('--tools') ?? '');
  if (!same(tools, profile.tools) || tools.some(tool => !(READ_ONLY_TOOLS as readonly string[]).includes(tool))) return 'набор --tools не совпадает с профилем чтения';
  const allowed = seen.has('--allowedTools') ? list(seen.get('--allowedTools')!) : [];
  if (!same(allowed, profile.allow) || allowed.some(tool => !tools.includes(tool))) return 'набор --allowedTools расширяет профиль';
  const denied = list(seen.get('--disallowedTools') ?? '');
  if (!BLOCKED_TOOLS.every(tool => denied.includes(tool)) || !profile.deny.every(rule => denied.includes(rule))) return 'набор --disallowedTools не содержит обязательных запретов';
  const session = request.resume ? '--resume' : '--session-id';
  const other = request.resume ? '--session-id' : '--resume';
  if (seen.get(session) !== request.agentSessionId || seen.has(other)) return 'идентификатор диалога в argv не совпадает с запросом';
  if (!seen.has('--append-system-prompt')) return 'отсутствует инструкция запуска';
  if (seen.get('--model') !== request.model) return 'модель в argv не совпадает с запросом';
  if (seen.get('--max-turns') !== (request.maxTurns === undefined ? undefined : String(request.maxTurns))) return 'maxTurns в argv не совпадает с запросом';
  if (flags.has('--no-session-persistence') !== (request.persistSession === false)) return 'режим сохранения диалога в argv не совпадает с запросом';
  return undefined;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Отпечаток контекста допуска. Значения разрешённого env участвуют в хеше, но не публикуются:
 * смена HOME/PATH/CLAUDE_CONFIG_DIR меняет отпечаток, как и executable, версия, argv, cwd, профиль, managed-наблюдение. */
export function computeAdmissionFingerprint(context: PracticalAdmissionContext, facts: Pick<ClaudeAdmissionFacts, 'executable' | 'managed'>): string {
  const env = Object.entries(context.env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256').update(stable({
    version: context.detection.version, binaryPath: context.detection.binaryPath, capabilities: context.detection.capabilities,
    executable: facts.executable, managed: facts.managed, args: context.args, env, cwd: context.request.cwd,
    profile: context.request.profile, resume: context.request.resume, agentSessionId: context.request.agentSessionId,
  })).digest('hex');
}

/** Независимое ожидание runtime-inventory: из профиля и контракта версии, не из фактического init. */
export function expectedInventoryFor(context: PracticalAdmissionContext): RuntimeInventoryExpectation {
  return {
    tools: [...context.request.profile.tools],
    plugins: BUILTIN_PLUGIN_NAMES.map(name => ({ id: inventoryId(name), origin: 'builtin' as const })),
    mcpServers: [],
    skills: [],
    slashCommands: [],
    // Builtin-агенты init 2.1.295; регистрация не доказывает исполнение. Неизвестная регистрация не проходит сравнение.
    agents: BUILTIN_AGENT_NAMES.map(inventoryId),
    cliVersion: context.detection.version ?? '',
    permissionMode: 'dontAsk',
  };
}

const verdict = (status: 'blocked' | 'unsupported', reason: PracticalAdmissionReason, detail: string): ProductionPracticalAdmission =>
  ({ status, reason, detail: detail.slice(0, DETAIL_LIMIT), limitations: [] });

const EXECUTABLE_REASONS: Readonly<Record<ExecutableFactReason, string>> = {
  path_unknown: 'путь исполняемого файла не определён',
  unavailable: 'исполняемый файл недоступен для проверки',
  not_regular_file: 'путь исполняемого файла не обычный файл',
};
const MANAGED_REASONS: Readonly<Record<ManagedFactReason, string>> = {
  unobservable: 'effective managed-политика (OS-политика, server-managed) не наблюдаема документированным интерфейсом CLI; отсутствие managed-файлов её не доказывает',
  unreadable: 'managed-файл недоступен или повреждён; effective managed-политика не наблюдаема, отсутствие файлов её не доказывает',
  executable_config: 'managed-политика задаёт исполняемую конфигурацию',
};
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isProvenance = (value: unknown): value is FactProvenance => value === 'real' || value === 'synthetic';

/** Сторонний сборщик мог вернуть неполную или повреждённую структуру: такая форма не допуск. */
function validFact(fact: unknown, reasons: readonly string[], known: (value: Record<string, unknown>) => boolean): boolean {
  if (!isRecord(fact)) return false;
  if (fact.state === 'known') return isProvenance(fact.provenance) && isRecord(fact.value) && known(fact.value);
  if (fact.state === 'unknown') return reasons.includes(fact.reason as string);
  if (fact.state === 'conflict') return reasons.includes(fact.reason as string) && (fact.items === undefined || (Array.isArray(fact.items) && fact.items.length <= 32));
  return false;
}
const validExecutable = (value: Record<string, unknown>): boolean =>
  typeof value.path === 'string' && value.path.length > 0
  && typeof value.size === 'number' && Number.isFinite(value.size) && value.size >= 0
  && typeof value.mtimeMs === 'number' && Number.isFinite(value.mtimeMs) && value.mtimeMs >= 0;
/** Array.from превращает пропуски разреженного массива в undefined: every их бы пропустил. */
const validSources = (observed: readonly unknown[]): boolean => {
  const slots = Array.from(observed);
  return new Set(slots).size === slots.length && slots.every(source => (REQUIRED_MANAGED_SOURCES as readonly unknown[]).includes(source));
};
const validManaged = (value: Record<string, unknown>): boolean =>
  Array.isArray(value.observed) && validSources(value.observed)
  && typeof value.policyDigest === 'string' && /^[0-9a-f]{64}$/.test(value.policyDigest) && value.executableConfig === 'none';
const conflictItems = (items: readonly string[] | undefined): string => (items ?? []).filter(item => MANAGED_ITEMS.has(item)).join(', ');

/** Чистый алгоритм: решение зависит только от контекста запуска и собранных фактов.
 * Свободный текст из фактов, значения env и неизвестные имена в detail не попадают. */
export function assessPracticalFacts(context: PracticalAdmissionContext, facts: ClaudeAdmissionFacts): ProductionPracticalAdmission {
  const { detection, request } = context;
  if ((request.profile as { projectTrust?: unknown }).projectTrust !== 'trusted') return verdict('blocked', 'project_untrusted', 'проект не помечен доверенным');
  if (detection.status !== 'available' || !detection.binaryPath) return verdict('blocked', 'prerequisite_unknown', 'Claude CLI недоступен: исполняемый файл не определён');
  if (detection.auth !== 'authenticated') {
    return verdict('blocked', 'prerequisite_unknown', detection.auth === 'unauthenticated' ? 'штатная авторизация CLI отсутствует' : 'штатная авторизация CLI не подтверждена');
  }
  if (!detection.version) return verdict('blocked', 'prerequisite_unknown', 'версия CLI не определена');
  if (!SUPPORTED_CLAUDE_VERSIONS.includes(detection.version)) {
    const shown = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/.test(detection.version) ? detection.version : 'неразборчива';
    return verdict('unsupported', 'cli_unsupported', `версия CLI ${shown} вне наблюдённого контракта (${SUPPORTED_CLAUDE_VERSIONS.join(', ')})`);
  }
  const absent = REQUIRED_CAPABILITIES.filter(name => detection.capabilities[name] !== true);
  if (absent.length) return verdict('unsupported', 'cli_unsupported', `CLI не подтвердил возможности: ${absent.join(', ')}`);
  // Штатный вход: HOME/CLAUDE_CONFIG_DIR сохранены; env-токен подменил бы вход и скрыл бы его источник.
  const credentials = CREDENTIAL_ENV.filter(name => context.env[name] !== undefined);
  if (credentials.length) return verdict('blocked', 'configuration_conflict', `источник авторизации неоднозначен: задан env ${credentials.join(', ')}`);
  if (!context.env.HOME && !context.env.CLAUDE_CONFIG_DIR) return verdict('blocked', 'prerequisite_unknown', 'не задан HOME или CLAUDE_CONFIG_DIR штатной авторизации');
  const allowedEnv: readonly string[] = [...CLAUDE_ENV_ALLOWLIST, 'DISABLE_AUTOUPDATER', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'];
  const extraEnv = Object.keys(context.env).filter(name => !allowedEnv.includes(name));
  if (extraEnv.length) return verdict('blocked', 'configuration_conflict', `env вне allowlist: ${extraEnv.length} имён (имена не выводятся)`);
  const argvIssue = checkPracticalArgv(context);
  if (argvIssue) return verdict('blocked', 'configuration_conflict', argvIssue);
  if (!isRecord(facts) || !validFact(facts.executable, Object.keys(EXECUTABLE_REASONS), validExecutable) || !validFact(facts.managed, Object.keys(MANAGED_REASONS), validManaged)) {
    return verdict('blocked', 'assessment_failed', 'предпусковые факты неполны или повреждены');
  }
  const executable = facts.executable;
  if (executable.state !== 'known') {
    return verdict('blocked', executable.state === 'conflict' ? 'configuration_conflict' : 'prerequisite_unknown', EXECUTABLE_REASONS[executable.reason]);
  }
  if (executable.value.path !== detection.binaryPath) return verdict('blocked', 'configuration_conflict', 'идентичность исполняемого файла не совпадает с диагностикой');
  const managed = facts.managed;
  if (managed.state !== 'known') {
    const items = managed.state === 'conflict' ? conflictItems(managed.items) : '';
    return verdict('blocked', managed.state === 'conflict' ? 'configuration_conflict' : 'prerequisite_unknown', `${MANAGED_REASONS[managed.reason]}${items ? `: ${items}` : ''}`);
  }
  const unobserved = REQUIRED_MANAGED_SOURCES.filter(source => !managed.value.observed.includes(source));
  if (unobserved.length) return verdict('blocked', 'prerequisite_unknown', `managed-источники не наблюдены: ${unobserved.join(', ')}`);
  const synthetic = executable.provenance === 'synthetic' || managed.provenance === 'synthetic';
  return {
    status: 'ready',
    detail: `${synthetic ? 'synthetic-факты (не реальный запуск): ' : ''}допуск привязан к CLI ${detection.version}, argv, env, cwd и профилю; `
      + 'регистрация builtin plugins не доказывает их исполнение, ранние hooks не исключены',
    limitations: PRACTICAL_LIMITATIONS,
    contextFingerprint: computeAdmissionFingerprint(context, facts),
    expectedInventory: expectedInventoryFor(context),
  };
}

export interface ClaudeAdmissionOptions {
  /** Подменяется только сбор фактов (тесты, синтетические данные); алгоритм оценки неизменен. */
  collect?: ClaudeFactCollector;
  probes?: AdmissionProbes;
}
export interface ClaudeAdmission {
  assess: (context: PracticalAdmissionContext) => Promise<ProductionPracticalAdmission>;
  /** Повторная оценка перед запуском: true только если ready и отпечаток тот же. */
  recheck(context: PracticalAdmissionContext, fingerprint: string): Promise<boolean>;
}

export function createClaudeAdmission(options: ClaudeAdmissionOptions = {}): ClaudeAdmission {
  const collect: ClaudeFactCollector = options.collect ?? (context => collectClaudeFacts(context, options.probes));
  const assess = async (context: PracticalAdmissionContext): Promise<ProductionPracticalAdmission> => {
    let facts: ClaudeAdmissionFacts;
    try { facts = await collect(context); }
    catch { return verdict('blocked', 'assessment_failed', 'сбор предпусковых фактов завершился ошибкой'); }
    return assessPracticalFacts(context, facts);
  };
  const recheck = async (context: PracticalAdmissionContext, fingerprint: string): Promise<boolean> => {
    const again = await assess(context);
    return again.status === 'ready' && again.contextFingerprint === fingerprint;
  };
  return { assess, recheck };
}
export const createClaudeAdmissionEvaluator = (options: ClaudeAdmissionOptions = {}): PracticalAdmissionEvaluator => createClaudeAdmission(options).assess;
