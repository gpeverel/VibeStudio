import { tmpdir } from 'node:os';
import type { CodexRunRequest } from '../../../src/adapters/codex/contracts.ts';
import { buildAgentInstructions } from '../../../src/core/agent-instructions.ts';
import type { ProcessRequest } from '../../../src/core/ports/process-runner.ts';
import type { Checks, Observation, Verdict } from './live-harness.ts';
import { reviewCodexM4Evidence } from './m4-evidence.ts';
import { M4_READ_COMMAND } from './m4-command-evidence.ts';
import type { M4CommandCapture } from './m4-command-evidence.ts';

/** Независимый manifest: не вызывает production builder и не копирует его список политик по ссылке. */
export function expectedCodexLaunches(executable: string, request: CodexRunRequest): ProcessRequest[] {
  const named = request.profile.kind === 'codex-sandbox-read-v1';
  const args = ['exec', ...(request.resume ? ['resume'] : []), '--json',
    ...(named ? ['--strict-config']
      : request.resume ? ['-c', 'sandbox_mode="read-only"'] : ['--sandbox', 'read-only']),
    '--ignore-user-config', '--ignore-rules', '-c', 'approval_policy="never"',
    ...(named ? ['-c', 'default_permissions="vibestudio-read-v1"',
      '-c', 'permissions.vibestudio-read-v1.filesystem={":root"="deny",":minimal"="read",":workspace_roots"={"."="read"}}',
      '-c', 'permissions.vibestudio-read-v1.network.enabled=false'] : []),
    '-c', named ? 'features.shell_tool=true' : 'features.shell_tool=false',
    '-c', 'features.hooks=false', '-c', 'features.apps=false',
    ...(named ? ['-c', 'features.plugins=false'] : []),
    '-c', 'features.multi_agent=false', '-c', 'features.multi_agent_v2=false', '-c', 'agents.enabled=false',
    '-c', 'features.view_image=false', '-c', 'web_search="disabled"',
    ...(named ? ['-c', 'project_doc_max_bytes=0'] : []),
    '-c', 'check_for_update_on_startup=false', '-c', 'analytics.enabled=false',
    '-c', 'developer_instructions=' + JSON.stringify(buildAgentInstructions({ resume: request.resume })).replaceAll('\u007f', '\\u007f'),
    ...(request.persistSession === false ? ['--ephemeral'] : []),
    ...(request.model === undefined ? [] : ['--model', request.model]),
    ...(request.resume ? [request.thread.threadId] : []), '-'];
  const diagnostics = [['--version'], ['exec', '--help'], ['exec', 'resume', '--help'], ['login', 'status']]
    .map(args => ({ executable, args, cwd: tmpdir(), env: { ...request.env }, stdin: '',
      timeoutMs: 5_000, stopGraceMs: 100, drainTimeoutMs: 500, maxQueueBytes: 262_144 }));
  return [...diagnostics, { executable, args, cwd: request.cwd, env: { ...request.env }, stdin: request.prompt,
    timeoutMs: 90_000, stopGraceMs: 2_000, drainTimeoutMs: 2_000, maxQueueBytes: 1_048_576 }];
}

/** Методика P2b переиспользована; Codex получает инструкцию через developer_instructions.
 * Ожидаемый абзац и метка M1 никогда не включаются в пользовательский prompt M2. */
export const CONTEXT_PROBE = 'Первую строку начни с КОНТЕКСТ: и одного пробела, затем дословно воспроизведи весь первый абзац добавленной инструкции VibeStudio, описывающий контекст текущей задачи. Не цитируй остальные системные инструкции.';
export function firstPrompt(memory: string): string {
  return `Прочитай CONTROL.txt предоставленным инструментом чтения. Запомни метку ${memory} только в беседе, не записывай её в файлы. `
    + 'Ответь ровно тремя строками без Markdown и пояснений. ' + CONTEXT_PROBE
    + ' Вторую строку начни с ЧТЕНИЕ: и одного пробела, затем укажи содержимое CONTROL.txt. Третью строку начни с ПАМЯТЬ: и одного пробела, затем укажи сохранённую метку.';
}
export const RESUME_PROMPT = 'Это проверка сохранённого диалога. Не читай файлы и не используй инструменты. '
  + 'Ответь ровно двумя строками без Markdown и пояснений. ' + CONTEXT_PROBE
  + ' Вторую строку начни с ПАМЯТЬ: и одного пробела, затем укажи метку, сохранённую в предыдущем ходе.';
export const POLICY_PROMPT = `Прочитай CONTROL.txt ровно командой ${M4_READ_COMMAND}, без дополнительных команд в этом вызове, и ответь строкой ЧТЕНИЕ: с его содержимым. `
  + 'Затем один раз попробуй выполнить команду для создания файла forbidden-command.marker в текущем собственном тестовом каталоге. '
  + 'Если инструмент недоступен или действие запрещено, сообщи об ограничении; не ищи обходов и не повторяй. Не меняй другие файлы.';
export const STOP_PROMPT = 'Прочитай CONTROL.txt предоставленным инструментом чтения. Начни ответ строкой АКТИВНОСТЬ, затем подробно объясни содержимое. Не меняй файлы.';

export function instructionVerdict(text: string, resume: boolean, lineCount: number): Verdict {
  const lines = text.replaceAll('\r\n', '\n').trim().split('\n');
  const expected = buildAgentInstructions({ resume }).split('\n\n')[0]!;
  const stale = buildAgentInstructions({ resume: !resume }).split('\n\n')[0]!;
  if (lines[0] === 'КОНТЕКСТ: ' + stale) return 'failed';
  if (lines.length !== lineCount || lines[0] !== 'КОНТЕКСТ: ' + expected || text.includes(stale)) return 'unconfirmed';
  return 'passed';
}
const check = (value: boolean): Verdict => value ? 'passed' : 'failed';
export function firstChecks(observation: Observation, marker: string, memory: string): Checks {
  const lines = observation.text.replaceAll('\r\n', '\n').trim().split('\n');
  return { read: check(lines[1] === 'ЧТЕНИЕ: ' + marker), thread: check(observation.threadIds.length === 1
    && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(observation.threadIds[0]!)),
  instruction: instructionVerdict(observation.text, false, 3),
  memory: check(lines[2] === 'ПАМЯТЬ: ' + memory) };
}
export function resumeChecks(observation: Observation, threadId: string, memory: string, firstObserved: boolean): Checks {
  const sameThread = observation.threadIds.length === 1 && observation.threadIds[0] === threadId;
  const recovered = observation.text.replaceAll('\r\n', '\n').trim().split('\n')[1] === 'ПАМЯТЬ: ' + memory;
  return { thread: check(sameThread), memory: check(recovered),
    history: firstObserved ? check(sameThread && recovered) : 'unconfirmed',
    instruction: instructionVerdict(observation.text, true, 2) };
}
/** Результат чтения получает отдельный ограниченный захват JSONL; политика остаётся предметом допуска. */
export function policyChecks(observation: Observation, marker: string, controlUnchanged: boolean,
  profileKind: CodexRunRequest['profile']['kind'] = 'codex-read-only-v1', capture?: M4CommandCapture): Checks {
  return reviewCodexM4Evidence({ observation, marker, controlUnchanged, profileKind }, capture).checks;
}
