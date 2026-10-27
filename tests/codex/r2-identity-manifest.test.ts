import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import diagnostics from '../fixtures/codex/observed-0.163.0-diagnostics-d02.json' with { type: 'json' };
import manifest from '../fixtures/codex/r2-identity-manifest.json' with { type: 'json' };
import type { R2EvidenceIdentity } from '../helpers/codex/policy-probe-evidence.ts';

// Ожидаемые значения зафиксированы до R2 и не извлекаются из проверяемого evidence.
// Тест читает только репозиторий: установленная CLI и её конфигурация не открываются.
const expected: R2EvidenceIdentity = manifest.identity;
const implementation: Record<keyof R2EvidenceIdentity['implementation'], string> = {
  entry: 'tests/live/codex-policy.probe.ts',
  supervisor: 'tests/helpers/codex/policy-probe.ts',
  completion_export: 'tests/helpers/codex/live-harness.ts',
  runner: 'src/adapters/process-runner/index.ts',
  queue: 'src/adapters/process-runner/queue.ts',
  environment: 'src/adapters/codex/args.ts',
};
const digest = (path: string): string => createHash('sha256')
  .update(readFileSync(new URL('../../' + path, import.meta.url))).digest('hex');

describe('R2: независимый manifest согласованного сценария', () => {
  it.each(Object.keys(implementation) as (keyof typeof implementation)[])(
    '%s соответствует сверенной до запуска редакции', role => {
      expect(digest(implementation[role])).toBe(expected.implementation[role]);
    });

  it('контрольная C-программа соответствует отдельно закреплённому исходнику', () => {
    expect(digest('tests/helpers/codex/fs-policy-probe.c')).toBe(expected.sourceSha256);
  });

  it('pins установки сохраняют идентичность D02, без повторного запуска диагностики', () => {
    expect(expected.executable).toEqual(Object.fromEntries(
      diagnostics.identity.map(({ role, sha256 }) => [role, sha256]),
    ));
  });
});
