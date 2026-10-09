import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fake-claude.mjs');

export type FakeStep =
  | { sleep: number }
  | { out: string; fragment?: number; base64?: boolean }
  | { err: string; fragment?: number }
  | { repeat: { line: string; count: number } }
  | { ignoreSigterm: true }
  | { spawnChild: string }
  | { hang: true }
  | { exit: number };

export interface FakeScenario {
  version?: string;
  help?: string;
  helpExit?: number;
  auth?: { loggedIn: boolean; [key: string]: unknown };
  authExit?: number;
  steps?: FakeStep[];
  exit?: number;
}
export interface FakeRecord {
  probe: 'version' | 'help' | 'auth' | 'run';
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  stdin?: string;
}

/** Временный каталог теста: двойник CLI, записи вызовов, контрольные файлы. */
export class Stand {
  readonly dir = realpathSync(mkdtempSync(join(tmpdir(), 'vs-claude-')));
  readonly recordFile = join(this.dir, 'record.jsonl');
  private counter = 0;

  path(...parts: string[]): string { return join(this.dir, ...parts); }

  /** Исполняемый файл-обёртка; сценарий не зависит от окружения, которое получает процесс. */
  fakeClaude(scenario: FakeScenario): string {
    const id = ++this.counter;
    const scenarioFile = this.path(`scenario-${id}.json`);
    writeFileSync(scenarioFile, JSON.stringify({ ...scenario, record: this.recordFile }));
    const bin = this.path(`claude-${id}`);
    writeFileSync(bin, `#!/bin/sh\nFAKE_CLAUDE_SCENARIO='${scenarioFile}' exec '${process.execPath}' '${FAKE}' "$@"\n`);
    chmodSync(bin, 0o755);
    return bin;
  }

  records(): FakeRecord[] {
    if (!existsSync(this.recordFile)) return [];
    return readFileSync(this.recordFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as FakeRecord);
  }

  /** Файл с известным содержимым; возвращает путь и функцию проверки сохранности. */
  controlFile(name: string, content: string): { path: string; intact(): boolean } {
    const path = this.path(name);
    writeFileSync(path, content);
    return { path, intact: () => existsSync(path) && readFileSync(path, 'utf8') === content };
  }

  cleanup(): void { rmSync(this.dir, { recursive: true, force: true }); }
}

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (condition()) return true;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return condition();
}

/** Рандомизированная, но воспроизводимая (seed) нарезка байтов на чанки. */
export function fragment(data: Uint8Array, seed: number, maxChunk = 7): Uint8Array[] {
  let state = seed >>> 0 || 1;
  const next = (): number => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < data.length;) {
    const size = 1 + (next() % maxChunk);
    chunks.push(data.subarray(i, i + size));
    i += size;
  }
  return chunks;
}
