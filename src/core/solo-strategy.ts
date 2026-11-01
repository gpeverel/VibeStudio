import type { AgentRunCompletion, ProcessCompletion } from '../shared/agent.ts';
import type { SessionStatus } from '../shared/solo.ts';

export function completionConfirmed(completion: ProcessCompletion): boolean {
  return (completion.process.state === 'not_started' && completion.stdout === 'not_started' && completion.stderr === 'not_started'
      || completion.process.state === 'exited' && completion.stdout === 'ended' && completion.stderr === 'ended')
    && completion.wait === 'settled'
    && !completion.issues.some(issue => ['signal_failed', 'exit_unconfirmed', 'drain_timeout', 'stream_failed', 'process_result_failed'].includes(issue.code));
}
export function completionSuccessful(completion: ProcessCompletion): boolean {
  return completion.process.state === 'exited' && completion.process.exitCode === 0 && completion.process.signal === null
    && completion.stdout === 'ended' && completion.stderr === 'ended' && completion.wait === 'settled' && completion.issues.length === 0;
}
/** У read-only Solo нет автоматического цикла проверок или исправлений. */
export function soloOutcome(result: AgentRunCompletion, stopped: boolean): SessionStatus {
  if (!completionConfirmed(result.completion)) return 'recovery_required';
  if (stopped || result.stopAccepted || result.kind === 'interrupted') return 'interrupted';
  return result.kind === 'success' && completionSuccessful(result.completion) ? 'answered' : 'error';
}

export function unconfirmedCompletion(): ProcessCompletion {
  return { process: { state: 'unconfirmed' }, stdout: 'unconfirmed', stderr: 'unconfirmed',
    signals: [], wait: 'deadline', issues: [{ code: 'exit_unconfirmed', operation: 'wait',
      detail: 'Не удалось подтвердить завершение управляемого запуска.' }], descendants: 'not_guaranteed' };
}
