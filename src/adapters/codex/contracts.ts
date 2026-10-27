import type { AgentDetection, AgentRunRequestBase } from '../../core/ports/agent.ts';

/** Источники: Codex CLI non-interactive mode / config-reference (learn.chatgpt.com, 2026-10-19),
 * codex-rs/exec (main). Установленная версия 0.163.0 (npm metadata) этими документами не аттестуется.
 * Всё ниже — контракт адаптера VibeStudio, а не наблюдение поведения реальной CLI. */

/** Ограничения продуктового read-only (SPEC §3). Профиль называет требования; их исполнение
 * подтверждает только допуск конкретного запуска, а не имя профиля и не флаг `--sandbox`. */
export const CODEX_RESTRICTIONS = [
  /** Модель не может выполнять произвольные команды. */
  'shell_forbidden',
  /** Доступные операции чтения ограничены закрытым набором внутри рабочей области. */
  'reads_closed',
  /** Hooks, MCP, plugins/apps, skills и rules проекта не загружаются. */
  'project_extensions_disabled',
  /** То же для пользовательского слоя CODEX_HOME. `--ignore-user-config` документирован только для config.toml:
   * hooks.json, skills и plugins в CODEX_HOME этим флагом не покрыты, поэтому требование подтверждает лишь допуск.
   * Системная и managed-конфигурация сюда не входит: она остаётся неаудированной (cli_configuration_not_audited). */
  'user_extensions_disabled',
] as const;
export type CodexLegacyRestriction = typeof CODEX_RESTRICTIONS[number];

/** Вариант a, выбранный пользователем: shell разрешён только с профилем чтений.
 * Это новый контракт, а не переименование shell_forbidden/reads_closed старого профиля. */
export const CODEX_SANDBOX_RESTRICTIONS = Object.freeze([
  'shell_sandboxed',
  'reads_scoped',
  /** Запрет эффектов записи относится также к apply_patch и иным инструментам модели. */
  'writes_forbidden',
  'project_extensions_disabled',
  'user_extensions_disabled',
] as const);
export type CodexSandboxRestriction = typeof CODEX_SANDBOX_RESTRICTIONS[number];
export type CodexRestriction = CodexLegacyRestriction | CodexSandboxRestriction;

/** Границы допуска, которые остаются неизвестными даже при ready. */
export const CODEX_LIMITATIONS = [
  /** Sandbox, если он есть, принадлежит Codex CLI: приложение его не аттестует. */
  'os_isolation_not_attested',
  'network_not_restricted',
  'detached_children_not_guaranteed',
  'cli_configuration_not_audited',
] as const;
export type CodexLimitation = typeof CODEX_LIMITATIONS[number];

/** Разрешённые имена окружения; значения не входят в evidence/диагностику допуска. */
export const CODEX_ENV_ALLOWLIST = [
  'HOME', 'PATH', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'CODEX_HOME', 'CODEX_API_KEY',
] as const;

/** Кандидаты по документации и исходнику rust-v0.163.0 (83086188…), одинаковые для first/resume.
 * Их передача не подтверждает effective-политику установленной версии, закрытое чтение или
 * отключение всех MCP/plugins/skills. unified_exec=false не убирает команды: даже при применении
 * оставляет one-shot exec_command. shell_tool=false убирает встроенный shell по исходнику.
 * agents.enabled=false перекрывает каталог модели, но V2 приоритетнее — она отключается отдельно.
 * Применение установленным бинарником проверяется отдельно; см. P3-CODEX-COMPATIBILITY.md §12. */
export const CODEX_POLICY_CONFIG = Object.freeze([
  'features.shell_tool=false',
  'features.hooks=false',
  'features.apps=false',
  'features.multi_agent=false',
  'features.multi_agent_v2=false',
  'agents.enabled=false',
  'features.view_image=false',
  'web_search="disabled"',
] as const);

export const CODEX_SANDBOX_PERMISSION_PROFILE = 'vibestudio-read-v1';
/** Кандидат first/resume по rust-v0.163.0 (83086188…), не доказательство effective-конфигурации.
 * -c default_permissions выбирает Profiles в SessionFlags; --sandbox выбирает Legacy.
 * Поэтому legacy sandbox_mode/--sandbox отсутствуют. Другие слои могут дополнять профиль.
 * :minimal и дополнительные workspace roots не аттестуются этим набором overrides.
 * project_doc_max_bytes=0 ограничивает проектные документы, не пользовательские инструкции
 * и не навыки. Полнота выключения расширений остаётся обязательным условием допуска. */
export const CODEX_SANDBOX_POLICY_CONFIG = Object.freeze([
  `default_permissions="${CODEX_SANDBOX_PERMISSION_PROFILE}"`,
  `permissions.${CODEX_SANDBOX_PERMISSION_PROFILE}.filesystem={":root"="deny",":minimal"="read",":workspace_roots"={"."="read"}}`,
  `permissions.${CODEX_SANDBOX_PERMISSION_PROFILE}.network.enabled=false`,
  'features.shell_tool=true',
  'features.hooks=false',
  'features.apps=false',
  'features.plugins=false',
  'features.multi_agent=false',
  'features.multi_agent_v2=false',
  'agents.enabled=false',
  'features.view_image=false',
  'web_search="disabled"',
  'project_doc_max_bytes=0',
  'skills.include_instructions=false',
  'skills.bundled.enabled=false',
  'cloud.skills.enabled=false',
  'features.image_generation=false',
  'features.goals=false',
] as const);

/** Профиль Codex не наследует Read/Glob/Grep Claude: такой набор у Codex пока не подтверждён.
 * `sandbox` — политика самой CLI для команд модели, а не ОС-граница приложения. */
export interface CodexReadOnlyProfile {
  kind: 'codex-read-only-v1';
  mode: 'read-only';
  sandbox: 'read-only';
  approvalPolicy: 'never';
  /** Ожидаемая область операций; должна совпадать с cwd. Не ограничивает процесс средствами ОС. */
  workspaceRoot: string;
  /** Само поле доверия не заменяет допуск конкретного запуска. */
  projectTrust: 'trusted';
  requires: readonly CodexLegacyRestriction[];
}

/** Явный профиль чтений для команд модели; не полный доступ и не готовый допуск.
 * Ожидаемая область — workspace, с отдельно описанными runtime-исключениями CLI.
 * Их фактический охват и политика остальных инструментов должны быть подтверждены. */
export interface CodexSandboxReadProfile {
  kind: 'codex-sandbox-read-v1';
  mode: 'read-only';
  sandbox: 'named-profile';
  approvalPolicy: 'never';
  workspaceRoot: string;
  /** Доверие приложения не устанавливает projects.<path>.trust_level самой CLI. */
  projectTrust: 'trusted';
  requires: readonly CodexSandboxRestriction[];
}
export type CodexAccessProfile = CodexReadOnlyProfile | CodexSandboxReadProfile;

/** История Codex принадлежит только этому адаптеру. ID приложения/хода и ID Claude сюда не подставляются:
 * thread_id берётся из `run_started.agentSessionId` предыдущего хода Codex. */
export interface CodexThreadRef { readonly adapter: 'codex'; readonly threadId: string }

/** Привязка ссылки к контексту приложения. Тег `adapter:'codex'` и форма UUID принадлежность не доказывают:
 * resume принимается, только если thread_id наблюдался этим экземпляром адаптера (run_started) для того же
 * sessionId/participantId/workspaceId/cwd либо доверенное хранилище композиции подтвердило привязку. */
export interface CodexThreadBinding {
  readonly threadId: string;
  readonly sessionId: string;
  readonly participantId: string;
  readonly workspaceId: string;
  readonly cwd: string;
}

/** Первый ход не имеет CLI-ID: Codex выдаёт его в thread.started. Resume требует ссылку на тот же адаптер. */
export type CodexRunRequest = AgentRunRequestBase & { profile: CodexAccessProfile } & (
  | { resume: false; thread?: never }
  | { resume: true; thread: CodexThreadRef }
);

/** Только объявление в help конкретной CLI; поведение не доказывается. Claude-флаги не переносятся. */
export interface CodexCapabilities {
  execJson: boolean;
  stdinPrompt: boolean;
  /** Resume объявляет JSONL, stdin, ignore-флаги и собственный --config.
   * Legacy и named-профили передают разные config; исполнение требует отдельного допуска. */
  resume: boolean;
  ephemeral: boolean;
  sandbox: boolean;
  configOverrides: boolean;
  ignoreUserConfig: boolean;
  ignoreRules: boolean;
  /** Объявление --strict-config в своём help; undefined означает, что факта нет.
   * Дополнительных процессов detect не требуется; старые снимки не становятся true. */
  strictConfig?: boolean;
  resumeStrictConfig?: boolean;
  model: boolean;
  /** `login status` дал распознанный вердикт. */
  loginStatus: boolean;
}
export type CodexDetection = AgentDetection<CodexCapabilities>;

export type CodexAdmissionReason =
  | 'assessment_failed' | 'project_untrusted' | 'requirement_unconfirmed' | 'configuration_conflict' | 'cli_unsupported';

/** Ready требует точного набора ограничений выбранного профиля и всех CODEX_LIMITATIONS. */
export type CodexAdmission =
  | { status: 'ready'; detail: string; confirmed: readonly CodexRestriction[]; limitations: readonly CodexLimitation[] }
  | { status: 'blocked' | 'unsupported'; reason: CodexAdmissionReason; detail: string };

/** Source-review имеет указанную область и не выдаётся за наблюдение установленного бинарника. */
export interface CodexRequirementGap {
  readonly requirement: CodexRestriction;
  readonly status: 'unconfirmed' | 'unsupported';
  readonly code: 'shell_gate_scope_unconfirmed' | 'closed_read_mechanism_unconfirmed' | 'closed_read_mechanism_unavailable'
    | 'project_extension_controls_unconfirmed' | 'user_extension_controls_unconfirmed'
    | 'sandbox_effective_policy_unconfirmed' | 'resume_permissions_unconfirmed'
    | 'sandbox_read_scope_unconfirmed' | 'non_shell_write_policy_unconfirmed';
  readonly detail: string;
  readonly sources: readonly string[];
  readonly sourceReview?: {
    readonly revision: string;
    readonly scope: 'builtin_exec';
    readonly binaryCorrespondence: 'unconfirmed';
  };
}

/** Factory проверяет фиксированный профиль и актуальные пути расширений.
 * Внешние facts/evidence и synthetic-флаги не предоставляют production-допуск. */
export type CodexProductionAdmission = CodexAdmission & {
  readonly requirements: readonly CodexRequirementGap[];
};

/** Неизменяемый снимок до запуска; те же argv/env будут использованы для процесса.
 * Оценщик подключает только доверенная композиция или тестовый стенд, никогда IPC/модель. */
export interface CodexAdmissionContext {
  readonly detection: CodexDetection;
  readonly request: CodexRunRequest;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}
export type CodexAdmissionEvaluator = (context: CodexAdmissionContext) => Promise<CodexAdmission>;
