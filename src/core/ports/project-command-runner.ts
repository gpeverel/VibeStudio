import type { ProjectCommandConsentDecision } from '../../shared/project-command-consent.ts';
import type { ProcessRun } from './process-runner.ts';
import type { ProjectCommandRequest } from './project-command-snapshot.ts';
export interface ProjectCommandRunner {
  /** Неизменяемый request перепроверяется callback непосредственно перед spawn.
   * Доверенный callback принадлежит engine, не renderer/модели. */
  start(request: ProjectCommandRequest, authorization: {
    consentId: string; fingerprint: string;
    recheck: (request: ProjectCommandRequest) => Promise<ProjectCommandConsentDecision>;
  }, timeoutMs: number): Promise<
    | { status: 'started'; run: ProcessRun }
    | { status: 'blocked'; decision: ProjectCommandConsentDecision }
  >;
}
