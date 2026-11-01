import { randomUUID } from 'node:crypto';
import type { AgentEvent, AgentRun, AgentRunCompletion, NormalizedPayload, ProcessCompletion } from '../../src/core/ports/agent.ts';
import type { SoloAgentPort } from '../../src/core/ports/solo-agent.ts';

export function cleanProcess(): ProcessCompletion {
  return { process: { state: 'exited', exitCode: 0, signal: null }, stdout: 'ended', stderr: 'ended',
    signals: [], issues: [], wait: 'settled', descendants: 'not_guaranteed' };
}
export function success(text = 'Синтетический ответ'): AgentRunCompletion {
  return { kind: 'success', text, stopAccepted: false, completion: cleanProcess() };
}
export interface ControlledRun {
  input: Parameters<SoloAgentPort['start']>[0];
  text(text: string, mode?: 'delta' | 'snapshot'): void;
  finish(result?: AgentRunCompletion): void;
  interruptCount: number;
}
/** No installed CLI is invoked. The independent driver controls every lifecycle fact. */
export function createControlledAgent(options: {
  autoFinish?: boolean;
  stop?: 'normal' | 'late_success' | 'reject' | 'unconfirmed' | 'hang';
  onStart?: (input: Parameters<SoloAgentPort['start']>[0]) => void;
  interruptGate?: Promise<void>;
} = {}) {
  const runs: ControlledRun[] = [];
  let history: 'available' | 'missing' | 'unknown' = 'available';
  const port: SoloAgentPort = {
    history: async () => history,
    async start(input) {
      options.onStart?.(input);
      let finishDone!: (result: AgentRunCompletion) => void;
      const done = new Promise<AgentRunCompletion>(resolve => { finishDone = resolve; });
      const queue: AgentEvent[] = [];
      let wake: (() => void) | undefined;
      let ended = false, seq = 0;
      function emit(payload: NormalizedPayload) {
        queue.push({ ...payload, schemaVersion: 1, eventId: randomUUID(), sessionId: input.turn.sessionId,
          participantId: input.participant.id, turnId: input.turn.id, seq: ++seq, timestamp: new Date().toISOString() });
        wake?.(); wake = undefined;
      }
      const controlled: ControlledRun = {
        input, interruptCount: 0,
        text(text, mode = 'snapshot') { emit({ type: 'text', messageId: 'message', mode, text }); },
        finish(result = success()) {
          if (ended) return;
          emit({ type: 'run_finished', result }); ended = true; finishDone(result); wake?.();
        },
      };
      const run: AgentRun = {
        events: { async *[Symbol.asyncIterator]() {
          while (!ended || queue.length > 0) {
            const next = queue.shift();
            if (next) yield next;
            else await new Promise<void>(resolve => { wake = resolve; });
          }
        } },
        diagnostics: [], done,
        async interrupt() {
          controlled.interruptCount++;
          await options.interruptGate;
          if (options.stop === 'reject') throw new Error('Синтетический отказ сигнала');
          if (options.stop === 'hang') return;
          if (options.stop === 'late_success') { controlled.finish(success('Поздний ответ')); return; }
          controlled.finish({ kind: 'interrupted', stopAccepted: true, completion: options.stop === 'unconfirmed'
            ? { ...cleanProcess(), process: { state: 'unconfirmed' }, wait: 'deadline', stdout: 'forced_closed',
              issues: [{ code: 'exit_unconfirmed', operation: 'wait', detail: 'Выход не подтверждён в стенде.' }] }
            : { ...cleanProcess(), process: { state: 'exited', exitCode: null, signal: 'SIGTERM' },
              signals: [{ signal: 'SIGTERM', target: 'group', status: 'sent' }] } });
        },
        async kill() { await run.interrupt(); },
      };
      runs.push(controlled);
      emit({ type: 'run_started', agentSessionId: input.participant.agentSessionId ?? randomUUID() });
      if (options.autoFinish !== false) queueMicrotask(() => { controlled.text('Синтетический ответ'); controlled.finish(); });
      return run;
    },
  };
  return { port, runs, setHistory(value: typeof history) { history = value; } };
}
