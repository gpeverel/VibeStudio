import type { ProcessCompletion } from '../shared/agent.ts';
import type { SessionStatus, SessionView } from '../shared/solo.ts';
import { consentReasonLabels, limitationLabels, outcomeLabel, setupLabels, statusLabels } from './presentation.ts';

export function StatusSprite() {
  return <svg className="sr-only" aria-hidden="true"><defs>
    <symbol id="status-circle" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" /></symbol>
    <symbol id="status-unknown" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2 2" /></symbol>
    <symbol id="status-check" viewBox="0 0 16 16"><path d="m3 8 3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2" /></symbol>
    <symbol id="status-error" viewBox="0 0 16 16"><path d="m4 4 8 8m0-8-8 8" fill="none" stroke="currentColor" strokeWidth="2" /></symbol>
  </defs></svg>;
}
export function Status({ status }: { status: SessionStatus }) {
  const tone = status === 'answered' ? 'success' : status === 'error' ? 'error'
    : ['recovery_required', 'needs_consent', 'interrupted'].includes(status) ? 'warning'
      : ['running', 'preparing', 'stopping'].includes(status) ? 'active' : 'neutral';
  const icon = tone === 'success' ? 'check' : tone === 'error' ? 'error' : tone === 'warning' ? 'unknown' : 'circle';
  return <span className={`status status-${tone}`}>
    <svg className="status-icon" aria-hidden="true"><use href={`#status-${icon}`} /></svg>{statusLabels[status]}
  </span>;
}
export function ProcessDetails({ completion }: { completion: ProcessCompletion }) {
  const process = completion.process;
  return <details>
    <summary>Завершение процесса: {process.state === 'exited' ? 'выход подтверждён'
      : process.state === 'not_started' ? 'не запускался' : 'не подтверждено'}</summary>
    <dl className="detail-list">
      <dt>Основной процесс</dt><dd>{process.state === 'exited' ? `Код: ${process.exitCode ?? 'нет'}; сигнал: ${process.signal ?? 'нет'}`
        : process.state === 'not_started' ? 'Запуск не состоялся' : 'Принадлежность или выход не подтверждены'}</dd>
      <dt>Потоки</dt><dd>stdout: {completion.stdout}; stderr: {completion.stderr}</dd>
      <dt>Ожидание</dt><dd>{completion.wait === 'deadline' ? 'Истёк срок ожидания' : 'Завершено'}</dd>
    </dl>
    {completion.signals.length > 0 && <ul>{completion.signals.map((signal, i) => <li key={i}>
      {signal.signal}: {signal.status === 'sent' ? 'отправлен' : signal.status === 'failed' ? 'ошибка отправки' : 'цель не найдена'}
      {signal.errorCode ? ` (${signal.errorCode})` : ''}
    </li>)}</ul>}
    {completion.issues.length > 0 && <ul>{completion.issues.map((issue, i) => <li key={i}>{issue.code}: {issue.detail}</li>)}</ul>}
    <p className="help">Даже подтверждённый выход основного процесса не гарантирует остановку отделившихся потомков.</p>
  </details>;
}

export function SessionDetails({ session, busy, prepare, confirm, revoke }: {
  session: SessionView; busy: boolean; prepare(): void; confirm(challengeId: string): void; revoke(consentId: string): void;
}) {
  const decision = session.setup.decision;
  const execution = session.setup.execution;
  return <>
    <section className="panel stack" aria-labelledby="session-heading">
      <div className="panel-heading"><h2 id="session-heading">{session.title}</h2><Status status={session.status} /></div>
      <p>{session.detail}</p>
      <dl className="detail-list">
        <dt>Участник</dt><dd>{session.participant.cli === 'claude' ? 'Claude' : 'Codex'} · {session.participant.profile}</dd>
        <dt>Workspace</dt><dd>{session.workspace.branch || 'Ветка ещё не создана'} · {workspaceLabels[session.workspace.state]}</dd>
        <dt>Контекст CLI</dt><dd>{contextLabels[session.participant.context]}</dd>
      </dl>
      {session.status === 'recovery_required' && <div className="notice" role="status">
        Исход прежней операции не подтверждён. Новый запуск заблокирован; приложение не повторяет setup и не завершает процессы по старому PID.
      </div>}
      {session.participant.context === 'missing' && <div className="notice">
        История CLI потеряна. Продолжить прежний диалог нельзя. Можно явно начать новый диалог, если workspace свободен. Лента приложения сохранена.
      </div>}
      {session.result && <div><h3>Результат задачи</h3><p>{outcomeLabel(session.result)}</p><ProcessDetails completion={session.result.completion} /></div>}
      <details><summary>Права и ограничения профиля</summary>
        <p>Доступен только поддержанный профиль чтения. CLI закреплена за участником; история не переносится между Claude и Codex.</p>
        <ul>{session.limitations.map(limit => <li key={limit}>{limitationLabels[limit] ?? limit}</li>)}</ul>
      </details>
    </section>
    {session.setup.state !== 'not_configured' && <section className="panel stack" aria-labelledby="setup-heading">
      <div className="panel-heading"><h2 id="setup-heading">Подготовка проекта</h2><span>{setupLabels[session.setup.state]}</span></div>
      <p>Команда: <code>{session.setup.command ?? 'не определена'}</code></p>
      <p className="help">Подготовку выполняет локальная команда от имени текущего пользователя. Её права показаны ниже и отличаются от профиля чтения модели.</p>
      {execution ? <dl className="detail-list">
        <dt>Рабочий каталог</dt><dd><code>{execution.cwd}</code></dd>
        <dt>Версия настроек</dt><dd>{execution.configVersion}</dd>
        <dt>Доступ к файлам</dt><dd>{fileSystemLabels[execution.permissions.fileSystem]}</dd>
        <dt>Сеть</dt><dd>{execution.permissions.network === 'allowed' ? 'Разрешена' : 'Запрещена'}</dd>
        <dt>Повышенные права</dt><dd>{execution.permissions.elevated ? 'Запрошены' : 'Не запрошены'}</dd>
        <dt>Окружение</dt><dd>{execution.environmentNames.length ? execution.environmentNames.join(', ') : 'Пустое'}</dd>
      </dl> : <p className="notice">Область запуска не получена. Проверьте подготовку перед подтверждением.</p>}
      {decision && <>
        {decision.status !== 'allowed' && <p className="notice">{consentReasonLabels[decision.reason] ?? decision.reason} <code>{decision.reason}</code></p>}
        {'fingerprint' in decision && <p className="help">Снимок: <code>{decision.fingerprint}</code></p>}
        <details open={decision.status === 'needs_consent'}><summary>Область конкретного согласия</summary>
          <p>Только эта команда setup, её аргументы, рабочий каталог, права, окружение и известные исполняемые входы. Изменение условий требует нового согласия.</p>
          <ul className="consent-inputs">{decision.coverage.inputs.map((input, i) => <li key={`${input.path}:${i}`}>
            <code>{input.path}</code> · {input.digest ? <code>{input.digest}</code> : 'файл отсутствовал'}
          </li>)}</ul>
          <ul>{decision.coverage.limitations.map(limit => <li key={limit}>{limitationLabels[limit] ?? limit}</li>)}</ul>
          <p>Согласие на setup не разрешает push, публикацию или разрушительные операции.</p>
        </details>
      </>}
      {session.setup.state === 'completed' && decision?.status !== 'allowed' && <p className="notice">
        Подготовка уже выполнена. Изменение или отзыв согласия не запускает её повторно; для новой подготовки создайте новую сессию с отдельным workspace.
      </p>}
      <div className="actions">
        {decision?.status === 'needs_consent' && session.actions.prepareSetup && <button className="primary" disabled={busy || !execution} onClick={() => confirm(decision.challengeId)}>Подтвердить эту подготовку</button>}
        {decision?.status === 'allowed' && <button disabled={busy || session.setup.state === 'running'} onClick={() => revoke(decision.consentId)}>Отозвать согласие</button>}
        {session.actions.prepareSetup && <button disabled={busy} onClick={prepare}>Проверить подготовку</button>}
      </div>
      {session.setup.completion && <ProcessDetails completion={session.setup.completion} />}
    </section>}
  </>;
}
const workspaceLabels = { creating: 'создаётся', ready: 'готов', missing: 'не найден', uncertain: 'состояние не подтверждено' };
const contextLabels = { new: 'Новый диалог', available: 'Можно продолжить', missing: 'История потеряна', unknown: 'Доступность истории не подтверждена' };
const fileSystemLabels = { 'read-only': 'Только чтение', 'workspace-write': 'Запись в workspace', unrestricted: 'Не ограничен песочницей' };
