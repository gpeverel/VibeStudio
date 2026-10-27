import { TextDecoder } from 'node:util';
import { join } from 'node:path';
import { parseProbeOutput } from './policy-probe.ts';
import type { ProbeOutput } from './policy-probe.ts';
import { R3_BUDGET, R3_PROBE, R3_READ, sha256 } from './admission-probe-scenario.ts';

export interface R3Observation {
  protocol: 'confirmed' | 'unconfirmed';
  read: 'passed' | 'failed' | 'unconfirmed';
  probe?: ProbeOutput;
  patch: 'failed' | 'completed' | 'unconfirmed';
  mcp: boolean; skill: boolean; unexpectedTool: boolean;
}
const obj = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const sameCommand = (actual: unknown, expected: string): boolean => typeof actual === 'string'
  && [expected, ...['/bin/zsh', '/bin/bash', '/bin/sh'].flatMap(shell =>
    ['-c', '-lc'].map(flag => `${shell} ${flag} '${expected}'`))].includes(actual);

/** Bounded raw CLI result observation, not model prose or independent syscalls.
 * The raw thread ID is returned for the owned resume only; it is never exported. */
export function observeR3(bytes: Uint8Array, project: string, token: string, expectedThread?: string):
  { review: R3Observation; thread?: string } {
  const review: R3Observation = { protocol: 'unconfirmed', read: 'unconfirmed', patch: 'unconfirmed',
    mcp: false, skill: false, unexpectedTool: false };
  let thread: string | undefined;
  let turn = false; let terminal = false;
  let reads = 0; let probes = 0; let patches = 0; let mcpCalls = 0;
  const items = new Map<string, { type: string; command?: string; complete?: string }>();
  try {
    if (bytes.byteLength > R3_BUDGET.outputBytes) return { review };
    for (const line of new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\n')) {
      if (Buffer.byteLength(line) > R3_BUDGET.lineBytes) throw new Error('line');
      if (!line.trim()) continue;
      const event = obj(JSON.parse(line));
      if (!event || terminal) throw new Error('event');
      if (event.type === 'thread.started') {
        if (thread || typeof event.thread_id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(event.thread_id)) throw new Error('thread');
        thread = event.thread_id;
        if (expectedThread && thread !== expectedThread) throw new Error('binding');
        continue;
      }
      if (!thread) throw new Error('thread');
      if (event.type === 'turn.started' && !turn) { turn = true; continue; }
      if (!turn) throw new Error('turn');
      if (event.type === 'turn.completed') { terminal = true; continue; }
      if (!['item.started', 'item.updated', 'item.completed'].includes(event.type as string)) throw new Error('event');
      const item = obj(event.item);
      if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 256 || typeof item.type !== 'string') throw new Error('item');
      if (!['command_execution', 'file_change', 'mcp_tool_call', 'agent_message', 'reasoning', 'todo_list'].includes(item.type)) {
        review.unexpectedTool = true; throw new Error('inventory');
      }
      const previous = items.get(item.id);
      const command = item.type === 'command_execution' && typeof item.command === 'string' ? sha256(item.command) : undefined;
      if (item.type === 'command_execution' && !command) throw new Error('command');
      if (previous && (previous.type !== item.type || previous.command !== command)) throw new Error('changed');
      const complete = event.type === 'item.completed' ? sha256(JSON.stringify(item)) : undefined;
      if (previous?.complete) { if (complete !== previous.complete) throw new Error('conflict'); else continue; }
      if (!previous && items.size >= 256) throw new Error('limit');
      items.set(item.id, { type: item.type, command, complete });
      if (!complete) continue;
      if (item.type === 'command_execution') {
        if (sameCommand(item.command, R3_READ)) {
          if (++reads > 1) throw new Error('repeat');
          review.read = item.status === 'completed' && item.exit_code === 0 && item.aggregated_output === 'vs-control\n' ? 'passed' : 'failed';
        } else if (sameCommand(item.command, R3_PROBE)) {
          if (++probes > 1) throw new Error('repeat');
          if (item.status === 'completed' && item.exit_code === 0 && typeof item.aggregated_output === 'string') review.probe = parseProbeOutput(item.aggregated_output);
        } else if (!sameCommand(item.command, '/bin/cat -- .agents/skills/vs-r3-skill/SKILL.md')) review.unexpectedTool = true;
      }
      if (item.type === 'file_change') {
        const changes = Array.isArray(item.changes) ? item.changes : [];
        const change = changes.length === 1 ? obj(changes[0]) : undefined;
        if (!change || !['ALT-WRITE.txt', join(project, 'ALT-WRITE.txt')].includes(change.path as string) || change.kind !== 'add') {
          review.unexpectedTool = true; continue;
        }
        if (++patches > 1) throw new Error('repeat');
        if (item.status === 'failed' || item.status === 'completed') review.patch = item.status;
      }
      if (item.type === 'mcp_tool_call') {
        if (item.server !== 'vs_r3' || item.tool !== 'ping') { review.unexpectedTool = true; continue; }
        if (++mcpCalls > 1) throw new Error('repeat');
        const result = obj(item.result);
        review.mcp = item.status === 'completed' && !item.error && Array.isArray(result?.content)
          && result.content.length === 1 && obj(result.content[0])?.type === 'text'
          && obj(result.content[0])?.text === 'R3_MCP_' + token;
      }
      if (item.type === 'agent_message' && typeof item.text === 'string') review.skill ||= item.text.split(/\r?\n/).includes('R3_SKILL_' + token);
    }
    if (!terminal || [...items.values()].some(item => !item.complete)) throw new Error('incomplete');
    review.protocol = 'confirmed';
  } catch { review.protocol = 'unconfirmed'; }
  return { review, ...(review.protocol === 'confirmed' && thread ? { thread } : {}) };
}
