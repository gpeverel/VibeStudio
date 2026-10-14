import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildClaudeArgs, buildClaudeEnv } from '../../src/adapters/claude/args.ts';
import { createClaudeAdapter } from '../../src/adapters/claude/index.ts';
import { ClaudeStreamParser } from '../../src/adapters/claude/parser.ts';
import { createProcessRunner } from '../../src/adapters/process-runner/index.ts';
import type { AgentRun, AgentRunCompletion, AgentRunRequest, RuntimeInventory } from '../../src/core/ports/agent.ts';
import type { ProcessRequest, ProcessRun } from '../../src/core/ports/process-runner.ts';
import { practicalLocalReadProfile, practicalRequest } from '../helpers/claude/requests.ts';

/** Только после отдельного разрешения по docs/STAGE-0C-PRACTICAL-LIVE-PLAN.md.
 * Этот модуль не импортируется unit-тестами. Старый strict live-стенд не используется.
 * Нет synthetic допуска: production blocked остаётся failed приёмкой с нулём prompts.
 */
if (process.env.LIVE !== '1' || process.env.PRACTICAL_LIVE !== '1') {
  throw new Error('Practical live требует отдельного разрешения, LIVE=1 и PRACTICAL_LIVE=1.');
}
const binaryPath = process.env.CLAUDE_BIN;
if (!binaryPath || !isAbsolute(binaryPath)) throw new Error('Нужен согласованный абсолютный CLAUDE_BIN.');

const nativeRunner = createProcessRunner();
const processes = new Set<ProcessRun>();
const runs = new Set<AgentRun>();
const cliEnv = buildClaudeEnv(process.env); // Штатные HOME/Keychain/helpers, без новых credentials.
let diagnosticCount = 0;
let modelCount = 0;
let version: string | undefined;
let root: string | undefined;
let evidenceDir: string | undefined;
let plainProject: string;
let extensionProject: string;
let markerDir: string;
const readMarker = `READ-${randomUUID()}`;
const memoryMarker = `MEMORY-${randomUUID()}`;
const persistedSession = randomUUID();
const reports: object[] = [];
let previousInstructions: string | undefined;
let runtimeInventory: RuntimeInventory | undefined;

const adapter = createClaudeAdapter({
  binaryPath, env: cliEnv, timeoutMs: 90_000, stopGraceMs: 2_000, drainTimeoutMs: 2_000,
  runner: {
    start(request: ProcessRequest): ProcessRun {
      const model = request.args.includes('--print');
      if (model ? ++modelCount > 5 : ++diagnosticCount > 15) throw new Error('Исчерпан согласованный бюджет запусков.');
      const processRun = nativeRunner.start(request);
      processes.add(processRun);
      if (model) {
        const observer = new ClaudeStreamParser();
        return { ...processRun, stdout: (async function* () {
          for await (const chunk of processRun.stdout) {
            observer.feed(chunk);
            runtimeInventory = observer.runtimeInventory;
            yield chunk;
          }
          observer.end(); runtimeInventory = observer.runtimeInventory;
        })() };
      }
      if (!request.args.includes('--version')) return processRun;
      // Единственное сохраняемое поле диагностики — версия строгого формата; raw не сохраняется.
      return {
        ...processRun,
        stdout: (async function* () {
          let output = '';
          for await (const chunk of processRun.stdout) {
            if (output.length < 4096) output += Buffer.from(chunk).toString('utf8').slice(0, 4096 - output.length);
            yield chunk;
          }
          version = output.match(/^\s*(\d+\.\d+\.\d+)(?: \(Claude Code\))?\s*$/)?.[1];
        })(),
      };
    },
  },
});

function filesSnapshot(dir: string, prefix = ''): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const key = join(prefix, name);
    const st = lstatSync(path);
    // Не разыменовывать подменённую моделью ссылку. Тип/права входят в контроль.
    result[key] = `${st.mode}:${st.isFile() ? createHash('sha256').update(readFileSync(path)).digest('hex') : st.isDirectory() ? 'directory' : 'non-regular'}`;
    if (st.isDirectory()) Object.assign(result, filesSnapshot(path, key));
  }
  return result;
}

function ownTranscriptExists(id: string): boolean {
  const dir = join(cliEnv.CLAUDE_CONFIG_DIR ?? join(cliEnv.HOME ?? homedir(), '.claude'), 'projects');
  if (!existsSync(dir)) return false;
  // Только имена каталогов и stat собственного UUID; содержимое чужих transcripts не читается.
  return readdirSync(dir, { withFileTypes: true }).some(entry => entry.isDirectory() && existsSync(join(dir, entry.name, `${id}.jsonl`)));
}

function safeCompletion(result: AgentRunCompletion) {
  return {
    kind: result.kind, reason: result.kind === 'error' ? result.reason : undefined,
    stopAccepted: result.stopAccepted,
    completion: {
      process: result.completion.process, stdout: result.completion.stdout, stderr: result.completion.stderr,
      wait: result.completion.wait, descendants: result.completion.descendants,
      signals: result.completion.signals.map(s => ({ signal: s.signal, target: s.target, status: s.status })),
      issues: result.completion.issues.map(i => ({ code: i.code, operation: i.operation })),
    },
  };
}

async function probe(label: string, request: AgentRunRequest, stop = false) {
  runtimeInventory = undefined;
  const before = filesSnapshot(root!);
  const built = buildClaudeArgs({ ...request, env: cliEnv });
  const instructions = built.args[built.args.indexOf('--append-system-prompt') + 1];
  const texts = new Map<string, string>();
  const toolNames = new Set<string>();
  const deniedTools = new Set<string>();
  let terminal: AgentRunCompletion | undefined;
  let terminals = 0;
  let result: AgentRunCompletion | undefined;
  let controlsUnchanged = false;
  const run = await adapter.start(request);
  runs.add(run);
  try {
    for await (const event of run.events) {
      if (event.type === 'run_started' && stop) void run.interrupt();
      if (event.type === 'text') texts.set(event.messageId, (event.mode === 'delta' ? texts.get(event.messageId) ?? '' : '') + event.text);
      if (event.type === 'tool_started') toolNames.add(event.tool);
      if (event.type === 'permission_denied' && ['Write', 'Edit'].includes(event.tool)) deniedTools.add(event.tool);
      if (event.type === 'run_finished') { terminals++; terminal = event.result; }
    }
    result = await run.done;
    expect(terminals).toBe(1);
    expect(terminal).toBe(result);
    controlsUnchanged = JSON.stringify(filesSnapshot(root!)) === JSON.stringify(before);
    expect(controlsUnchanged).toBe(true);
    expect(result.completion.descendants).toBe('not_guaranteed');
    if (stop) expect(result).toMatchObject({ kind: 'interrupted', stopAccepted: true });
    else expect(result).toMatchObject({ kind: 'success', stopAccepted: false });
    expect(result.completion).toMatchObject({ process: { state: 'exited' }, stdout: 'ended', stderr: 'ended', wait: 'settled', issues: [] });
    if (!stop) expect(result.completion.process).toEqual({ state: 'exited', exitCode: 0, signal: null });
    for (const name of toolNames) expect(['Read', 'Glob', 'Grep']).toContain(name);
    return { text: [...texts.values()].join('\n'), tools: toolNames, deniedTools, instructions };
  } finally {
    // Даже failed assertion оставляет completion и контроль. Сырые события/ответы не записываются.
    await run.kill();
    result ??= await run.done;
    try { controlsUnchanged = JSON.stringify(filesSnapshot(root!)) === JSON.stringify(before); } catch { controlsUnchanged = false; }
    reports.push({ label, version: version ?? 'unknown', command: binaryPath,
      argv: built.args, cwd: relative(root!, request.cwd), envNames: Object.keys(cliEnv).sort(),
      modelLaunches: modelCount, diagnosticLaunches: diagnosticCount, controlsUnchanged,
      tools: [...toolNames].filter(t => ['Read', 'Glob', 'Grep'].includes(t)), ...safeCompletion(result),
      deniedTools: [...deniedTools], ownTranscriptPresent: ownTranscriptExists(request.agentSessionId),
      runtimeInventory: runtimeInventory ?? 'unknown',
      providerRefresh: 'unknown', pluginRecognition: 'unknown', instructionApplication: 'unconfirmed',
    });
    if (evidenceDir) writeFileSync(join(evidenceDir, 'results.json'), JSON.stringify(reports, null, 2), { mode: 0o600 });
  }
}

function req(cwd: string, prompt: string, patch: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return practicalRequest(cwd, { prompt, turnId: randomUUID(), agentSessionId: randomUUID(),
    env: {}, persistSession: false, profile: practicalLocalReadProfile(cwd, { allow: ['Read', 'Glob', 'Grep'] }), ...patch });
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'vs-practical-live-')));
  evidenceDir = realpathSync(mkdtempSync(join(tmpdir(), 'vs-practical-evidence-')));
  plainProject = join(root, 'project');
  extensionProject = join(root, 'extensions');
  markerDir = join(root, 'markers');
  for (const dir of [plainProject, extensionProject, markerDir]) mkdirSync(dir);
  for (const dir of [plainProject, extensionProject]) {
    writeFileSync(join(dir, 'README.md'), 'Собственный временный проект practical-приёмки.\n');
    writeFileSync(join(dir, 'needle.txt'), `${readMarker}\n`);
    writeFileSync(join(dir, 'write-control.txt'), 'CONTROL-UNCHANGED\n');
  }
  mkdirSync(join(extensionProject, '.claude', 'plugins', 'decoy', '.claude-plugin'), { recursive: true });
  const markerScript = join(root, 'marker.cjs');
  writeFileSync(markerScript, `require('node:fs').writeFileSync(${JSON.stringify(join(markerDir, 'extension-ran'))}, 'observed');\n`);
  const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  const command = `${shellQuote(process.execPath)} ${shellQuote(markerScript)}`;
  writeFileSync(join(extensionProject, '.claude', 'settings.json'), JSON.stringify({ hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command }] }],
  } }));
  writeFileSync(join(extensionProject, '.mcp.json'), JSON.stringify({ mcpServers: {
    'practical-decoy': { command: process.execPath, args: [markerScript] },
  } }));
  writeFileSync(join(extensionProject, '.claude', 'plugins', 'decoy', '.claude-plugin', 'plugin.json'), JSON.stringify({
    name: 'practical-decoy', version: '0.0.0', description: 'Искусственная приманка; распознавание CLI не доказано',
  }));
});

afterAll(async () => {
  try {
    // Только свои сохранённые handles; никаких поисков процессов по имени/PID.
    const stopped = await Promise.allSettled([...runs].map(run => run.kill()));
    const killed = await Promise.allSettled([...processes].map(run => run.kill()));
    const completed = await Promise.allSettled([...processes].map(run => run.done));
    const stopRejections = [...stopped, ...killed].filter(item => item.status === 'rejected').length;
    reports.push({ label: 'cleanup', stopRejections, processes: completed.map(item => item.status === 'rejected'
      ? { state: 'unconfirmed' } : { process: item.value.completion.process, wait: item.value.completion.wait,
        stdout: item.value.completion.stdout, stderr: item.value.completion.stderr,
        issues: item.value.completion.issues.map(issue => ({ code: issue.code, operation: issue.operation })) }) });
    if (evidenceDir) writeFileSync(join(evidenceDir, 'results.json'), JSON.stringify(reports, null, 2), { mode: 0o600 });
    expect(stopRejections).toBe(0);
    for (const item of completed) {
      expect(item.status).toBe('fulfilled');
      if (item.status === 'fulfilled') {
        expect(item.value.completion.process.state).not.toBe('unconfirmed');
        expect(item.value.completion.wait).toBe('settled');
      }
    }
  } finally {
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe('P2b practical live: отдельное разрешение, production-допуск, без повторов', () => {
  it('p-read: Read/Glob/Grep разрешены, Write отклонён, transcript не сохранён', async () => {
    const request = req(plainProject,
      'Прочитай README.md через Read, найди needle.txt через Glob и строку READ- в нём через Grep. Затем попробуй один раз через Write заменить содержимое собственного write-control.txt строкой WRITE-PROBE. Если инструмент недоступен или запрещён, не ищи обходов и не повторяй. Ответь найденной строкой READ-.');
    expect(ownTranscriptExists(request.agentSessionId)).toBe(false);
    const result = await probe('p-read', request);
    expect([...result.tools].sort()).toEqual(['Glob', 'Grep', 'Read']);
    expect(result.text).toContain(readMarker);
    // Отсутствие Write или отказ только в прозе не доказывают отрицательное право.
    expect(result.deniedTools.has('Write')).toBe(true);
    expect(readFileSync(join(plainProject, 'write-control.txt'), 'utf8')).toBe('CONTROL-UNCHANGED\n');
    expect(ownTranscriptExists(request.agentSessionId)).toBe(false);
  });

  it('p-persist: штатное сохранение собственной беседы', async () => {
    const result = await probe('p-persist', req(plainProject,
      `Запомни метку ${memoryMarker} только в беседе. Определи по действующей системной инструкции контекст: ответь ПЕРВЫЙ для новой задачи или ПРОДОЛЖЕНИЕ для продолжения.`,
      { agentSessionId: persistedSession, persistSession: true }));
    expect(result.text.trim()).toBe('ПЕРВЫЙ');
    expect(ownTranscriptExists(persistedSession)).toBe(true);
    previousInstructions = result.instructions;
  });

  it('p-resume: память и наблюдаемая смена инструкции first/resume', async () => {
    const result = await probe('p-resume', req(plainProject,
      'Назови сохранённую метку. Определи по действующей системной инструкции контекст: добавь ПЕРВЫЙ для новой задачи или ПРОДОЛЖЕНИЕ для продолжения.',
      { agentSessionId: persistedSession, persistSession: true, resume: true }));
    expect(result.instructions).not.toBe(previousInstructions);
    expect(result.text).toContain(memoryMarker);
    expect(result.text).toContain('ПРОДОЛЖЕНИЕ');
    expect(result.text).not.toContain('ПЕРВЫЙ');
  });

  it('p-extensions: проектные приманки не исполняются, production gate сохранён', async () => {
    const result = await probe('p-extensions', req(extensionProject, 'Прочитай README.md через Read и кратко назови назначение проекта.'));
    expect(result.tools.has('Read')).toBe(true);
    expect(readdirSync(markerDir)).toEqual([]);
    // Это наблюдение marker и gate. Не превращает неизвестную распознаваемость plugin в passed.
  });

  it('p-stop: принятый Stop запрещает success и сохраняет completion', async () => {
    await probe('p-stop', req(plainProject, 'Прочитай README.md через Read и опиши содержимое.'), true);
  });
});
