import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const INVENTORY_CODE = 'text(ALL_TOOLS.map(t => t.name));';
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
export interface OwnRolloutReview {
  ownership: boolean; policy: boolean; inventory: 'confirmed' | 'unconfirmed';
  toolNames: string[]; unexpectedSkills: boolean;
}

/** Читается только история UUID, полученного от нашего нового M4, в сегодняшнем каталоге.
 * Прочие transcripts, credentials и настройки не открываются. Содержимое не экспортируется. */
export function readOwnRollout(codexHome: string, thread: string, cwd: string, skillToken: string): OwnRolloutReview {
  const empty: OwnRolloutReview = { ownership: false, policy: false, inventory: 'unconfirmed', toolNames: [], unexpectedSkills: false };
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(thread)) return empty;
  try {
    const date = new Date();
    const dir = join(codexHome, 'sessions', String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
    const names = readdirSync(dir).filter(name => name.startsWith('rollout-') && name.endsWith(`-${thread}.jsonl`));
    if (names.length !== 1) return empty;
    const path = join(dir, names[0]!); const before = lstatSync(path);
    if (!before.isFile() || before.size > 8_388_608) return empty;
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd);
      if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) return empty;
      const bytes = readFileSync(fd); const after = fstatSync(fd);
      if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) return empty;
      return inspectOwnRollout(bytes.toString('utf8'), thread, cwd, codexHome, skillToken);
    } finally { closeSync(fd); }
  } catch { return empty; }
}

/** Независимый разбор effective policy и фактического результата инструмента, не ответа модели. */
export function inspectOwnRollout(text: string, thread: string, cwd: string, codexHome: string, skillToken: string): OwnRolloutReview {
  const result: OwnRolloutReview = { ownership: false, policy: false, inventory: 'unconfirmed', toolNames: [], unexpectedSkills: false };
  try {
    if (Buffer.byteLength(text) > 8_388_608) return result;
    const rows = text.trim().split('\n').map(line => object(JSON.parse(line)));
    const metadata = rows.filter(row => row?.type === 'session_meta').map(row => object(row?.payload));
    result.ownership = metadata.length === 1 && metadata[0]?.id === thread && metadata[0]?.cwd === cwd;
    if (!result.ownership) return result;
    const contexts = rows.filter(row => row?.type === 'turn_context').map(row => object(row?.payload));
    result.policy = contexts.length === 1 && contexts.every(context => {
      const permissions = object(context?.permission_profile); const fs = object(permissions?.file_system);
      const policy = object(context?.file_system_sandbox_policy);
      if (context?.cwd !== cwd || context?.approval_policy !== 'never'
        || object(context?.active_permission_profile)?.id !== 'vibestudio-read-v1'
        || object(context?.sandbox_policy)?.type !== 'read-only' || permissions?.type !== 'managed'
        || permissions.network !== 'restricted' || fs?.type !== 'restricted' || policy?.kind !== 'restricted'
        || JSON.stringify(fs.entries) !== JSON.stringify(policy.entries) || !Array.isArray(fs.entries)) return false;
      let root = 0; let minimal = 0; let workspace = 0; let runtime = 0;
      for (const value of fs.entries) {
        const entry = object(value); const path = object(entry?.path); const special = object(path?.value);
        if (path?.type === 'special' && special?.kind === 'root' && entry?.access === 'deny') root++;
        else if (path?.type === 'special' && special?.kind === 'minimal' && entry?.access === 'read') minimal++;
        else if (path?.type === 'path' && path.path === cwd && entry?.access === 'read') workspace++;
        else if (path?.type === 'path' && typeof path.path === 'string' && entry?.access === 'read'
          && path.path.startsWith(join(codexHome, 'tmp/arg0-macos/codex-arg0'))
          && /^[A-Za-z0-9]+$/.test(path.path.slice(join(codexHome, 'tmp/arg0-macos/codex-arg0').length))) runtime++;
        else return false;
      }
      return root === 1 && minimal === 1 && workspace === 1 && runtime === 1;
    });
    const items = rows.filter(row => row?.type === 'response_item').map(row => object(row?.payload));
    const calls = items.filter(item => item?.type === 'custom_tool_call' && item.name === 'exec' && typeof item.input === 'string'
      && item.input.replace(/\s/g, '') === INVENTORY_CODE.replace(/\s/g, ''));
    if (calls.length === 1 && typeof calls[0]?.call_id === 'string' && calls[0].call_id.length > 0) {
      const outputs = items.filter(item => item?.type === 'custom_tool_call_output' && item.call_id === calls[0]?.call_id);
      if (outputs.length === 1 && Array.isArray(outputs[0]?.output)) {
        const lists = outputs[0].output.map(object).filter(block => block?.type === 'input_text' && typeof block.text === 'string'
          && block.text.trim().startsWith('[')).map(block => JSON.parse((block!.text as string).trim()) as unknown);
        if (lists.length === 1 && Array.isArray(lists[0]) && lists[0].length > 0 && lists[0].length <= 256
          && lists[0].every(name => typeof name === 'string' && /^[A-Za-z0-9_]+$/.test(name))
          && new Set(lists[0]).size === lists[0].length) {
          result.inventory = 'confirmed'; result.toolNames = (lists[0] as string[]).sort();
        }
      }
    }
    result.unexpectedSkills = !!skillToken && items.some(item => item?.role === 'user' && JSON.stringify(item.content).includes(skillToken));
  } catch { result.policy = false; result.inventory = 'unconfirmed'; result.toolNames = []; }
  return result;
}
