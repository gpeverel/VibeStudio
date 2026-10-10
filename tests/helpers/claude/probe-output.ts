import type { ClaudeStreamParser } from '../../../src/adapters/claude/parser.ts';
import type { NormalizedPayload } from '../../../src/core/ports/agent.ts';
import type { ProcessRun } from '../../../src/core/ports/process-runner.ts';

export interface ProbeOutput {
  rawText: string;
  payloads: NormalizedPayload[];
  overBudget: boolean;
}

/** Сохраняет проблемный chunk ДО разбора, чтобы ошибка протокола не уничтожала доказательство. */
export async function collectProbeStdout(
  run: Pick<ProcessRun, 'stdout' | 'kill'>,
  parser: ClaudeStreamParser,
  maxBytes: number,
): Promise<ProbeOutput> {
  // Один фиксированный буфер: число мелких chunks не раздувает массив объектов.
  const raw = Buffer.alloc(maxBytes);
  const payloads: NormalizedPayload[] = [];
  let bytes = 0;
  let overBudget = false;
  for await (const chunk of run.stdout) {
    if (bytes + chunk.byteLength > maxBytes) { overBudget = true; void run.kill(); break; }
    raw.set(chunk, bytes);
    bytes += chunk.byteLength;
    payloads.push(...parser.feed(chunk));
    if (parser.error) { void run.kill(); break; }
  }
  payloads.push(...parser.end());
  // Сохраняем исходные переводы строк и отсутствие конечного LF.
  return { rawText: raw.subarray(0, bytes).toString('utf8'), payloads, overBudget };
}
