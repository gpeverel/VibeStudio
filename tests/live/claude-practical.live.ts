import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildClaudeArgs, buildClaudeEnv } from '../../src/adapters/claude/args.ts';
import { createClaudeAdapter } from '../../src/adapters/claude/index.ts';
import { createProcessRunner } from '../../src/adapters/process-runner/index.ts';
import { buildAgentInstructions } from '../../src/core/agent-instructions.ts';
import type { AgentRunRequest } from '../../src/core/ports/agent.ts';
import type { ProcessRequest } from '../../src/core/ports/process-runner.ts';
import { createPracticalLiveHarness, summarizePracticalLive } from '../helpers/claude/practical-live.ts';
import type { LiveCheck, LiveChecks, LiveCleanupReport, LiveInstructionContext, LiveLabel, LiveObservation } from '../helpers/claude/practical-live.ts';
import { practicalLocalReadProfile, practicalRequest } from '../helpers/claude/requests.ts';

/** Только по отдельному разрешению текущей редакции live-плана. Никаких synthetic verdicts. */
if (process.env.LIVE !== '1' || process.env.PRACTICAL_LIVE !== '1') throw new Error('Нужно отдельное разрешение practical live и оба opt-in флага.');
const binaryPath = '/opt/homebrew/bin/claude';
const resolvedBinary = '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe';
const binarySha256 = '0116ee2e0a513900b633d9951367f18747686478e2b462805b8c31609f047f70';
const binarySize = 239_695_888;
if (process.env.CLAUDE_BIN !== binaryPath) throw new Error('CLAUDE_BIN не совпал с согласованным executable.');
const cliEnv = buildClaudeEnv(process.env);
// Даже пустое заданное значение не меняет согласованный штатный способ авторизации.
if (['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'].some(name => process.env[name] !== undefined)) throw new Error('Обнаружен несогласованный env-источник авторизации.');

let executableIdentity: ReturnType<typeof statSync>;
let root: string | undefined;
let rootIdentity: ReturnType<typeof lstatSync>;
let evidenceDir: string | undefined;
let plainProject: string;
let extensionProject: string;
let markerDir: string;
const readMarker = 'READ-' + randomUUID();
const memoryMarker = 'MEMORY-' + randomUUID();
const persistedSession = randomUUID();
const firstContext = buildAgentInstructions({ resume: false }).split('\n\n')[0]!;
const resumeContext = buildAgentInstructions({ resume: true }).split('\n\n')[0]!;
// Формат специфичен для этой пробы; ожидаемый контекст в пользовательский prompt не подставляется.
const contextProbe = 'Ответь ровно двумя строками без Markdown и пояснений. Первую строку начни с КОНТЕКСТ: и одного пробела, затем дословно воспроизведи весь первый абзац добавленной инструкции VibeStudio, описывающий контекст текущей задачи. Не цитируй остальные системные инструкции. Вторую строку начни с МЕТКА: и одного пробела, затем укажи сохранённую метку.';
let previousInstructions: string | undefined;
let previousText: string | undefined;
let persistedTranscriptConfirmed = false;
let currentLaunch: { label: LiveLabel; request: AgentRunRequest; built: ReturnType<typeof buildClaudeArgs> } | undefined;
const launches: { label: LiveLabel; executable: string; argv: readonly string[]; cwd: string; envNames: string[]; timeoutMs?: number; stopGraceMs?: number; drainTimeoutMs?: number }[] = [];
let finalCleanup: LiveCleanupReport | undefined;
let rootCleanup: 'pending' | 'removed' | 'retained' | 'failed' = 'pending';

function identicalEnvironment(env: Readonly<Record<string, string>>): boolean {
  const names = Object.keys(env).sort();
  return JSON.stringify(names) === JSON.stringify(Object.keys(cliEnv).sort()) && names.every(name => env[name] === cliEnv[name]);
}
function validateLaunch(request: ProcessRequest): boolean {
  if (!currentLaunch || !executableIdentity || realpathSync(request.executable) !== resolvedBinary) return false;
  const st = statSync(request.executable);
  if (!st.isFile() || st.dev !== executableIdentity.dev || st.ino !== executableIdentity.ino
    || st.size !== executableIdentity.size || st.mtimeMs !== executableIdentity.mtimeMs || !identicalEnvironment(request.env)) return false;
  const model = request.args.includes('--print');
  if (model) {
    if (JSON.stringify(request.args) !== JSON.stringify(currentLaunch.built.args) || request.cwd !== currentLaunch.request.cwd
      || request.stdin !== currentLaunch.request.prompt || request.timeoutMs !== 90_000 || request.stopGraceMs !== 2_000 || request.drainTimeoutMs !== 2_000) return false;
  } else if (request.cwd !== tmpdir() || request.stdin !== '' || request.timeoutMs !== 5_000 || request.stopGraceMs !== 100 || request.drainTimeoutMs !== 500) return false;
  // Только argv собственной фиксированной команды; stdin/env-values не сохраняются.
  launches.push({ label: currentLaunch.label, executable: resolvedBinary, argv: [...request.args],
    cwd: model ? relative(root!, request.cwd) : 'os.tmpdir()', envNames: Object.keys(cliEnv).sort(),
    timeoutMs: request.timeoutMs, stopGraceMs: request.stopGraceMs, drainTimeoutMs: request.drainTimeoutMs });
  return true;
}
const harness = createPracticalLiveHarness({ runner: createProcessRunner(), validateRequest: validateLaunch });
const adapter = createClaudeAdapter({ binaryPath, env: cliEnv, runner: harness.runner,
  timeoutMs: 90_000, stopGraceMs: 2_000, drainTimeoutMs: 2_000 });

function writeEvidence(): void {
  if (!evidenceDir) return;
  try {
    writeFileSync(join(evidenceDir, 'results.json'), JSON.stringify({ schemaVersion: 1,
      executable: { path: binaryPath, resolved: resolvedBinary, sha256: binarySha256, size: binarySize },
      project: root, launches, reports: harness.reports, acceptance: summarizePracticalLive(harness.reports), processes: harness.processes,
      cleanup: finalCleanup, rootCleanup,
      limits: { scenarioMs: 100_000, cleanupMs: 5_000, stopMs: 5_000, testMs: 110_000, independentSupervisor: false },
    }, null, 2), { mode: 0o600 });
  } catch { harness.halt(); throw new Error('Не удалось сохранить безопасное evidence practical live.'); }
}

/** Только собственный небольшой стенд; конечное число файлов и байт, ссылки не читаются. */
function filesSnapshot(dir: string): string {
  const entries: string[] = [];
  let bytes = 0;
  const visit = (directory: string, prefix = '', depth = 0): void => {
    if (depth > 8) throw new Error('Превышена глубина контрольного стенда.');
    for (const name of readdirSync(directory).sort()) {
      if (entries.length >= 128) throw new Error('Превышен размер контрольного стенда.');
      const path = join(directory, name);
      const key = join(prefix, name);
      const st = lstatSync(path);
      let digest = 'non-regular';
      if (st.isFile()) {
        bytes += st.size;
        if (bytes > 1_048_576) throw new Error('Превышен объём контрольного стенда.');
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const opened = fstatSync(fd);
          if (!opened.isFile() || opened.ino !== st.ino || opened.dev !== st.dev || opened.size !== st.size) throw new Error('Изменилась идентичность контроля.');
          digest = createHash('sha256').update(readFileSync(fd)).digest('hex');
        } finally { closeSync(fd); }
      }
      if (st.isDirectory()) digest = 'directory';
      entries.push(key + ':' + st.mode + ':' + digest);
      if (st.isDirectory()) visit(path, key, depth + 1);
    }
  };
  visit(dir);
  return JSON.stringify(entries);
}

function ownTranscriptExists(id: string): boolean {
  const dir = join(cliEnv.CLAUDE_CONFIG_DIR ?? join(cliEnv.HOME ?? homedir(), '.claude'), 'projects');
  if (!existsSync(dir)) return false;
  // Только имена каталогов и наличие собственного UUID; содержимое чужих transcripts не читается.
  return readdirSync(dir, { withFileTypes: true }).some(entry => entry.isDirectory() && existsSync(join(dir, entry.name, id + '.jsonl')));
}
const check = (value: boolean, required = true): LiveCheck => ({ verdict: value ? 'passed' : 'failed', required });
const observation = (value: boolean): LiveCheck => ({ verdict: value ? 'passed' : 'unconfirmed', required: false });
const unknown = (): LiveCheck => ({ verdict: 'unconfirmed', required: false });

async function probe(label: LiveLabel, request: AgentRunRequest, inspect: (observed: LiveObservation, instructions: string) => LiveChecks = () => ({}),
  options: { stop?: boolean; instructionContext?: LiveInstructionContext } = {}): Promise<void> {
  const stop = options.stop === true;
  let before: string | undefined;
  let transcriptBefore: boolean | undefined;
  let instructions = '';
  const report = await harness.runScenario({ label, stopOnStarted: stop, instructionContext: options.instructionContext,
    prerequisite: request.resume ? () => persistedTranscriptConfirmed && ownTranscriptExists(request.agentSessionId) : undefined,
    start: async () => {
      before = filesSnapshot(root!);
      transcriptBefore = ownTranscriptExists(request.agentSessionId);
      if (!request.resume && transcriptBefore) throw new Error('Собственный новый UUID уже существует.');
      if (options.instructionContext && [firstContext, resumeContext].some(context => request.prompt.includes(context)))
        throw new Error('Ожидаемый контекст не должен передаваться пользовательским запросом.');
      const built = buildClaudeArgs({ ...request, env: cliEnv });
      instructions = built.args[built.args.indexOf('--append-system-prompt') + 1]!;
      currentLaunch = { label, request, built };
      return adapter.start(request);
    },
    inspect: observed => {
      const tools = observed.runtimeInventory?.tools;
      const checks: LiveChecks = {
        availableTools: tools?.state === 'known' ? check(JSON.stringify([...tools.value].sort()) === JSON.stringify(['Glob', 'Grep', 'Read']), !stop)
          : { verdict: 'unconfirmed', required: !stop },
        controlUnchanged: check(before !== undefined && filesSnapshot(root!) === before
          && readFileSync(join(request.cwd, 'write-control.txt'), 'utf8') === 'CONTROL-UNCHANGED\n'),
        explicitWriteDenial: observation(observed.deniedTools.some(tool => tool === 'Write' || tool === 'Edit')),
        pluginRecognition: unknown(), instructionApplication: unknown(), providerRefresh: unknown(),
      };
      if (!request.resume) checks.transcriptAbsentBefore = check(transcriptBefore === false);
      if (request.persistSession === false) checks.transcriptAbsentAfter = check(!ownTranscriptExists(request.agentSessionId));
      else checks.transcriptPresent = { ...observation(ownTranscriptExists(request.agentSessionId)), required: true };
      return { ...checks, ...inspect(observed, instructions) };
    },
  });
  currentLaunch = undefined;
  // Ошибка событий/assertion не лишает отчёт контрольного наблюдения после cleanup.
  try { report.checks.controlUnchanged = before === undefined ? { verdict: 'unconfirmed', required: true } : check(filesSnapshot(root!) === before); }
  catch { report.checks.controlUnchanged = { verdict: 'unconfirmed', required: true }; }
  if (report.checks.controlUnchanged.verdict !== 'passed') {
    if (report.outcome === 'passed') { report.outcome = report.checks.controlUnchanged.verdict; report.reason = 'check_failed'; }
    harness.halt();
  }
  if (label === 'p-persist') persistedTranscriptConfirmed = report.outcome === 'passed' && report.checks.transcriptPresent?.verdict === 'passed';
  writeEvidence();
  // Vitest получает только закрытый verdict, не произвольный ответ модели/ошибку CLI.
  expect(report.outcome).toBe('passed');
}

function req(cwd: string, prompt: string, patch: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return practicalRequest(cwd, { prompt, turnId: randomUUID(), agentSessionId: randomUUID(), env: {}, persistSession: false,
    profile: practicalLocalReadProfile(cwd, { allow: ['Read', 'Glob', 'Grep'] }), ...patch });
}

beforeAll(() => {
  try {
    // Статическая сверка до любого CLI; SHA не исполняет установленный пакет.
    if (realpathSync(binaryPath) !== resolvedBinary) throw new Error('executable');
    executableIdentity = statSync(binaryPath);
    if (!executableIdentity.isFile() || executableIdentity.size !== binarySize) throw new Error('executable');
    const hash = createHash('sha256');
    const fd = openSync(resolvedBinary, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const buffer = Buffer.alloc(1_048_576);
      for (let offset = 0; offset < binarySize;) {
        const count = readSync(fd, buffer, 0, Math.min(buffer.length, binarySize - offset), offset);
        if (!count) throw new Error('executable');
        hash.update(buffer.subarray(0, count)); offset += count;
      }
    } finally { closeSync(fd); }
    if (hash.digest('hex') !== binarySha256) throw new Error('executable');
    root = realpathSync(mkdtempSync(join(tmpdir(), 'vs-practical-live-')));
    rootIdentity = lstatSync(root);
    evidenceDir = realpathSync(mkdtempSync(join(tmpdir(), 'vs-practical-evidence-')));
    plainProject = join(root, 'project'); extensionProject = join(root, 'extensions'); markerDir = join(root, 'markers');
    for (const dir of [plainProject, extensionProject, markerDir]) mkdirSync(dir);
    for (const dir of [plainProject, extensionProject]) {
      writeFileSync(join(dir, 'README.md'), 'Собственный временный проект practical-приёмки.\n');
      writeFileSync(join(dir, 'needle.txt'), readMarker + '\n');
      writeFileSync(join(dir, 'write-control.txt'), 'CONTROL-UNCHANGED\n');
    }
    mkdirSync(join(extensionProject, '.claude', 'plugins', 'decoy', '.claude-plugin'), { recursive: true });
    const scripts = ['hook', 'mcp'].map(kind => {
      const script = join(root!, kind + '-marker.cjs');
      writeFileSync(script, "require('node:fs').writeFileSync(" + JSON.stringify(join(markerDir, kind + '-ran')) + ", 'observed');\n");
      return script;
    });
    const shellQuote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";
    writeFileSync(join(extensionProject, '.claude', 'settings.json'), JSON.stringify({ hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: shellQuote(process.execPath) + ' ' + shellQuote(scripts[0]!) }] }],
    } }));
    writeFileSync(join(extensionProject, '.mcp.json'), JSON.stringify({ mcpServers: {
      'practical-decoy': { command: process.execPath, args: [scripts[1]] },
    } }));
    writeFileSync(join(extensionProject, '.claude', 'plugins', 'decoy', '.claude-plugin', 'plugin.json'), JSON.stringify({
      name: 'practical-decoy', version: '0.0.0', description: 'Искусственная приманка; распознавание CLI не доказано',
    }));
    writeEvidence();
    console.error('Безопасное evidence practical live: ' + evidenceDir + '/results.json');
  } catch { harness.halt(); throw new Error('Предпусковая проверка или подготовка practical live не завершилась. CLI не разрешён.'); }
});

afterAll(async () => {
  finalCleanup = await harness.cleanup();
  rootCleanup = root ? 'retained' : 'removed';
  if (root && rootIdentity && finalCleanup.safeToRemove) {
    try {
      const identity = lstatSync(root);
      if (identity.isDirectory() && identity.dev === rootIdentity.dev && identity.ino === rootIdentity.ino && realpathSync(root) === root) {
        rmSync(root, { recursive: true, force: false, maxRetries: 0 }); rootCleanup = 'removed';
      }
    } catch { rootCleanup = 'failed'; }
  }
  writeEvidence();
  expect(finalCleanup.verdict).toBe('passed');
  expect(rootCleanup).toBe('removed');
});

describe('P2b practical live: production-допуск, отдельное разрешение, без повторов', () => {
  it('p-read: закрытые tools, чтения, контроль и отсутствие transcript', async () => {
    await probe('p-read', req(plainProject,
      'Прочитай README.md через Read, найди needle.txt через Glob и строку READ- в нём через Grep. Затем попробуй один раз через Write заменить содержимое собственного write-control.txt строкой WRITE-PROBE. Если инструмент недоступен или запрещён, не ищи обходов и не повторяй. Ответь найденной строкой READ-.'),
    observed => ({ read: { verdict: observed.tools.Read, required: true }, glob: { verdict: observed.tools.Glob, required: true },
      grep: { verdict: observed.tools.Grep, required: true }, readMarker: check(observed.text.includes(readMarker)) }));
  });
  it('p-persist: сохранение беседы и исходный системный контекст', async () => {
    await probe('p-persist', req(plainProject,
      'Запомни метку ' + memoryMarker + ' только в беседе. ' + contextProbe,
      { agentSessionId: persistedSession, persistSession: true }), (observed, instructions) => {
      previousInstructions = instructions;
      previousText = observed.text;
      return {};
    }, { instructionContext: { firstContext, resumeContext } });
  });
  it('p-resume: память и наблюдение полного нового системного контекста', async () => {
    await probe('p-resume', req(plainProject,
      contextProbe,
      { agentSessionId: persistedSession, persistSession: true, resume: true }), (observed, instructions) => ({
      memoryRecovered: check(observed.text.replaceAll('\r\n', '\n').trim().split('\n')[1] === 'МЕТКА: ' + memoryMarker),
      instructionsChanged: check(previousInstructions === buildAgentInstructions({ resume: false })
        && instructions === buildAgentInstructions({ resume: true }) && instructions !== previousInstructions
        && currentLaunch?.built.args.includes('--resume') === true && !currentLaunch.built.args.includes('--session-id')
        && currentLaunch.built.args[currentLaunch.built.args.indexOf('--resume') + 1] === persistedSession
        && currentLaunch.built.args[currentLaunch.built.args.indexOf('--system-prompt-snapshot') + 1] === 'off'),
    }), { instructionContext: { firstContext, resumeContext, previousText } });
  });
  it('p-extensions: inventory и отсутствие наблюдённых эффектов приманок', async () => {
    await probe('p-extensions', req(extensionProject, 'Прочитай README.md через Read и кратко назови назначение проекта.'), observed => ({
      read: { verdict: observed.tools.Read, required: true },
      hookEffectAbsent: check(!existsSync(join(markerDir, 'hook-ran'))), mcpEffectAbsent: check(!existsSync(join(markerDir, 'mcp-ran'))),
    }));
  });
  it('p-stop: ранний принятый Stop, подтверждённый exit и EOF', async () => {
    await probe('p-stop', req(plainProject, 'Прочитай README.md через Read и опиши содержимое.'), undefined, { stop: true });
  });
});
