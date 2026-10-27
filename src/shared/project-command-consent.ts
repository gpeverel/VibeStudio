/** P4: безопасные результаты. Запросы с путями/env остаются во внутреннем порту. */
export type ProjectCommandPurpose = 'setup' | 'test' | 'check' | 'build'
  | 'push' | 'publish' | 'destructive';

export type ProjectCommandSnapshotIssue =
  | 'invalid_request' | 'missing_input' | 'unreadable_input' | 'non_regular_input'
  | 'ambiguous_path' | 'outside_project' | 'unsupported_command' | 'unknown_dependency'
  | 'ambiguous_manifest' | 'dependency_cycle' | 'unstable_input' | 'limit_exceeded'
  | 'snapshot_failed';

export type ProjectCommandCoverageLimit =
  | 'runtime_dependencies_not_attested' | 'system_toolchain_not_attested'
  | 'filesystem_race_after_capture';

export interface ProjectCommandInputIdentity {
  /** Относительный путь либо безопасный идентификатор toolchain; без argv/env/body. */
  readonly path: string;
  readonly kind: 'file' | 'manifest' | 'configuration' | 'lockfile' | 'executable' | 'script';
  /** null фиксирует отсутствие поддержанного опционального входа. */
  readonly digest: string | null;
}

export interface ProjectCommandCoverage {
  readonly profile: 'project-command-v1';
  readonly inputs: readonly ProjectCommandInputIdentity[];
  /** Не являются разрешением неизвестных entrypoints или shell-конструкций. */
  readonly limitations: readonly ProjectCommandCoverageLimit[];
}

export type ProjectCommandSnapshot =
  | { readonly status: 'known'; readonly fingerprint: string; readonly coverage: ProjectCommandCoverage }
  | { readonly status: 'blocked'; readonly reason: ProjectCommandSnapshotIssue; readonly coverage: ProjectCommandCoverage };

export type ProjectCommandConsentBlockReason = ProjectCommandSnapshotIssue
  | 'separate_authorization_required' | 'unknown_challenge' | 'stale_challenge';

/** allowed — актуальность согласия при последнем чтении, не разрешение ОС или запуск. */
export type ProjectCommandConsentDecision =
  | { readonly status: 'allowed'; readonly consentId: string; readonly fingerprint: string;
      readonly coverage: ProjectCommandCoverage }
  | { readonly status: 'needs_consent'; readonly reason: 'not_granted' | 'invalidated';
      readonly challengeId: string; readonly fingerprint: string; readonly coverage: ProjectCommandCoverage }
  | { readonly status: 'blocked'; readonly reason: ProjectCommandConsentBlockReason;
      readonly coverage: ProjectCommandCoverage };
