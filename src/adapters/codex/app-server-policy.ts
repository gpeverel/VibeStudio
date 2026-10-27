import { lstat, opendir, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CODEX_SANDBOX_POLICY_CONFIG, CODEX_SANDBOX_PERMISSION_PROFILE } from './contracts.ts';
import { codexExtensionOverrides } from './extensions.ts';
import { object, RpcError } from './rpc.ts';
import type { JsonObject } from './rpc.ts';

export const APP_SERVER_CONFIG = Object.freeze([...CODEX_SANDBOX_POLICY_CONFIG,
  'approval_policy="never"', 'model_provider="openai"', 'developer_instructions=""', 'notify=[]',
  'features.retain_client_developer_messages=true', 'features.remote_plugin=false', 'features.tool_suggest=false',
  'features.memories=false', 'include_apps_instructions=false', 'include_collaboration_mode_instructions=false',
  'check_for_update_on_startup=false', 'analytics.enabled=false',
]);
const blocked = (): never => { throw new RpcError('practical_admission_blocked', 'Настройки app-server не соответствуют профилю чтения'); };

/** У app-server нет ignore-rules: неизвестные локальные rules дают отказ ДО запуска CLI.
 * Глобальные файлы не изменяются; managed-политика сохраняет прежнюю границу доверия CLI. */
export async function appServerArgs(cwd: string, env: Readonly<Record<string, string>>): Promise<string[]> {
  const extensions = await codexExtensionOverrides(cwd, env);
  const roots = [join(env.CODEX_HOME ?? join(env.HOME!, '.codex'), 'rules')];
  for (let dir = cwd; ; dir = dirname(dir)) { roots.push(join(dir, '.codex', 'rules')); if (dir === dirname(dir)) break; }
  for (const root of new Set(roots)) {
    let info;
    try { info = await lstat(root); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') continue; throw cause; }
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) blocked();
    for await (const _entry of await opendir(root)) { void _entry; blocked(); }
  }
  return ['app-server', '--listen', 'stdio://', '--strict-config', ...[...APP_SERVER_CONFIG, ...extensions].flatMap(value => ['-c', value])];
}
const nonNullKeys = (value: JsonObject): string[] => Object.keys(value).filter(key => value[key] !== null && value[key] !== undefined).sort();
const equalsKeys = (value: JsonObject, keys: string[]): boolean => JSON.stringify(nonNullKeys(value)) === JSON.stringify(keys.sort());
const empty = (value: unknown): boolean => value === null || value === undefined || Array.isArray(value) && value.length === 0
  || object(value) !== undefined && Object.keys(object(value)!).length === 0;

/** config/read возвращает и чувствительные поля: не сохраняем/не журналируем исходный объект.
 * MCP выключается по всем фактически загруженным именам в thread config до создания подключений.
 * Ключи передаются объектом, а не dotted path: имя сервера не может внедрить другой override. */
export function inspectAppServerConfig(value: unknown, cwd: string): JsonObject {
  const config = object(object(value)?.config); if (!config) return blocked();
  if (config.approval_policy !== 'never' || config.default_permissions !== CODEX_SANDBOX_PERMISSION_PROFILE
    || config.model_provider !== 'openai' || config.web_search !== 'disabled'
    || !Array.isArray(config.notify) || config.notify.length !== 0) blocked();
  const features = object(config.features); if (!features) return blocked();
  // Явно включённый пользовательский флаг может добавить другой канал действий
  // (например computer_use/js_repl). Не ждём события уже запущенного инструмента.
  const enabled = new Set(['shell_tool', 'retain_client_developer_messages',
    'api_key_cyber_access_programs', 'api_key_model_discovery', 'auth_elicitation', 'mentions_v2']);
  for (const [name, value] of Object.entries(features)) {
    if (value !== null && value !== false && (value !== true || !enabled.has(name))) blocked();
  }
  for (const entry of APP_SERVER_CONFIG.filter(value => value.startsWith('features.'))) {
    const [key, expected] = entry.slice('features.'.length).split('=');
    if (features[key!] !== (expected === 'true')) blocked();
  }
  if (config.project_doc_max_bytes !== 0 || config.include_apps_instructions !== false
    || config.include_collaboration_mode_instructions !== false || config.developer_instructions !== '') blocked();
  const skills = object(config.skills);
  if (skills?.include_instructions !== false || object(skills?.bundled)?.enabled !== false
    || object(object(config.cloud)?.skills)?.enabled !== false) blocked();
  if (object(object(config.projects)?.[cwd])?.trust_level !== 'untrusted') blocked();
  const profile = object(object(config.permissions)?.[CODEX_SANDBOX_PERMISSION_PROFILE]);
  if (!profile || !equalsKeys(profile, ['filesystem', 'network'])) return blocked();
  const fs = object(profile.filesystem); const network = object(profile.network);
  if (!fs || !network || !equalsKeys(fs, [':root', ':minimal', ':workspace_roots'])
    || fs[':root'] !== 'deny' || fs[':minimal'] !== 'read'
    || JSON.stringify(fs[':workspace_roots']) !== '{".":"read"}' || network.enabled !== false || !equalsKeys(network, ['enabled'])) blocked();
  // Эти источники могут подменить инструкции, каталог инструментов или провайдера.
  for (const key of ['model_instructions_file', 'experimental_compact_prompt_file', 'model_catalog_json',
    'instructions', 'compact_prompt', 'experimental_thread_store_endpoint', 'experimental_thread_store']) {
    if (config[key] !== null && config[key] !== undefined && config[key] !== false && config[key] !== '') blocked();
  }
  if (!empty(object(config.model_providers)?.openai)) blocked();
  const shell = object(config.shell_environment_policy);
  if (shell && (!empty(shell.set) || shell.experimental_use_profile === true)) blocked();
  const servers = object(config.mcp_servers); if (!servers || Object.keys(servers).length > 128) return blocked();
  for (const name of Object.keys(servers)) if (!name || name.length > 256 || !object(servers[name])) blocked();
  return { mcp_servers: Object.fromEntries(Object.keys(servers).map(name => [name, { enabled: false }])) };
}

export function checkThreadPolicy(value: JsonObject, cwd: string, expectedThread?: string): string {
  const thread = object(value.thread); const id = thread?.id;
  if (typeof id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)
    || expectedThread !== undefined && id !== expectedThread || thread?.cwd !== cwd || value.cwd !== cwd
    || value.approvalPolicy !== 'never' || object(value.activePermissionProfile)?.id !== CODEX_SANDBOX_PERMISSION_PROFILE
    || object(value.sandbox)?.type !== 'readOnly' || object(value.sandbox)?.networkAccess !== false
    || JSON.stringify(value.runtimeWorkspaceRoots) !== JSON.stringify([cwd])
    || !Array.isArray(value.instructionSources) || value.instructionSources.length !== 0) return blocked();
  return id;
}
