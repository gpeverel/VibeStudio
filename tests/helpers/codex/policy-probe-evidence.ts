import { createHash } from 'node:crypto';
import { z } from 'zod';

// Независимая схема экспорта: не использует verdict-функции или константы надзора R2.
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const stream = z.enum(['not_started', 'ended', 'errored', 'forced_closed', 'unconfirmed', 'unknown']);
const completion = z.object({
  process: z.union([
    z.object({ state: z.literal('exited'), exitCode: z.number().int().nullable(),
      signal: z.string().regex(/^(SIG[A-Z0-9]{1,12}|unknown)$/).nullable() }),
    z.object({ state: z.enum(['not_started', 'unconfirmed', 'unknown']) }),
  ]),
  stdout: stream, stderr: stream, wait: z.enum(['settled', 'deadline', 'unknown']),
  descendants: z.literal('not_guaranteed'),
  signals: z.array(z.object({
    signal: z.enum(['SIGTERM', 'SIGKILL', 'unknown']), target: z.enum(['process', 'group', 'unknown']),
    status: z.enum(['sent', 'not_found', 'failed', 'unknown']),
  })).max(32),
  issues: z.array(z.object({
    code: z.enum(['spawn_failed', 'timeout', 'drain_timeout', 'output_limit', 'stdin_failed',
      'unsupported_platform', 'signal_failed', 'stream_failed', 'process_result_failed', 'exit_unconfirmed', 'unknown']),
    operation: z.enum(['spawn', 'interrupt', 'kill', 'stdin', 'stdout', 'stderr', 'done', 'wait', 'unknown']).optional(),
  })).max(32),
});
const operation = z.object({
  attempted: z.boolean(), state: z.enum(['allowed', 'denied', 'error']),
  code: z.enum(['NONE', 'EACCES', 'EPERM', 'OTHER']), matched: z.boolean(),
});
const operations = z.object({
  schemaVersion: z.literal(1), control: operation, outside: operation, symlink: operation,
  writeInside: operation, writeOutside: operation,
});
const steps = ['compile', 'baseline', 'sandbox-help', 'sandbox'] as const;
const implementationRoles = ['entry', 'supervisor', 'completion_export', 'runner', 'queue', 'environment'] as const;
const executableRoles = ['wrapper', 'native', 'node'] as const;
const evidence = z.object({
  schemaVersion: z.literal(1),
  startedAt: z.iso.datetime(), recordedAt: z.iso.datetime(), expectedVersion: z.literal('0.163.0'),
  executable: z.array(z.object({ role: z.enum(executableRoles), sha256: sha })).length(3),
  implementation: z.array(z.object({ role: z.enum(implementationRoles), sha256: sha })).length(6),
  sourceSha256: sha,
  budget: z.object({
    cli: z.literal(2), auxiliary: z.literal(2), models: z.literal(0), totalMs: z.literal(60_000),
    compileMs: z.literal(20_000), processMs: z.literal(10_000), cleanupMs: z.literal(5_000),
    stopMs: z.literal(2_000), graceMs: z.literal(200), drainMs: z.literal(1_000), outputBytes: z.literal(65_536),
  }),
  report: z.object({
    scenario: z.literal('P3-R2'), provenance: z.enum(['live', 'synthetic']),
    productionAdmission: z.literal('not_assessed'), status: z.enum(['running', 'observed', 'stopped']),
    reason: z.enum(['cancelled', 'deadline', 'launch_failed', 'lifecycle', 'output_limit', 'baseline_failed',
      'interface_unconfirmed', 'policy_unconfirmed', 'policy_failed', 'controls_changed', 'evidence_failed',
      'preparation_failed', 'identity_changed']).optional(),
    attempts: z.object({ cli: count.max(2), auxiliary: count.max(2), models: z.literal(0) }),
    sourceSha256: sha.optional(), probeSha256: sha.optional(),
    baseline: operations.optional(), sandbox: operations.optional(),
    processes: z.array(z.object({
      step: z.enum(steps), argvSha256: sha,
      envNames: z.array(z.enum(['HOME', 'PATH', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'CODEX_HOME'])).max(9),
      handle: z.enum(['returned', 'unconfirmed']), stdoutBytes: count, stderrBytes: count,
      stdoutEnded: z.boolean(), stderrEnded: z.boolean(), completion: completion.nullable(),
    })).max(4),
    cleanup: z.enum(['not_created', 'pending', 'removed', 'retained']), stopFailures: count,
  }),
  p3: z.literal('unconfirmed'), execPolicy: z.literal('not_assessed'), extensions: z.literal('not_assessed'),
  limitations: z.array(z.enum(['sandbox_command_only', 'runtime_reads_not_audited',
    'configuration_layers_not_audited', 'network_effects_not_attested', 'detached_children_not_guaranteed'])).length(5),
});
export type R2EvidenceIdentity = {
  readonly sourceSha256: string;
  readonly executable: Readonly<Record<typeof executableRoles[number], string>>;
  readonly implementation: Readonly<Record<typeof implementationRoles[number], string>>;
};
type Verdict = 'confirmed_in_export' | 'unconfirmed';
export interface R2EvidenceReview {
  provenance: 'live' | 'synthetic' | 'invalid';
  basis: 'exported_summary';
  identity: 'matched' | 'mismatch' | 'unconfirmed';
  attemptAccounting: Verdict;
  lifecycle: Verdict | 'not_started';
  cleanup: Verdict;
  baseline: Verdict;
  sandboxOperations: Verdict;
  filesystemEffects: 'reported_by_supervisor' | 'unconfirmed';
  productionAdmission: 'not_assessed';
  execPolicy: 'not_assessed';
  extensions: 'not_assessed';
  p3: 'unconfirmed';
}
const exited = (value: z.infer<typeof evidence>['report']['processes'][number]): boolean =>
  value.handle === 'returned' && value.stdoutEnded && value.stderrEnded && value.completion !== null
  && value.completion.process.state === 'exited'
  && value.completion.stdout === 'ended' && value.completion.stderr === 'ended'
  && value.completion.wait === 'settled'
  && value.completion.signals.every(signal => ['sent', 'not_found'].includes(signal.status))
  // Ошибка Stop либо противоречие exit/EOF не исчезают при пустом signals.
  // Обычный timeout с последующим подтверждённым выходом допускает cleanup, но не успех политики.
  && !value.completion.issues.some(issue =>
    ['signal_failed', 'stream_failed', 'exit_unconfirmed', 'process_result_failed'].includes(issue.code));
const succeeded = (value: z.infer<typeof evidence>['report']['processes'][number]): boolean =>
  exited(value) && value.completion!.process.state === 'exited'
  && value.completion!.process.exitCode === 0 && value.completion!.process.signal === null
  && value.completion!.issues.length === 0 && value.stdoutBytes + value.stderrBytes <= 65_536;
const allowed = (value: z.infer<typeof operation>): boolean =>
  value.attempted && value.state === 'allowed' && value.code === 'NONE' && value.matched;
const denied = (value: z.infer<typeof operation>): boolean =>
  value.attempted && value.state === 'denied' && ['EACCES', 'EPERM'].includes(value.code) && !value.matched;

/** expected берётся из отдельно сверенного manifest A/B, не из самого evidence.
 * SHA подтверждает соответствие предъявленным bytes, но не достоверность их происхождения.
 * Никаких запусков CLI, чтения credentials либо автоматического допуска. */
export function reviewCodexR2Evidence(input: unknown, expected: R2EvidenceIdentity): R2EvidenceReview {
  const review: R2EvidenceReview = {
    provenance: 'invalid', basis: 'exported_summary', identity: 'unconfirmed', attemptAccounting: 'unconfirmed',
    lifecycle: 'unconfirmed', cleanup: 'unconfirmed', baseline: 'unconfirmed', sandboxOperations: 'unconfirmed',
    filesystemEffects: 'unconfirmed', productionAdmission: 'not_assessed', execPolicy: 'not_assessed',
    extensions: 'not_assessed', p3: 'unconfirmed',
  };
  const parsed = evidence.safeParse(input);
  if (!parsed.success) return review;
  const value = parsed.data;
  const report = value.report;
  review.provenance = report.provenance;
  const same = <T extends string>(entries: { role: T; sha256: string }[], wanted: Readonly<Record<T, string>>): boolean =>
    new Set(entries.map(entry => entry.role)).size === entries.length
    && entries.every(entry => entry.sha256 === wanted[entry.role]);
  review.identity = value.sourceSha256 === expected.sourceSha256
    && (report.sourceSha256 === undefined || report.sourceSha256 === expected.sourceSha256)
    && same(value.executable, expected.executable) && same(value.implementation, expected.implementation)
    ? 'matched' : 'mismatch';
  const processes = report.processes;
  if (processes.some((entry, index) => entry.step !== steps[index])
    || report.attempts.auxiliary !== Math.min(processes.length, 2)
    || report.attempts.cli !== Math.max(processes.length - 2, 0)
    || processes.some(entry => new Set(entry.envNames).size !== entry.envNames.length)
    || Date.parse(value.recordedAt) < Date.parse(value.startedAt)
    || new Set(value.limitations).size !== 5) return review;
  review.attemptAccounting = 'confirmed_in_export';
  review.lifecycle = processes.length === 0 ? 'not_started'
    : processes.every(exited) ? 'confirmed_in_export' : 'unconfirmed';
  if (report.stopFailures === 0 && (report.cleanup === 'removed' && processes.every(exited)
    || report.cleanup === 'not_created' && processes.length === 0)) review.cleanup = 'confirmed_in_export';
  if (review.identity !== 'matched' || report.sourceSha256 === undefined || report.probeSha256 === undefined) return review;
  const baseline = report.baseline;
  if (baseline && processes.length >= 2 && processes.slice(0, 2).every(succeeded)
    && [baseline.control, baseline.outside, baseline.symlink, baseline.writeInside, baseline.writeOutside].every(allowed)) {
    review.baseline = 'confirmed_in_export';
  }
  const sandbox = report.sandbox;
  if (review.baseline === 'confirmed_in_export' && review.cleanup === 'confirmed_in_export'
    && report.status === 'observed' && report.reason === undefined && processes.length === 4
    && processes.every(succeeded) && sandbox && allowed(sandbox.control)
    && [sandbox.outside, sandbox.symlink, sandbox.writeInside, sandbox.writeOutside].every(denied)) {
    review.sandboxOperations = 'confirmed_in_export';
    // Отдельных фактов проверки маркеров/исходных файлов экспорт не содержит.
    review.filesystemEffects = 'reported_by_supervisor';
  }
  return review;
}

/** Закрытая обезличенная проекция; provenance не повышается, неизвестные поля и пути удаляются. */
export function exportCodexR2Evidence(text: string, expected: R2EvidenceIdentity) {
  if (Buffer.byteLength(text) > 65_536) return undefined;
  let input: unknown;
  try { input = JSON.parse(text); } catch { return undefined; }
  const parsed = evidence.safeParse(input);
  if (!parsed.success) return undefined;
  const review = reviewCodexR2Evidence(parsed.data, expected);
  if (review.identity !== 'matched' || review.attemptAccounting !== 'confirmed_in_export') return undefined;
  return { schemaVersion: 1 as const, sourceEvidenceSha256: createHash('sha256').update(text).digest('hex'),
    evidence: parsed.data, review };
}
