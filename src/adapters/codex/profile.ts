import { delimiter, isAbsolute } from 'node:path';
import { buildAgentInstructions } from '../../core/agent-instructions.ts';
import type { AgentErrorReason } from '../../core/ports/agent.ts';
import { CODEX_ENV_ALLOWLIST, CODEX_LIMITATIONS, CODEX_POLICY_CONFIG, CODEX_RESTRICTIONS, CODEX_SANDBOX_POLICY_CONFIG, CODEX_SANDBOX_RESTRICTIONS } from './contracts.ts';
import type { CodexAccessProfile, CodexAdmissionContext, CodexAdmissionReason, CodexCapabilities, CodexLimitation, CodexProductionAdmission, CodexRequirementGap, CodexRestriction, CodexThreadRef } from './contracts.ts';

export interface CodexProfileIssue { reason: AgentErrorReason; detail: string }

const PROFILE_KEYS = ['kind', 'mode', 'sandbox', 'approvalPolicy', 'workspaceRoot', 'projectTrust', 'requires'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRODUCTION_DETAIL_LIMIT = 512;

/** Документация: `exec resume` принимает «UUID or thread name». Имя не передаём, чтобы ID не стал именем. */
export const isCodexThreadId = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
export const isCodexThreadRef = (value: unknown): value is CodexThreadRef => {
  const ref = value as { adapter?: unknown; threadId?: unknown } | null;
  return typeof value === 'object' && ref !== null && ref.adapter === 'codex' && isCodexThreadId(ref.threadId);
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Профиль другого адаптера (Claude: tools/allow/deny/fs) и неизвестные ключи не интерпретируются. */
export function validateCodexProfile(profile: unknown, cwd: string): CodexProfileIssue[] {
  const unsupported = (detail: string): CodexProfileIssue[] => [{ reason: 'profile_unsupported', detail }];
  if (!isRecord(profile) || !['codex-read-only-v1', 'codex-sandbox-read-v1'].includes(profile.kind as string)) {
    return unsupported('Неизвестный вид профиля доступа Codex; профили других адаптеров не принимаются');
  }
  const named = profile.kind === 'codex-sandbox-read-v1';
  const extra = Object.keys(profile).filter(key => !PROFILE_KEYS.includes(key));
  if (extra.length) return unsupported('Профиль Codex не принимает инструменты и границы других адаптеров');
  if (profile.mode !== 'read-only' || profile.sandbox !== (named ? 'named-profile' : 'read-only') || profile.approvalPolicy !== 'never') {
    return unsupported('Профиль требует своего sandbox и запрещает расширение прав через подтверждения');
  }
  if (typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.includes('\0')) return unsupported('cwd должен быть абсолютным путём без NUL');
  if (typeof profile.workspaceRoot !== 'string' || !isAbsolute(profile.workspaceRoot) || profile.workspaceRoot.includes('\0') || profile.workspaceRoot !== cwd) {
    return unsupported('Ожидаемая область профиля должна совпадать с cwd');
  }
  const requires = profile.requires;
  const restrictions = named ? CODEX_SANDBOX_RESTRICTIONS : CODEX_RESTRICTIONS;
  if (!Array.isArray(requires) || requires.length !== restrictions.length || new Set(requires).size !== requires.length
    || !restrictions.every(item => requires.includes(item))) {
    return unsupported('Профиль не может ослаблять или расширять обязательные ограничения');
  }
  if (profile.projectTrust !== 'trusted') {
    return [{ reason: 'practical_admission_blocked', detail: 'project_untrusted: профиль требует явного доверия проекту' }];
  }
  return [];
}

const isLimitation = (value: unknown): value is CodexLimitation => CODEX_LIMITATIONS.includes(value as CodexLimitation);
// Array.every пропускает пустые позиции; разворачиваем их в undefined до проверки полноты.
const complete = <T>(values: unknown, all: readonly T[], guard: (value: unknown) => value is T): values is readonly T[] =>
  Array.isArray(values) && values.length === all.length && new Set(values).size === all.length && [...values].every(guard);

export interface CodexVerdict { error?: 'profile_unsupported' | 'practical_admission_blocked'; reason: string; detail: string }

/** Runtime-проверка результата доверенной оценки: неполная или неизвестная форма — не допуск. */
export function checkCodexAdmission(admission: unknown, profileKind: CodexAccessProfile['kind'] = 'codex-read-only-v1'): CodexVerdict {
  const blocked = (detail: string): CodexVerdict => ({ error: 'practical_admission_blocked', reason: 'assessment_failed', detail });
  if (profileKind !== 'codex-read-only-v1' && profileKind !== 'codex-sandbox-read-v1') return blocked('неизвестный профиль допуска');
  if (!isRecord(admission)) return blocked('оценка допуска не вернула результат');
  const detail = typeof admission.detail === 'string' ? admission.detail.slice(0, PRODUCTION_DETAIL_LIMIT) : '';
  if (!detail) return blocked('некорректный результат оценки допуска');
  if (admission.status === 'blocked' || admission.status === 'unsupported') {
    const reasons = ['assessment_failed', 'project_untrusted', 'requirement_unconfirmed', 'configuration_conflict', 'cli_unsupported'];
    if (typeof admission.reason !== 'string' || !reasons.includes(admission.reason)) return blocked('некорректный результат оценки допуска');
    return { error: admission.status === 'unsupported' ? 'profile_unsupported' : 'practical_admission_blocked', reason: admission.reason, detail };
  }
  if (admission.status !== 'ready') return blocked('некорректный результат оценки допуска');
  const restrictions: readonly CodexRestriction[] = profileKind === 'codex-sandbox-read-v1' ? CODEX_SANDBOX_RESTRICTIONS : CODEX_RESTRICTIONS;
  if (!complete(admission.confirmed, restrictions, (value): value is CodexRestriction => restrictions.includes(value as CodexRestriction))) {
    return { error: 'practical_admission_blocked', reason: 'requirement_unconfirmed', detail: 'ready без подтверждения всех обязательных ограничений профиля' };
  }
  if (!complete(admission.limitations, CODEX_LIMITATIONS, isLimitation)) {
    return { error: 'practical_admission_blocked', reason: 'assessment_failed', detail: 'ready без полного набора известных ограничений допуска' };
  }
  return { reason: 'ready', detail };
}

const CONFIG_SOURCE = 'https://learn.chatgpt.com/docs/config-file/config-reference';
const CLI_SOURCE = 'https://learn.chatgpt.com/docs/cli/reference';
const HOOKS_SOURCE = 'https://learn.chatgpt.com/docs/hooks';
const SOURCE_REVISION = '83086188ae0614bd882818ff1aa23f3194962012';
const SOURCE_ROOT = `https://github.com/openai/codex/blob/${SOURCE_REVISION}/codex-rs`;
const TOOL_SOURCE = `${SOURCE_ROOT}/core/src/tools/spec_plan.rs`;
const TOOL_POLICY_SOURCE = `${SOURCE_ROOT}/ext/extension-api/src/tool_policy.rs`;
const PERMISSIONS_SOURCE = 'https://learn.chatgpt.com/docs/permissions';

function freezeGaps(gaps: CodexRequirementGap[]): readonly CodexRequirementGap[] {
  return Object.freeze(gaps.map(gap => Object.freeze({ ...gap, sources: Object.freeze([...gap.sources]) })));
}

/** D02 подтверждает интерфейс/login-status; source-review — предел встроенного exec-маршрута.
 * Соответствие npm-бинарника исходнику не доказано. Это объяснение отказа, не импорт test fixtures.
 * Системная/managed-конфигурация не объявляется known empty и не читается оценщиком. */
function requirementGaps(knownBuiltinRoute = false): readonly CodexRequirementGap[] {
  const gaps: CodexRequirementGap[] = [
    { requirement: 'shell_forbidden', status: 'unconfirmed', code: 'shell_gate_scope_unconfirmed',
      detail: 'По исходнику shell_tool=false убирает встроенные exec_command/write_stdin; выполнение через MCP, расширения и динамические инструменты не исключено.',
      sources: [CONFIG_SOURCE, TOOL_SOURCE] },
    knownBuiltinRoute ? { requirement: 'reads_closed', status: 'unsupported', code: 'closed_read_mechanism_unavailable',
      detail: 'В реестре rust-v0.163.0 нет встроенного чтения текстовых файлов без shell; ToolPolicy.allowed_tools доступен встраивающему хосту. '
        + 'Закрытый MCP-интерфейс чтения адаптером не реализован. Соответствие npm-бинарника тегу не подтверждено.',
      sources: [TOOL_SOURCE, TOOL_POLICY_SOURCE],
      sourceReview: Object.freeze({ revision: SOURCE_REVISION, scope: 'builtin_exec', binaryCorrespondence: 'unconfirmed' }) }
      : { requirement: 'reads_closed', status: 'unconfirmed', code: 'closed_read_mechanism_unconfirmed',
        detail: 'Закрытый интерфейс чтения для этого контекста не подтверждён; вывод по исходнику встроенного exec 0.163.0 применяется только после проверки версии и конфигурации.',
        sources: [CONFIG_SOURCE, TOOL_SOURCE] },
    { requirement: 'project_extensions_disabled', status: 'unconfirmed', code: 'project_extension_controls_unconfirmed',
      detail: 'По исходнику проектные слои исключаются без явного trusted; trust из других слоёв и отключение всех MCP/plugins/skills не подтверждены. projectTrust — согласие приложения.',
      sources: [CONFIG_SOURCE, HOOKS_SOURCE, `${SOURCE_ROOT}/config/src/loader/mod.rs`] },
    { requirement: 'user_extensions_disabled', status: 'unconfirmed', code: 'user_extension_controls_unconfirmed',
      detail: 'По исходнику ignore-user-config оставляет пустой User-слой; hooks=false оставляет builtin-хуки. Отключение пользовательских MCP/plugins/skills не подтверждено.',
      sources: [CLI_SOURCE, HOOKS_SOURCE, `${SOURCE_ROOT}/hooks/src/engine/mod.rs`] },
  ];
  return freezeGaps(gaps);
}

/** Отказ нового профиля не наследует невозможность чтения без shell.
 * Source-review описывает выбор политики, но не аттестует бинарник, слияние слоёв и все инструменты.
 * R/R2 не принимаются как runtime evidence: пять syscall sandbox не доказывают exec/resume.
 * Это конкретные отсутствующие основания допуска, а не требование полного managed-аудита. */
function sandboxRequirementGaps(resume: boolean): readonly CodexRequirementGap[] {
  return freezeGaps([
    { requirement: 'shell_sandboxed', status: 'unconfirmed',
      code: resume ? 'resume_permissions_unconfirmed' : 'sandbox_effective_policy_unconfirmed',
      detail: resume
        ? 'Исходник передаёт текущий именованный профиль в resume и не подставляет сохранённый при явном override. Применение к командам установленной CLI не подтверждено.'
        : 'SessionFlags default_permissions выбирает Profiles по исходнику 0.163.0 при отсутствии --sandbox. Эффективный профиль команд установленной CLI не подтверждён.',
      sources: [`${SOURCE_ROOT}/core/src/config/mod.rs`, `${SOURCE_ROOT}/exec/src/lib.rs`,
        `${SOURCE_ROOT}/app-server/src/request_processors/thread_processor.rs`] },
    { requirement: 'reads_scoped', status: 'unconfirmed', code: 'sandbox_read_scope_unconfirmed',
      detail: 'Не подтверждены границы чтения команд exec/resume, включая симлинки, дополнительные workspace roots и runtime-пути :minimal. R1s не содержит внешней попытки; R2 проверяет другой маршрут.',
      sources: [PERMISSIONS_SOURCE, `${SOURCE_ROOT}/cli/src/debug_sandbox.rs`, `${SOURCE_ROOT}/exec/src/lib.rs`] },
    { requirement: 'writes_forbidden', status: 'unconfirmed', code: 'non_shell_write_policy_unconfirmed',
      detail: 'По исходнику apply_patch при never отклоняет патч вне записываемых путей. Отсутствие таких путей в effective-профиле и предотвращение эффектов всех инструментов модели не подтверждены.',
      sources: [`${SOURCE_ROOT}/core/src/safety.rs`, TOOL_SOURCE, PERMISSIONS_SOURCE] },
    { requirement: 'project_extensions_disabled', status: 'unconfirmed', code: 'project_extension_controls_unconfirmed',
      detail: 'Кандидаты hooks/apps/plugins и project_doc_max_bytes не подтверждают отключение всех проектных MCP/skills и альтернативных инструментов. Положительный контроль R1p не сработал; доверие приложения не меняет trust CLI.',
      sources: [CONFIG_SOURCE, `${SOURCE_ROOT}/core/src/agents_md.rs`, `${SOURCE_ROOT}/ext/skills/src/host_roots.rs`, TOOL_SOURCE] },
    { requirement: 'user_extensions_disabled', status: 'unconfirmed', code: 'user_extension_controls_unconfirmed',
      detail: 'ignore-user-config оставляет User-слой пустым, но поиск навыков в CODEX_HOME и HOME сохраняется по исходнику. Пользовательские инструкции, MCP/plugins/skills и небазовые hooks не подтверждены как отключённые.',
      sources: [CLI_SOURCE, `${SOURCE_ROOT}/config/src/loader/mod.rs`, `${SOURCE_ROOT}/ext/skills/src/host_roots.rs`,
        `${SOURCE_ROOT}/hooks/src/engine/mod.rs`] },
  ]);
}

/** Проверяем именно фиксированный маршрут адаптера: лишние, дублирующие и конфликтующие overrides
 * не допускаются. Это проверка передачи политики, не её исполнения CLI. Prompt не включается в argv. */
function launchConfigurationMatches(context: CodexAdmissionContext): boolean {
  const { request, args, env } = context;
  if (typeof request.resume !== 'boolean' || request.maxTurns !== undefined
    || (request.resume ? !isCodexThreadRef(request.thread) || request.persistSession === false : request.thread !== undefined)) return false;
  if (request.model !== undefined && (typeof request.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(request.model))) return false;
  const instructions = JSON.stringify(buildAgentInstructions({ resume: request.resume })).replaceAll('\u007f', '\\u007f');
  const named = request.profile.kind === 'codex-sandbox-read-v1';
  const expected = [
    'exec', ...(request.resume ? ['resume'] : []), '--json',
    ...(named ? ['--strict-config'] : request.resume ? ['-c', 'sandbox_mode="read-only"'] : ['--sandbox', 'read-only']),
    '--ignore-user-config', '--ignore-rules', '-c', 'approval_policy="never"',
    ...(named ? CODEX_SANDBOX_POLICY_CONFIG : CODEX_POLICY_CONFIG).flatMap(value => ['-c', value]),
    '-c', 'check_for_update_on_startup=false', '-c', 'analytics.enabled=false',
    '-c', `developer_instructions=${instructions}`,
    ...(request.persistSession === false ? ['--ephemeral'] : []),
    ...(request.model === undefined ? [] : ['--model', request.model]),
    ...(request.resume ? [request.thread.threadId] : []), '-',
  ];
  if (!Array.isArray(args) || args.length !== expected.length || expected.some((arg, index) => arg !== args[index])) return false;
  if (!isRecord(env) || !isRecord(request.env)) return false;
  if (Object.entries(env).some(([name, value]) => !(CODEX_ENV_ALLOWLIST as readonly string[]).includes(name)
    || typeof value !== 'string' || value.includes('\0'))) return false;
  // login status не подтверждает CODEX_API_KEY; даже пустой заданный ключ меняет согласованный контекст.
  if (Object.hasOwn(env, 'CODEX_API_KEY')) return false;
  if (Object.entries(request.env).some(([name, value]) => env[name] !== value)) return false;
  if (typeof env.HOME !== 'string' || !isAbsolute(env.HOME)
    || typeof env.PATH !== 'string' || !env.PATH.split(delimiter).every(isAbsolute)) return false;
  return ['CODEX_HOME', 'TMPDIR'].every(name => env[name] === undefined || isAbsolute(env[name]));
}

/** Проверяемый отказ для конкретного контекста. Unknown — blocked, а не утверждение о невозможности
 * политики во всей CLI. Unsupported относится к выбранному интерфейсу/профилю и пределу встроенного
 * exec-маршрута по закреплённому исходнику. Factory не запускает процессов, не читает credentials,
 * не принимает synthetic evidence. Идентичность executable проверяет адаптер до/после оценки.
 * Равенство версии выбирает изученный source-контракт отказа; другие версии остаются unconfirmed.
 * Наблюдение R не создаёт отсутствующий интерфейс чтения и не выдаёт ready автоматически. */
export function createCodexProductionAdmission(): (context: CodexAdmissionContext) => Promise<CodexProductionAdmission> {
  return async (context): Promise<CodexProductionAdmission> => {
    let requirements = requirementGaps();
    const deny = (status: 'blocked' | 'unsupported', reason: CodexAdmissionReason, detail: string,
      evaluatedRequirements = requirements): CodexProductionAdmission =>
      Object.freeze({ status, reason, detail, requirements: evaluatedRequirements });
    try {
      const { request, detection } = context;
      const named = request.profile?.kind === 'codex-sandbox-read-v1';
      if (named) requirements = sandboxRequirementGaps(request.resume);
      const issue = validateCodexProfile(request.profile, request.cwd)[0];
      if (issue) return deny(issue.reason === 'profile_unsupported' ? 'unsupported' : 'blocked',
        issue.reason === 'profile_unsupported' ? 'cli_unsupported' : 'project_untrusted', issue.detail);
      if (!detection.binaryPath || !isAbsolute(detection.binaryPath) || detection.binaryPath.includes('\0')
        || !detection.version || detection.auth !== 'authenticated') {
        return deny('blocked', 'requirement_unconfirmed', 'Не установлены обязательные путь/версия/штатная авторизация CLI.');
      }
      const required: (keyof CodexCapabilities)[] = ['execJson', 'stdinPrompt', 'configOverrides', 'ignoreUserConfig', 'ignoreRules', 'loginStatus'];
      if (request.resume) required.push('resume');
      if (named) required.push(request.resume ? 'resumeStrictConfig' : 'strictConfig');
      else if (!request.resume) required.push('sandbox');
      if (request.persistSession === false) required.push('ephemeral');
      if (request.model !== undefined) required.push('model');
      const absent = required.filter(key => detection.capabilities[key] === false);
      if (absent.length) return deny('unsupported', 'cli_unsupported', `Выбранный интерфейс CLI не объявил необходимые возможности: ${absent.join(', ')}.`);
      if (detection.status !== 'available' || detection.unavailable.length
        || required.some(key => detection.capabilities[key] !== true) || detection.version !== '0.163.0') {
        return deny('blocked', 'requirement_unconfirmed', 'Версия или обязательные возможности CLI не подтверждены для изученной конфигурации 0.163.0.');
      }
      if (!launchConfigurationMatches(context)) {
        return deny('blocked', 'configuration_conflict', 'argv/env не соответствуют фиксированной политике и штатной авторизации; лишние overrides и подмена окружения запрещены.');
      }
      if (named) return deny('blocked', 'requirement_unconfirmed',
        'codex-sandbox-read-v1: не подтверждены effective-профиль команд first/resume, границы чтения, запрет записи альтернативными инструментами '
        + 'и отключение проектных/пользовательских расширений. Нужны основания для этих пяти требований; версия/help и R2 их не заменяют. '
        + 'См. docs/P3-CODEX-COMPATIBILITY.md §14–16.');
      return deny('unsupported', 'cli_unsupported',
        'reads_closed: выбранный встроенный exec-маршрут 0.163.0 не предоставляет закрытое чтение текстовых файлов при shell_tool=false '
        + '(исходник 83086188; соответствие npm-бинарника тегу не подтверждено). '
        + 'Нужен отдельный закрытый интерфейс чтения с сохранением SPEC; MCP и расширения не разрешаются автоматически. '
        + 'Остальные ограничения не подтверждены; см. docs/P3-CODEX-COMPATIBILITY.md §12.', requirementGaps(true));
    } catch {
      return deny('blocked', 'assessment_failed', 'Некорректный контекст оценки допуска Codex.');
    }
  };
}
