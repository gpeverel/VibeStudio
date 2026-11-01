import { z } from 'zod';
import type { AppApi } from '../shared/app-api.ts';
import { soloSchemas } from '../shared/solo.ts';
import type { ApiResult, OperationView, ProjectView } from '../shared/solo.ts';

const commandSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('selectProject'), request: soloSchemas.selectProject }).strict(),
  z.object({ method: z.literal('createSession'), request: soloSchemas.createSession }).strict(),
  z.object({ method: z.literal('prepareSetup'), request: soloSchemas.prepareSetup }).strict(),
  z.object({ method: z.literal('confirmSetup'), request: soloSchemas.confirmSetup }).strict(),
  z.object({ method: z.literal('revokeConsent'), request: soloSchemas.revokeConsent }).strict(),
  z.object({ method: z.literal('sendTurn'), request: soloSchemas.sendTurn }).strict(),
  z.object({ method: z.literal('stop'), request: soloSchemas.stop }).strict(),
]);
const envelope = z.object({ version: z.literal(1), commands: z.array(commandSchema).max(16) }).strict();
export type PendingCommand = z.infer<typeof commandSchema>;
export const PENDING_COMMANDS_KEY = 'vibestudio:pending-commands:v1';
export const commandLabels: Record<PendingCommand['method'], string> = {
  selectProject: 'Выбор проекта', createSession: 'Создание сессии', prepareSetup: 'Проверка подготовки',
  confirmSetup: 'Подтверждение подготовки', revokeConsent: 'Отзыв согласия', sendTurn: 'Отправка задачи', stop: 'Остановка',
};
type StoragePort = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Only request identity survives reload here. Business state remains authoritative in main/SQLite. */
export function createPendingCommands(storage: () => StoragePort) {
  function read(): PendingCommand[] {
    const raw = storage().getItem(PENDING_COMMANDS_KEY);
    if (raw === null) return [];
    try {
      const { commands } = envelope.parse(JSON.parse(raw));
      if (new Set(commands.map(command => command.request.requestId)).size !== commands.length) throw new Error('duplicate');
      return commands;
    } catch { throw new Error('Не удалось прочитать сохранённый запрос. Новые действия заблокированы. Закройте и снова откройте приложение; перед новым действием проверьте сохранённые сессии: прежнее действие могло выполниться.'); }
  }
  function write(commands: PendingCommand[]) {
    const value = envelope.parse({ version: 1, commands });
    if (commands.length) storage().setItem(PENDING_COMMANDS_KEY, JSON.stringify(value));
    else storage().removeItem(PENDING_COMMANDS_KEY);
  }
  return {
    read,
    put(command: PendingCommand): PendingCommand[] {
      const safe = commandSchema.parse(command), commands = read();
      const existing = commands.find(item => item.request.requestId === safe.request.requestId);
      if (existing && JSON.stringify(existing) !== JSON.stringify(safe)) throw new Error('Сохранённый запрос с этим ID имеет другое содержимое.');
      if (!existing) commands.push(safe);
      write(commands); return commands;
    },
    acknowledge(requestId: string): PendingCommand[] {
      const remaining = read().filter(command => command.request.requestId !== requestId);
      write(remaining); return remaining;
    },
  };
}

/** Deliberately explicit: persisted data cannot select arbitrary IPC methods. Main validates again. */
export function invokePendingCommand(api: AppApi, command: PendingCommand): Promise<ApiResult<OperationView | ProjectView | null>> {
  switch (command.method) {
    case 'selectProject': return api.selectProject(command.request);
    case 'createSession': return api.createSession(command.request);
    case 'prepareSetup': return api.prepareSetup(command.request);
    case 'confirmSetup': return api.confirmSetup(command.request);
    case 'revokeConsent': return api.revokeConsent(command.request);
    case 'sendTurn': return api.sendTurn(command.request);
    case 'stop': return api.stop(command.request);
  }
}
