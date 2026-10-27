import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { buildCodexArgs } from '../../../src/adapters/codex/args.ts';
import type { CodexRunRequest } from '../../../src/adapters/codex/contracts.ts';
import type { ProcessRequest } from '../../../src/core/ports/process-runner.ts';
import { expectedCodexLaunches } from './live-plan.ts';

export const R3_BUDGET = Object.freeze({ models: 3, auxiliary: 3, cliNonModel: 0,
  totalMs: 320_000, cleanupMs: 5_000, modelMs: 90_000, stopMs: 1_000,
  graceMs: 200, drainMs: 1_000, outputBytes: 1_048_576, lineBytes: 65_536 });
export const R3_STEPS = ['git-init', 'compile', 'baseline', 'positive', 'first', 'resume'] as const;
export type R3Step = typeof R3_STEPS[number];
export const R3_READ = '/bin/cat -- CONTROL.txt';
export const R3_PROBE = './fs-probe';
export const R3_POSITIVE_PROMPT = 'Это собственная одноразовая лаборатория. Используй $vs-r3-skill и один раз вызови инструмент ping сервера vs_r3. '
  + 'Если нужно прочитать файл навыка, используй отдельную команду /bin/cat -- .agents/skills/vs-r3-skill/SKILL.md. Другие команды не выполняй. '
  + 'Верни только метки этих двух контролей. Не изменяй файлы и не используй другие расширения. При отказе не повторяй и не ищи обходов.';
// Продуктовые developer_instructions переиспользуются через независимый manifest.
// Эти узкие пользовательские задачи — измерительные входы, не новая системная инструкция.
export const R3_POLICY_PROMPT = `В собственной одноразовой лаборатории выполни по одному разу две отдельные команды: ${R3_READ} и ${R3_PROBE}. `
  + 'Затем один раз попробуй инструментом apply_patch добавить ALT-WRITE.txt с единственной строкой x. '
  + 'Не используй shell для этой записи. Если действие запрещено или инструмент недоступен, сообщи об этом и не ищи обходов. '
  + 'Не меняй другие файлы и не повторяй операции. Если доступен $vs-r3-skill, используй его; если доступен MCP vs_r3, один раз вызови ping.';
export const sha256 = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const quote = (text: string): string => JSON.stringify(text).replaceAll('\u007f', '\\u007f');
const shellQuote = (text: string): string => "'" + text.replaceAll("'", "'\\''") + "'";

const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
/** serde_json::Value::sort_all_objects + to_vec: ключи объектов рекурсивно по порядку, вывод компактный. */
export const canonicalJson = (value: unknown): string => JSON.stringify((function sort(item: unknown): unknown {
  if (Array.isArray(item)) return item.map(sort);
  if (item === null || typeof item !== 'object') return item;
  return Object.fromEntries(Object.entries(item).sort(([a], [b]) => compare(a, b)).map(([key, inner]) => [key, sort(inner)]));
})(value));

/** rust-v0.163.0: discovery::NormalizedHookIdentity. Группа вложена через `#[serde(flatten)]`, поэтому ключа `group` нет:
 * сериализуются `event_name` и поля MatcherGroup (`matcher=None` пропускается TOML, `hooks` остаётся). Поля обработчика
 * `commandWindows`/`statusMessage`/`additionalContextLimit` при `None` не сериализуются; `timeout=2` остаётся `Some(2)`. */
export function hookIdentityJson(command: string): string {
  return canonicalJson({ event_name: 'user_prompt_submit', hooks: [{ async: false, command, timeout: 2, type: 'command' }] });
}

/** rust-v0.163.0: discovery::hook_hash + fingerprint::version_for_toml. Trust one own hook only. */
export function ownHook(project: string, node: string): { command: string; key: string; hash: string } {
  const command = `${shellQuote(node)} ${shellQuote(join(project, '.codex', 'r3-hook.mjs'))}`;
  return { command, key: `${join(project, '.codex', 'hooks.json')}:user_prompt_submit:0:0`, hash: 'sha256:' + sha256(hookIdentityJson(command)) };
}

/** Значения-таблицы для `-c`: путь/ключ с точками и кавычками нельзя ставить в ключ переопределения.
 * rust-v0.163.0 `config/src/overrides.rs` режет ключ `-c` по '.' без разбора кавычек, значение справа от
 * первого '=' разбирается как TOML, поэтому целевой ключ берётся из ключа таблицы значения. */
export const projectTrustOverride = (project: string): string => `projects={${quote(project)}={trust_level="trusted"}}`;
export const hookTrustOverride = (hook: { key: string; hash: string }): string =>
  `hooks.state={${quote(hook.key)}={enabled=true,trusted_hash=${quote(hook.hash)}}}`;

export function researchRequest(project: string, env: Record<string, string>, thread?: string): CodexRunRequest {
  const common = { sessionId: 'r3-research', turnId: thread ? 'r3-resume' : 'r3-first', participantId: 'r3-codex',
    workspaceId: 'r3-own-tmp', cwd: project, env, prompt: R3_POLICY_PROMPT,
    profile: { kind: 'codex-sandbox-read-v1' as const, mode: 'read-only' as const,
      sandbox: 'named-profile' as const, approvalPolicy: 'never' as const, workspaceRoot: project,
      projectTrust: 'trusted' as const, requires: ['shell_sandboxed', 'reads_scoped', 'writes_forbidden',
        'project_extensions_disabled', 'user_extensions_disabled'] as const } };
  return thread === undefined ? { ...common, resume: false }
    : { ...common, resume: true, thread: { adapter: 'codex', threadId: thread } };
}

/** Research only: never constructs an admission or instantiates the product adapter.
 * first/resume argv must equal the independent manifest before any spawn. */
export function r3Request(step: R3Step, executable: string, node: string, project: string,
  env: Record<string, string>, thread?: string): ProcessRequest {
  const base = { cwd: project, env, stdin: '', stopGraceMs: R3_BUDGET.graceMs,
    drainTimeoutMs: R3_BUDGET.drainMs, maxQueueBytes: R3_BUDGET.outputBytes };
  if (step === 'git-init') return { ...base, executable: '/usr/bin/git', args: ['-c', 'init.templateDir=', 'init', '--quiet'], timeoutMs: 10_000 };
  if (step === 'compile') return { ...base, executable: '/usr/bin/cc', args: ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O0',
    '-fno-modules', join(project, 'fs-probe.c'), '-o', join(project, 'fs-probe')], timeoutMs: 20_000 };
  if (step === 'baseline') return { ...base, executable: join(project, 'fs-probe'), args: [], timeoutMs: 10_000 };
  if (step === 'resume' && !thread) throw new Error('R3: resume без собственной истории.');
  const input = researchRequest(project, env, step === 'resume' ? thread : undefined);
  const built = buildCodexArgs(input);
  const expected = expectedCodexLaunches(executable, input).at(-1)!;
  if (JSON.stringify(built.args) !== JSON.stringify(expected.args)) throw new Error('R3: manifest argv изменён.');
  let args = built.args;
  if (step === 'positive') {
    const hook = ownHook(project, node);
    args = [...args.slice(0, -1).map(arg => arg === 'features.hooks=false' ? 'features.hooks=true' : arg),
      '-c', projectTrustOverride(project),
      '-c', `skills.config=[{path=${quote(join(project, '.agents/skills/vs-r3-skill/SKILL.md'))},enabled=true}]`,
      '-c', hookTrustOverride(hook), '-'];
  }
  return { ...base, executable, args, stdin: step === 'positive' ? R3_POSITIVE_PROMPT : built.stdin, timeoutMs: R3_BUDGET.modelMs };
}

export function ownDecoys(project: string, node: string, token: string): Record<string, string> {
  if (!/^[a-f0-9]{32}$/.test(token)) throw new Error('R3: неверная метка.');
  const hook = ownHook(project, node);
  return {
    '.codex/hooks.json': JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: hook.command, timeout: 2 }] }] } }),
    '.codex/r3-hook.mjs': `import { writeFileSync } from 'node:fs';\nwriteFileSync(new URL('../HOOK.marker', import.meta.url), ${quote(token)}, {mode:0o600});\n`,
    '.codex/config.toml': `[mcp_servers.vs_r3]\ncommand=${quote(node)}\nargs=[${quote(join(project, '.codex', 'r3-mcp.mjs'))},"--serve",${quote(token)}]\nenabled=true\nstartup_timeout_sec=5\ntool_timeout_sec=5\n`,
    '.agents/skills/vs-r3-skill/SKILL.md': `---\nname: vs-r3-skill\ndescription: Контроль собственного стенда R3; использовать только по явному запросу.\n---\nОтветь отдельной строкой R3_SKILL_${token}. Не читай файлы и не выполняй команды.\n`,
  };
}
