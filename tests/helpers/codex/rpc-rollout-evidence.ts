import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { object } from '../../../src/adapters/codex/rpc.ts';
import { inspectOwnRollout } from './own-rollout-evidence.ts';
import type { OwnRolloutReview } from './own-rollout-evidence.ts';
const empty = (): OwnRolloutReview => ({ ownership: false, policy: false, inventory: 'unconfirmed', toolNames: [], unexpectedSkills: false });

/** inject_items до первого хода сохраняет отдельный default-turn context.
 * Проверяем ОБА снимка независимо и требуем одинаковую политику, затем связываем реальный turn с RPC.
 * Исходный инспектор exec не меняется; лишние/повреждённые contexts не отбрасываются молча. */
export function inspectOwnRpcRollout(text: string, thread: string, turn: string, cwd: string, home: string, skillToken: string): OwnRolloutReview {
  try {
    if (Buffer.byteLength(text) > 8_388_608 || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(turn)) return empty();
    const rows = text.trim().split('\n').map(line => object(JSON.parse(line)));
    const contexts = rows.filter(row => row?.type === 'turn_context');
    const first = object(contexts[0]?.payload), second = object(contexts[1]?.payload);
    if (contexts.length !== 2 || first?.turn_id !== 'auto-compact-0' || second?.turn_id !== turn || second.root_turn_id !== turn) return empty();
    const keys = ['cwd', 'approval_policy', 'sandbox_policy', 'permission_profile', 'active_permission_profile', 'file_system_sandbox_policy'];
    const same = keys.every(key => JSON.stringify(first[key]) === JSON.stringify(second[key]));
    const reviews = contexts.map(context => inspectOwnRollout(rows.filter(row => row?.type !== 'turn_context' || row === context)
      .map(row => JSON.stringify(row)).join('\n'), thread, cwd, home, skillToken));
    return { ...reviews[1]!, policy: same && reviews.every(review => review.ownership && review.policy) };
  } catch { return empty(); }
}

/** Читается только файл известного собственного UUID; никакого поиска чужих диалогов. */
export function readOwnRpcRollout(home: string, thread: string, turn: string, cwd: string, token: string): OwnRolloutReview {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(thread)) return empty();
  try {
    const date = new Date(), dir = join(home, 'sessions', String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
    const names = readdirSync(dir).filter(name => name.startsWith('rollout-') && name.endsWith(`-${thread}.jsonl`));
    if (names.length !== 1) return empty();
    const path = join(dir, names[0]!), before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size > 8_388_608) return empty();
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd);
      if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) return empty();
      const bytes = readFileSync(fd), after = fstatSync(fd);
      if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) return empty();
      return inspectOwnRpcRollout(bytes.toString('utf8'), thread, turn, cwd, home, token);
    } finally { closeSync(fd); }
  } catch { return empty(); }
}
