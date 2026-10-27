import { object } from '../../../src/adapters/codex/rpc.ts';
import { parseProbeOutput, sandboxPassed } from './policy-probe.ts';
import type { OwnRolloutReview } from './own-rollout-evidence.ts';

const exactCommand = (command: unknown, expected: string): boolean => {
  const forms = [expected];
  for (const shell of ['/bin/sh', '/bin/bash', '/bin/zsh']) for (const flag of ['-c', '-lc']) {
    for (const quoted of [expected, `'${expected}'`, `"${expected}"`]) forms.push(`${shell} ${flag} ${quoted}`);
  }
  return typeof command === 'string' && forms.includes(command);
};
/** Независимый разбор настоящих v2 item/completed; пересказ модели не является результатом команды. */
export function reviewRpcPolicy(rows: unknown[], thread: string, marker: string, controls: boolean, runtime: OwnRolloutReview) {
  const items = rows.map(object).filter(row => row?.method === 'item/completed').map(row => object(row?.params));
  const bound = items.every(p => p?.threadId === thread && typeof p.turnId === 'string');
  const commands = items.map(p => object(p?.item)).filter(item => item?.type === 'commandExecution');
  const read = commands.filter(item => exactCommand(item?.command, '/bin/cat -- CONTROL.txt'));
  const probes = commands.filter(item => exactCommand(item?.command, './fs-probe'));
  const output = probes.length === 1 && typeof probes[0]?.aggregatedOutput === 'string' ? parseProbeOutput(probes[0].aggregatedOutput) : undefined;
  const known = new Set(['exec_command', 'write_stdin', 'apply_patch', 'update_plan', 'request_user_input',
    'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource', 'clock__curr_time']);
  return {
    allowedRead: bound && read.length === 1 && read[0]?.exitCode === 0 && read[0]?.aggregatedOutput === marker + '\n',
    filePolicy: bound && probes.length === 1 && probes[0]?.exitCode === 0 && !!output && sandboxPassed(output),
    effectivePolicy: runtime.ownership && runtime.policy,
    extensionPolicy: runtime.inventory === 'confirmed' && !runtime.unexpectedSkills
      && runtime.toolNames.includes('exec_command') && runtime.toolNames.includes('apply_patch') && runtime.toolNames.every(name => known.has(name)),
    controls,
  };
}
