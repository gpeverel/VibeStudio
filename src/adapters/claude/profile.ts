import { isAbsolute, relative, sep } from 'node:path';
import type { AccessProfile, AgentErrorReason, AgentRunRequest, AgentDetection } from '../../core/ports/agent.ts';

export const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'] as const;
export const BLOCKED_TOOLS = ['Bash', 'PowerShell', 'Edit', 'Write', 'NotebookEdit', 'Agent', 'Task', 'Skill', 'WebFetch', 'WebSearch'] as const;
export interface ProfileIssue { reason: AgentErrorReason; detail: string }

/** Причина отказа штатного запуска; успешные пробы сами по себе её не устраняют. */
export const UNVERIFIED_ACCESS_DETAIL = 'Штатная среда запуска не обеспечивает файловые границы профиля и сеть provider-only; '
  + 'эффективная managed-конфигурация не проверена. POSIX-группа не охватывает потомков, вышедших через setsid. '
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
}
export interface AccessVerificationContext {
  detection: AgentDetection;
  request: AgentRunRequest;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
}
export type AccessVerifier = (context: AccessVerificationContext) => Promise<AccessVerification>;

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

export function validateAccessProfile(profile: AccessProfile, cwd: string): ProfileIssue[] {
  const issues: ProfileIssue[] = [];
  const invalid = (detail: string): void => { issues.push({ reason: 'profile_unsupported', detail }); };
  if (!profile || profile.mode !== 'read-only') { invalid('В 0C поддерживается только профиль read-only'); return issues; }
  if (!Array.isArray(profile.tools) || profile.tools.some(tool => !(READ_ONLY_TOOLS as readonly string[]).includes(tool))) invalid('Набор инструментов должен быть закрытым набором чтения');
  if (!Array.isArray(profile.allow) || profile.allow.some(tool => !profile.tools.includes(tool as typeof READ_ONLY_TOOLS[number]))) invalid('Allow не может расширять набор инструментов');
  if (!Array.isArray(profile.deny) || profile.deny.some(rule => typeof rule !== 'string' || rule.length > 512)) invalid('Некорректный список deny');
  const config = profile.configPolicy;
  if (!config || !Array.isArray(config.settingSources) || config.settingSources.length || config.loadHooks !== false || config.loadMcp !== false || config.loadPlugins !== false) invalid('Автоматическая исполняемая конфигурация должна быть отключена');
  const fs = profile.fs;
  if (!fs || !Array.isArray(fs.writeRoots) || fs.writeRoots.length || !Array.isArray(fs.readRoots) || !Array.isArray(fs.runtimeWriteRoots) || !Array.isArray(fs.protectedPaths)) {
    invalid('Не заданы границы файлового доступа'); return issues;
  }
  if (!isAbsolute(cwd) || fs.readRoots.length !== 1 || fs.readRoots[0] !== cwd) invalid('В минимальном профиле единственный корень чтения совпадает с cwd');
  const paths = [...fs.readRoots, ...fs.runtimeWriteRoots, ...fs.protectedPaths, ...(fs.gitCommonDir ? [fs.gitCommonDir] : [])];
  if (paths.some(path => typeof path !== 'string' || !isAbsolute(path) || path.includes('\0'))) invalid('Границы должны быть абсолютными путями');
  if (fs.runtimeWriteRoots.some(root => [cwd, ...fs.protectedPaths, ...(fs.gitCommonDir ? [fs.gitCommonDir] : [])].some(path => inside(root, path) || inside(path, root)))) invalid('Служебные записи пересекаются с защищёнными путями');
  if (profile.network !== 'provider-only') invalid('Неподдерживаемая политика сети');
  return issues;
}
