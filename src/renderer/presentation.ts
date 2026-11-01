import type { AgentRunCompletion, NormalizedPayload } from '../shared/agent.ts';
import type { SessionStatus, SoloEvent } from '../shared/solo.ts';

export const statusLabels: Record<SessionStatus, string> = {
  preparing: 'Подготовка', needs_consent: 'Нужно согласие', ready: 'Можно отправить задачу',
  running: 'Выполняется', stopping: 'Останавливается', answered: 'Ответ получен',
  interrupted: 'Прервано', error: 'Ошибка', recovery_required: 'Нужна сверка после сбоя',
};
export const limitationLabels: Record<string, string> = {
  runtime_dependencies_not_attested: 'Снимок не охватывает весь код зависимостей, загружаемый во время выполнения.',
  system_toolchain_not_attested: 'Системные инструменты и их глобальная конфигурация полностью не аттестованы.',
  filesystem_race_after_capture: 'Повторная проверка не устраняет гонку между снимком файлов и запуском.',
  cli_configuration_not_audited: 'Приложение доверяет установленной CLI и не проводит полный аудит её конфигурации.',
  os_isolation_not_attested: 'Полная изоляция CLI средствами ОС не подтверждена.',
  network_not_restricted: 'Полная изоляция сети процесса не подтверждена.',
  detached_children_not_guaranteed: 'Остановка отделившихся дочерних процессов не гарантируется.',
};
export const consentReasonLabels: Record<string, string> = {
  not_granted: 'Согласие ещё не выдано.', invalidated: 'Изменились согласованные условия. Требуется новое решение.',
  invalid_request: 'Описание команды некорректно.', missing_input: 'Не найден исполняемый вход команды.',
  unreadable_input: 'Не удалось прочитать исполняемый вход.', non_regular_input: 'Вход не является обычным файлом.',
  ambiguous_path: 'Путь команды неоднозначен.', outside_project: 'Проектный вход выходит за разрешённый корень.',
  unsupported_command: 'Эта форма команды не поддерживается проверкой согласия.',
  unknown_dependency: 'Известные исполняемые зависимости команды не удалось установить.',
  ambiguous_manifest: 'Конфигурация проекта неоднозначна.', dependency_cycle: 'Найден цикл вызываемых scripts.',
  unstable_input: 'Файлы изменились во время чтения.', limit_exceeded: 'Превышен предел проверки входов.',
  snapshot_failed: 'Не удалось получить проверяемый снимок.',
  separate_authorization_required: 'Для публикации, push или разрушительных действий нужно отдельное разрешение.',
  unknown_challenge: 'Этот запрос согласия больше не действует. Получите новый снимок.',
  stale_challenge: 'Содержимое изменилось после показа согласия. Получите новый снимок.',
};
export function outcomeLabel(result: AgentRunCompletion): string {
  if (result.stopAccepted) return 'Прерывание принято';
  switch (result.kind) {
    case 'success': return 'Ответ получен';
    case 'interrupted': return 'Ход прерван';
    case 'error': return `Ошибка: ${result.detail}`;
    case 'max_turns': return 'Достигнут предел ходов CLI';
    case 'limit': return 'Достигнут лимит';
  }
}

export interface FeedEntry {
  id: string; seq: number; timestamp: string; title: string; text: string;
  tone: 'neutral' | 'warning' | 'error'; truncated: boolean;
}
const TEXT_LIMIT = 64_000;
/** Presentation only. The database retains all pages and complete source events. */
export function presentEvents(events: readonly SoloEvent[]): FeedEntry[] {
  const entries: FeedEntry[] = [];
  const messages = new Map<string, FeedEntry>();
  const turnsWithText = new Set<string>();
  function add(event: SoloEvent, title: string, text: string, tone: FeedEntry['tone'] = 'neutral') {
    const entry: FeedEntry = { id: event.id, seq: event.seq, timestamp: event.timestamp,
      title, text: text.slice(0, TEXT_LIMIT), tone, truncated: text.length > TEXT_LIMIT };
    entries.push(entry); return entry;
  }
  for (const event of events) {
    const payload = event.payload;
    switch (payload.type) {
      case 'user_message': add(event, payload.conversation === 'new' ? 'Вы · новый диалог' : 'Вы', payload.text); break;
      case 'session_state': add(event, statusLabels[payload.status], payload.detail,
        payload.status === 'error' ? 'error' : payload.status === 'recovery_required' ? 'warning' : 'neutral'); break;
      case 'setup': add(event, 'Подготовка workspace', setupLabels[payload.state],
        ['uncertain', 'needs_consent', 'failed'].includes(payload.state) ? 'warning' : 'neutral'); break;
      case 'recovery': add(event, 'Восстановление', payload.detail, payload.code === 'recovered' ? 'neutral' : 'warning'); break;
      case 'diagnostic': add(event, 'Диагностика', `${payload.code}: ${payload.detail}`, 'warning'); break;
      case 'agent': {
        const agent = payload.event;
        if (agent.type === 'text') {
          const key = `${agent.turnId}:${agent.messageId}`;
          const previous = messages.get(key);
          if (!previous) messages.set(key, add(event, 'Ответ', agent.text));
          else {
            const text = agent.mode === 'snapshot' ? agent.text : previous.text + agent.text;
            previous.truncated = agent.mode === 'snapshot' ? text.length > TEXT_LIMIT : previous.truncated || text.length > TEXT_LIMIT;
            previous.text = text.slice(0, TEXT_LIMIT);
          }
          turnsWithText.add(agent.turnId);
        } else if (agent.type === 'run_finished') {
          if (agent.result.kind === 'success' && agent.result.text && !turnsWithText.has(agent.turnId)) {
            add(event, 'Ответ', agent.result.text);
          }
          add({ ...event, id: `${event.id}:result` }, 'Результат хода', outcomeLabel(agent.result),
            agent.result.kind === 'error' ? 'error' : agent.result.stopAccepted || agent.result.kind !== 'success' ? 'warning' : 'neutral');
        } else add(event, agentTitle(agent), agentDetail(agent), agent.type === 'permission_denied' ? 'warning' : 'neutral');
        break;
      }
    }
  }
  return entries;
}
export const setupLabels = {
  not_configured: 'Setup не настроен', pending: 'Ожидает подготовки', needs_consent: 'Нужно согласие на команду',
  running: 'Команда выполняется', completed: 'Подготовка завершена', failed: 'Ошибка подготовки', uncertain: 'Исход подготовки неизвестен',
};
function agentTitle(event: NormalizedPayload): string {
  switch (event.type) {
    case 'run_started': return 'Диалог CLI начат';
    case 'tool_started': return `Инструмент: ${event.tool}`;
    case 'tool_finished': return event.isError ? 'Ошибка инструмента' : 'Инструмент завершён';
    case 'permission_denied': return 'Действие не разрешено';
    case 'retry': return 'Повтор внутри CLI';
    case 'usage': return 'Использование';
    case 'rate_limit': return 'Лимит провайдера';
    default: return 'Событие CLI';
  }
}
function agentDetail(event: NormalizedPayload): string {
  switch (event.type) {
    case 'tool_started': return event.inputPreview;
    case 'permission_denied': return `${event.tool}: ${event.reason}`;
    case 'retry': return event.reason;
    case 'usage': return `Вход: ${event.usage.inputTokens ?? 'неизвестно'} токенов; выход: ${event.usage.outputTokens ?? 'неизвестно'} токенов.`;
    case 'rate_limit': return event.resetAt ? `${event.status}. Сброс: ${event.resetAt}` : event.status;
    default: return '';
  }
}
