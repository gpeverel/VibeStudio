import { z } from 'zod';

export const R3_IDENTITY_PATHS = [
  'tests/live/codex-admission.probe.ts',
  'tests/helpers/codex/admission-probe.ts', 'tests/helpers/codex/admission-probe-scenario.ts',
  'tests/helpers/codex/admission-probe-observation.ts', 'tests/helpers/codex/admission-probe-evidence.ts',
  'tests/helpers/codex/r3-mcp.mjs', 'tests/helpers/codex/fs-policy-probe.c',
  'tests/helpers/codex/policy-probe.ts', 'tests/helpers/codex/live-harness.ts',
  'tests/helpers/codex/live-plan.ts', 'tests/helpers/codex/m4-evidence.ts', 'tests/helpers/codex/m4-command-evidence.ts',
  'src/adapters/codex/args.ts', 'src/adapters/codex/contracts.ts', 'src/adapters/codex/profile.ts',
  'src/core/agent-instructions.ts', 'src/adapters/process-runner/index.ts', 'src/adapters/process-runner/queue.ts',
  'scripts/with-node.sh', 'package-lock.json',
  'tests/codex/admission-probe.test.ts', 'tests/codex/admission-probe-evidence.test.ts',
] as const;

// Independent export schema and limits; no supervisor verdict helpers imported.
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const stream = z.enum(['not_started', 'ended', 'errored', 'forced_closed', 'unconfirmed', 'unknown']);
const completion = z.object({
  process: z.union([
    z.object({ state: z.literal('exited'), exitCode: z.number().int().nullable(), signal: z.string().regex(/^(SIG[A-Z0-9]{1,12}|unknown)$/).nullable() }).strict(),
    z.object({ state: z.enum(['not_started', 'unconfirmed', 'unknown']) }).strict(),
  ]), stdout: stream, stderr: stream, wait: z.enum(['settled', 'deadline', 'unknown']), descendants: z.literal('not_guaranteed'),
  signals: z.array(z.object({ signal: z.enum(['SIGTERM', 'SIGKILL', 'unknown']), target: z.enum(['process', 'group', 'unknown']),
    status: z.enum(['sent', 'not_found', 'failed', 'unknown']) }).strict()).max(32),
  issues: z.array(z.object({ code: z.enum(['spawn_failed', 'timeout', 'drain_timeout', 'output_limit', 'stdin_failed', 'unsupported_platform',
    'signal_failed', 'stream_failed', 'process_result_failed', 'exit_unconfirmed', 'unknown']),
  operation: z.enum(['spawn', 'interrupt', 'kill', 'stdin', 'stdout', 'stderr', 'done', 'wait', 'unknown']).optional() }).strict()).max(32),
}).strict();
const operation = z.object({ attempted: z.literal(true), state: z.enum(['allowed', 'denied', 'error']),
  code: z.enum(['NONE', 'EACCES', 'EPERM', 'OTHER']), matched: z.boolean() }).strict();
const operations = z.object({ schemaVersion: z.literal(1), control: operation, outside: operation, symlink: operation,
  writeInside: operation, writeOutside: operation }).strict();
const observation = z.object({ protocol: z.enum(['confirmed', 'unconfirmed']), read: z.enum(['passed', 'failed', 'unconfirmed']),
  probe: operations.optional(), patch: z.enum(['completed', 'failed', 'unconfirmed']), mcp: z.boolean(), skill: z.boolean(), unexpectedTool: z.boolean() }).strict();
const steps = ['git-init', 'compile', 'baseline', 'positive', 'first', 'resume'] as const;
const process = z.object({ step: z.enum(steps), argvSha256: hash, handle: z.enum(['returned', 'unconfirmed']),
  stdoutBytes: count, stderrBytes: count, stdoutEnded: z.boolean(), stderrEnded: z.boolean(), completion: completion.nullable(),
  observation: observation.optional(), threadBinding: z.enum(['first_owned', 'resume_matched']).optional(),
  effects: z.object({ controls: z.boolean(), writeInside: z.boolean(), writeOutside: z.boolean(), alternativeWrite: z.boolean(),
    hook: z.boolean(), mcp: z.boolean() }).strict().optional(),
}).strict();
const identity = z.object({ executable: z.object({ wrapper: hash, native: hash, node: hash }).strict(),
  files: z.record(z.enum(R3_IDENTITY_PATHS), hash) }).strict();
export type R3Identity = z.infer<typeof identity>;
const evidence = z.object({ schemaVersion: z.literal(1), scenario: z.literal('P3-R3'),
  expectedVersion: z.literal('0.163.0'), startedAt: z.iso.datetime(), recordedAt: z.iso.datetime(), identity,
  budget: z.object({ models: z.literal(3), auxiliary: z.literal(3), cliNonModel: z.literal(0), totalMs: z.literal(320_000),
    cleanupMs: z.literal(5_000), modelMs: z.literal(90_000), stopMs: z.literal(1_000), graceMs: z.literal(200),
    drainMs: z.literal(1_000), outputBytes: z.literal(1_048_576), lineBytes: z.literal(65_536) }).strict(),
  report: z.object({ scenario: z.literal('P3-R3'), provenance: z.enum(['live', 'synthetic']), productionAdmission: z.literal('not_assessed'),
    status: z.enum(['running', 'observed', 'stopped']), reason: z.enum(['cancelled', 'deadline', 'launch_failed', 'lifecycle', 'output_limit',
      'baseline_failed', 'positive_unconfirmed', 'policy_unconfirmed', 'policy_failed', 'controls_changed', 'evidence_failed',
      'preparation_failed', 'identity_changed']).optional(), attempts: z.object({ auxiliary: count.max(3), models: count.max(3), cliNonModel: z.literal(0) }).strict(),
    sourceSha256: hash.optional(), probeSha256: hash.optional(), baseline: operations.optional(), processes: z.array(process).max(6),
    cleanup: z.enum(['not_created', 'pending', 'removed', 'retained']), stopFailures: count,
    retainedWorkspace: z.string().regex(/^vs-codex-R3-[A-Za-z0-9_-]{1,32}$/).optional(),
  }).strict(), p3: z.literal('unconfirmed'), extensions: z.literal('not_attested'),
  filesystemEffects: z.literal('reported_by_supervisor'),
}).strict();
type Entry = z.infer<typeof process>;
const exited = (p: Entry): boolean => p.handle === 'returned' && p.stdoutEnded && p.stderrEnded && p.completion !== null
  && p.completion.process.state === 'exited' && p.completion.stdout === 'ended' && p.completion.stderr === 'ended'
  && p.completion.wait === 'settled' && p.completion.signals.every(s => ['sent', 'not_found'].includes(s.status))
  && !p.completion.issues.some(i => ['signal_failed', 'stream_failed', 'process_result_failed', 'exit_unconfirmed', 'unknown'].includes(i.code));
const succeeded = (p: Entry): boolean => exited(p) && p.completion?.process.state === 'exited'
  && p.completion.process.exitCode === 0 && p.completion.process.signal === null && p.completion.issues.length === 0
  && p.stdoutBytes + p.stderrBytes <= 1_048_576;
const allowed = (o: z.infer<typeof operation>): boolean => o.state === 'allowed' && o.code === 'NONE' && o.matched;
const policy = (o: z.infer<typeof operations>): boolean => allowed(o.control)
  && [o.outside, o.symlink, o.writeInside, o.writeOutside].every(v => v.state === 'denied' && ['EPERM', 'EACCES'].includes(v.code) && !v.matched);
const effects = (p: Entry): boolean => !!p.effects && p.effects.controls && !p.effects.writeInside && !p.effects.writeOutside && !p.effects.alternativeWrite;
const positive = (p: Entry): boolean => succeeded(p) && effects(p) && !!p.effects?.hook && !!p.effects.mcp
  && p.observation?.protocol === 'confirmed' && p.observation.mcp && p.observation.skill && !p.observation.unexpectedTool;
const candidate = (p: Entry): boolean => succeeded(p) && effects(p) && !p.effects?.hook && !p.effects?.mcp
  && p.observation?.protocol === 'confirmed' && !p.observation.mcp && !p.observation.skill && !p.observation.unexpectedTool
  && p.observation.read === 'passed' && p.observation.patch === 'failed' && !!p.observation.probe && policy(p.observation.probe)
  && p.threadBinding === (p.step === 'first' ? 'first_owned' : 'resume_matched');

/** Validates exported consistency, never repeats syscalls or elevates synthetic to live. */
export function inspectR3Evidence(input: unknown, expected: R3Identity) {
  const base = { basis: 'exported_summary' as const, identity: 'unconfirmed' as 'matched' | 'mismatch' | 'unconfirmed',
    provenance: 'invalid' as 'live' | 'synthetic' | 'invalid', accounting: false, lifecycle: false, cleanup: false,
    positive: false, first: false, resume: false, consistent: false,
    productionAdmission: 'not_assessed' as const, p3: 'unconfirmed' as const };
  const parsed = evidence.safeParse(input);
  if (!parsed.success || !identity.safeParse(expected).success) return { review: base };
  const data = parsed.data; const r = data.report; const ps = r.processes;
  const sameRecord = (a: Record<string, string>, b: Record<string, string>): boolean => Object.keys(a).length === Object.keys(b).length
    && Object.keys(a).every(key => Object.hasOwn(b, key) && a[key] === b[key]);
  base.identity = sameRecord(data.identity.files, expected.files) && sameRecord(data.identity.executable, expected.executable) ? 'matched' : 'mismatch';
  base.provenance = r.provenance;
  if (base.identity !== 'matched') return { review: base };
  base.accounting = ps.every((p, i) => p.step === steps[i]) && r.attempts.auxiliary === Math.min(3, ps.length)
    && r.attempts.models === Math.max(0, ps.length - 3);
  base.lifecycle = ps.length > 0 && ps.every(exited);
  base.cleanup = r.stopFailures === 0 && ((r.cleanup === 'removed' && ps.every(exited))
    || (r.cleanup === 'not_created' && ps.length === 0));
  base.positive = !!ps[3] && positive(ps[3]);
  base.first = !!ps[4] && candidate(ps[4]); base.resume = !!ps[5] && candidate(ps[5]);
  const baseline = r.baseline && [r.baseline.control, r.baseline.outside, r.baseline.symlink, r.baseline.writeInside, r.baseline.writeOutside].every(allowed);
  const checks = [ps[0] && succeeded(ps[0]), ps[1] && succeeded(ps[1]) && !!r.probeSha256,
    ps[2] && succeeded(ps[2]) && baseline, base.positive, base.first, base.resume];
  const identityBound = ps.length === 0 || r.sourceSha256 === expected.files['tests/helpers/codex/fs-policy-probe.c'];
  base.consistent = base.accounting && identityBound && Date.parse(data.recordedAt) >= Date.parse(data.startedAt)
    && (r.status === 'observed' ? ps.length === 6 && checks.every(Boolean) && base.cleanup && !r.reason
      : r.status === 'stopped' && !!r.reason && checks.slice(0, Math.max(0, ps.length - 1)).every(Boolean))
    && (r.cleanup !== 'removed' || base.cleanup);
  // Remove the owned temporary-directory locator even from an otherwise safe failure export.
  delete data.report.retainedWorkspace;
  return { review: base, evidence: data };
}
