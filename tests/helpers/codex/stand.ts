import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Probe = 'version' | 'help' | 'execHelp' | 'resumeHelp' | 'loginHelp' | 'auth' | 'run';
export interface ProbeResponse { stdout?: string; stderr?: string; exit?: number }
export type FakeStep = { out: string; fragment?: number } | { err: string } | { sleep: number }
  | { ignoreSigterm: true } | { hang: true } | { exit: number };
export interface FakeScenario {
  probes?: Partial<Record<Exclude<Probe, 'run'>, ProbeResponse>>;
  steps?: FakeStep[];
  exit?: number;
}
export interface FakeRecord { probe: Probe; argv: string[]; cwd: string; env: Record<string, string>; stdin?: string }
const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fake-codex.mjs');
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";

/** Только синтетическая CLI. Сценарий передаётся аргументом обёртки, а не production env. */
export class CodexStand {
  readonly dir = realpathSync(mkdtempSync(join(tmpdir(), 'vs-codex-synthetic-')));
  readonly recordFile = this.path('records.jsonl');
  private counter = 0;
  path(...parts: string[]): string { return join(this.dir, ...parts); }
  fake(scenario: FakeScenario = {}): string {
    const id = ++this.counter;
    const config = this.path(`scenario-${id}.json`);
    writeFileSync(config, JSON.stringify({ ...scenario, recordFile: this.recordFile }));
    const binary = this.path(`codex-${id}`);
    writeFileSync(binary, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(FAKE)} ${quote(config)} "$@"\n`);
    chmodSync(binary, 0o755);
    return binary;
  }
  records(): FakeRecord[] {
    return existsSync(this.recordFile) ? readFileSync(this.recordFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as FakeRecord) : [];
  }
  cleanup(): void { rmSync(this.dir, { recursive: true, force: true }); }
}

/** Детерминированные границы, включая середину многобайтного символа. */
export function fragments(bytes: Uint8Array, size: number): Uint8Array[] {
  const result: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += size) result.push(bytes.subarray(offset, offset + size));
  return result;
}
