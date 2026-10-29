import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentKind, ApiResult, EventPage, ProjectView, SessionView, SoloEvent } from '../shared/solo.ts';
import { SessionDetails, Status, StatusSprite } from './components.tsx';
import { createCursorFeed } from './feed.ts';
import { presentEvents } from './presentation.ts';
import { commandLabels, createPendingCommands, invokePendingCommand, type PendingCommand } from './pending-commands.ts';

const api = () => window.api;
function valueOf<T>(result: ApiResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.message} (${result.error.code})`);
  return result.value;
}
function messageOf(error: unknown): string { return error instanceof Error ? error.message : 'Не удалось связаться с приложением.'; }
function initialSelection(): string {
  try { return localStorage.getItem('vibestudio:selected-session') ?? ''; } catch { return ''; }
}
const pendingCommands = createPendingCommands(() => sessionStorage);
function restorePending(): { commands: PendingCommand[]; error: string | null } {
  try { return { commands: pendingCommands.read(), error: null }; }
  catch (error) { return { commands: [], error: messageOf(error) }; }
}

export function App() {
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [sessions, setSessions] = useState<SessionView[]>([]);
  const [projectId, setProjectId] = useState('');
  const [selected, setSelected] = useState(initialSelection);
  const [session, setSession] = useState<SessionView | null>(null);
  const [cli, setCli] = useState<AgentKind>('claude');
  const [title, setTitle] = useState('');
  const [trusted, setTrusted] = useState(false);
  const [events, setEvents] = useState<readonly SoloEvent[]>([]);
  const [cursor, setCursor] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [archive, setArchive] = useState<EventPage | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [newConversation, setNewConversation] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [pending, setPending] = useState(restorePending);
  const [announcement, setAnnouncement] = useState('');
  const busyRef = useRef(false);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const refreshFeed = useRef<() => void>(() => {});
  const composer = useRef<HTMLTextAreaElement>(null);
  const focusComposerAfterAction = useRef(false);

  useEffect(() => {
    if (session?.actions.send && focusComposerAfterAction.current && !busy) {
      focusComposerAfterAction.current = false;
      composer.current?.focus();
    }
  }, [session?.actions.send, session?.status, busy]);

  const refreshLists = useCallback(async () => {
    const [projectResult, sessionResult] = await Promise.all([api().listProjects(), api().listSessions()]);
    const nextProjects = valueOf(projectResult), nextSessions = valueOf(sessionResult);
    setProjects(nextProjects); setSessions(nextSessions);
    setProjectId(previous => nextProjects.some(project => project.id === previous) ? previous : nextProjects[0]?.id ?? '');
    setSelected(previous => nextSessions.some(item => item.id === previous) ? previous : nextSessions[0]?.id ?? '');
  }, []);
  const refreshSession = useCallback(async (id: string) => {
    const result = valueOf(await api().getSession({ sessionId: id }));
    if (selectedRef.current === id) setSession(result);
    setSessions(previous => previous.map(item => item.id === id ? result : item));
  }, []);

  useEffect(() => {
    let active = true;
    void refreshLists().catch(error => { if (active) setError(messageOf(error)); });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = api().onEventsAvailable(() => {
      timer ??= setTimeout(() => { timer = undefined; if (active) void refreshLists().catch(error => setError(messageOf(error))); }, 100);
    });
    return () => { active = false; clearTimeout(timer); unsubscribe(); };
  }, [refreshLists]);

  useEffect(() => {
    setSession(null); setEvents([]); setCursor(0); setTruncated(false); setArchive(null);
    setNewConversation(false); setFeedError(null);
    if (!selected) return;
    try { localStorage.setItem('vibestudio:selected-session', selected); } catch { /* SQLite is authoritative. */ }
    let active = true;
    const feed = createCursorFeed<SoloEvent>({
      read: async after => valueOf(await api().readEvents({ sessionId: selected, after, limit: 100 })),
      changed: snapshot => {
        if (!active) return;
        setEvents(snapshot.events); setCursor(snapshot.cursor); setTruncated(snapshot.truncated); setFeedError(null);
      },
      failed: error => { if (active) setFeedError(messageOf(error)); },
    });
    let refreshing = false;
    const refresh = () => {
      void feed.refresh();
      if (!refreshing) {
        refreshing = true;
        void refreshSession(selected).catch(error => { if (active) setFeedError(messageOf(error)); }).finally(() => { refreshing = false; });
      }
    };
    // Register first, then read. Periodic catch-up also covers lost hints/reconnects.
    const unsubscribe = api().onEventsAvailable(notice => { if (notice.sessionId === selected) refresh(); });
    refreshFeed.current = refresh;
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => { active = false; feed.dispose(); unsubscribe(); clearInterval(timer); refreshFeed.current = () => {}; };
  }, [selected, refreshSession]);

  async function runCommand(command: PendingCommand): Promise<void> {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null);
    let sent = false, answered = false;
    try {
      const previous = pendingCommands.read();
      if (previous.length && command.method !== 'stop' && !previous.some(item => item.request.requestId === command.request.requestId)) {
        setPending({ commands: previous, error: null }); return;
      }
      const commands = pendingCommands.put(command);
      setPending({ commands, error: null });
      // Persist the exact body before IPC. Stop may coexist with an unanswered send/create request.
      const saved = commands.find(item => item.request.requestId === command.request.requestId)!;
      sent = true;
      const result = await invokePendingCommand(api(), saved);
      answered = true;
      setPending({ commands: pendingCommands.acknowledge(saved.request.requestId), error: null });
      if (!result.ok) { setError(`${result.error.message} (${result.error.code})`); return; }
      const value = result.value;
      if (saved.method === 'selectProject' && value && !('requestId' in value)) {
        setProjectId(value.id); setTrusted(false);
      } else if (value && 'requestId' in value) {
        if (value.status === 'failed') setError(value.error?.message ?? 'Действие не выполнено.');
        else if (saved.method === 'createSession' && value.sessionId) { setSelected(value.sessionId); setTitle(''); }
        else if (saved.method === 'sendTurn') {
          const { sessionId, prompt } = saved.request;
          setDrafts(previous => previous[sessionId]?.trim() === prompt ? { ...previous, [sessionId]: '' } : previous);
          setNewConversation(false); composer.current?.focus();
        }
      }
      setAnnouncement(`${commandLabels[saved.method]}: ответ приложения получен.`);
      await refreshLists();
      refreshFeed.current();
    } catch (error) {
      setError(`${answered ? 'Ответ получен, но не удалось обновить окно.' : sent ? 'Ответ на запрос не получен.' : 'Запрос не отправлен.'} ${messageOf(error)}`);
      setPending(restorePending());
    } finally { busyRef.current = false; setBusy(false); }
  }
  function runSession(method: 'prepareSetup' | 'confirmSetup' | 'revokeConsent' | 'stop', extra?: string) {
    if (!session) return;
    const request = { requestId: crypto.randomUUID(), sessionId: session.id };
    if (method === 'confirmSetup') void runCommand({ method, request: { ...request, challengeId: extra! } });
    else if (method === 'revokeConsent') void runCommand({ method, request: { ...request, consentId: extra! } });
    else {
      const existing = method === 'stop' ? pending.commands.find(item => item.method === 'stop' && item.request.sessionId === session.id) : undefined;
      void runCommand(existing ?? { method, request });
    }
  }
  function chooseProject() {
    if (unresolved) return;
    const request = { requestId: crypto.randomUUID() };
    void runCommand({ method: 'selectProject', request });
  }
  function createSession() {
    if (unresolved || !trusted || !projectId) return;
    const request = { requestId: crypto.randomUUID(), projectId, cli, ...(title.trim() ? { title: title.trim() } : {}) };
    void runCommand({ method: 'createSession', request });
  }
  function send() {
    const prompt = (drafts[selected] ?? '').trim();
    if (unresolved || !session || !prompt || !(newConversation ? session.actions.newConversation : session.actions.send)) return;
    const sessionId = session.id;
    const request = { requestId: crypto.randomUUID(), sessionId, prompt, conversation: newConversation ? 'new' as const : 'continue' as const };
    void runCommand({ method: 'sendTurn', request });
  }
  async function loadArchive(after: number) {
    const id = selected;
    setHistoryBusy(true);
    try {
      const page = valueOf(await api().readEvents({ sessionId: id, after, limit: 100 }));
      if (selectedRef.current === id) setArchive(page);
    } catch (error) { setError(messageOf(error)); }
    finally { setHistoryBusy(false); }
  }
  const entries = useMemo(() => presentEvents(archive?.events ?? events), [archive, events]);
  const draft = drafts[selected] ?? '';
  const canSend = session && (newConversation ? session.actions.newConversation : session.actions.send);
  const unresolved = pending.commands.length > 0 || pending.error !== null;

  return <main className="app-shell">
    <StatusSprite />
    <header className="app-header"><span className="app-name">{api().appName}</span><span className="app-status">Solo · локальная рабочая среда</span></header>
    <div className="sr-only" role="status" aria-live="polite">{announcement}</div>
    {error && <div className="notice error-notice" role="alert"><p>{error}</p><div className="actions">
      <button onClick={() => setError(null)}>Скрыть сообщение</button>
    </div></div>}
    {pending.error && <div className="notice error-notice" role="alert"><p>{pending.error}</p><button disabled={busy} onClick={() => setPending(restorePending())}>Перечитать сохранённый запрос</button></div>}
    {pending.commands.length > 0 && <div className="notice" role="status">
      <p>{busy ? 'Ожидается ответ приложения.' : 'Исход прежнего запроса неизвестен. Повтор отправит исходное действие с теми же данными.'}</p>
      <p>{commandLabels[pending.commands[0]!.method]}{pending.commands.length > 1 ? ` · Ожидают ответа: ${pending.commands.length}` : ''}</p>
      <button disabled={busy || Boolean(pending.error)} onClick={() => { void runCommand(pending.commands[0]!); }}>Повторить тот же запрос</button>
    </div>}
    <div className="workspace-layout">
      <aside className="session-sidebar" aria-labelledby="sessions-title">
        <h1 id="sessions-title">Сессии</h1>
        <form className="panel stack" onSubmit={event => { event.preventDefault(); createSession(); }} aria-labelledby="new-session-heading">
          <h2 id="new-session-heading">Новая сессия</h2>
          <button type="button" disabled={busy || unresolved} onClick={chooseProject}>Выбрать проект</button>
          <label>Проект<select value={projectId} disabled={busy || projects.length === 0} onChange={event => { setProjectId(event.target.value); setTrusted(false); }}>
            <option value="">Выберите локальный Git-проект</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select></label>
          <label>CLI участника<select value={cli} disabled={busy} onChange={event => setCli(event.target.value as AgentKind)}><option value="claude">Claude</option><option value="codex">Codex</option></select></label>
          <label>Название<input value={title} maxLength={200} disabled={busy} placeholder="Необязательно" onChange={event => setTitle(event.target.value)} /></label>
          <label className="inline-check"><input type="checkbox" checked={trusted} disabled={busy || !projectId} onChange={event => setTrusted(event.target.checked)} />Я доверяю этому локальному проекту</label>
          <p className="help">Профиль чтения. Настроенный setup потребует отдельного конкретного согласия. Недоступная CLI покажет причину отказа.</p>
          <button className="primary" disabled={busy || unresolved || !projectId || !trusted}>Создать сессию</button>
          {(!projectId || !trusted) && <p className="help">Выберите проект и подтвердите доверие к нему.</p>}
        </form>
        {sessions.length === 0 ? <p className="muted">Пока нет сессий.</p> : <ul className="session-list">{sessions.map(item => <li key={item.id}>
          <button aria-current={selected === item.id ? 'true' : undefined} onClick={() => setSelected(item.id)}>
            <span>{item.title}</span><Status status={item.status} /><span className="event-meta">{item.participant.cli === 'claude' ? 'Claude' : 'Codex'}</span>
          </button>
        </li>)}</ul>}
      </aside>
      <div className="session-panel">
        {!selected && <section className="empty-state"><h2>Один проект, отдельный workspace</h2><p>Создайте сессию, дождитесь подготовки и отправьте задачу. История останется доступна после перезапуска.</p></section>}
        {selected && !session && <p role="status">Загрузка состояния сессии…</p>}
        {session && <>
          <SessionDetails session={session} busy={busy || unresolved}
            prepare={() => runSession('prepareSetup')}
            confirm={challengeId => { focusComposerAfterAction.current = true; runSession('confirmSetup', challengeId); }}
            revoke={consentId => runSession('revokeConsent', consentId)} />
          <section className="panel stack" aria-labelledby="conversation-heading">
            <div className="panel-heading"><h2 id="conversation-heading">{archive ? 'История сессии' : 'Диалог и события'}</h2><span className="event-meta">До события № {archive?.nextCursor ?? cursor}</span></div>
            {feedError && <div className="notice" role="alert">{feedError}<p><button onClick={() => refreshFeed.current()}>Перечитать события</button></p></div>}
            <div className="actions"><button disabled={historyBusy} onClick={() => { void loadArchive(0); }}>История с начала</button>
              {archive && <><button disabled={historyBusy || !archive.hasMore} onClick={() => { void loadArchive(archive.nextCursor); }}>Следующая страница</button><button onClick={() => setArchive(null)}>К последним событиям</button></>}
            </div>
            {!archive && truncated && <p className="help">Показаны последние 300 событий. Ранние события сохранены в истории.</p>}
            {(archive || truncated) && <p className="help">Сообщение на границе страницы может быть неполным: его начало или продолжение сохранены на соседних страницах истории.</p>}
            <div role="log" aria-label="События сессии" aria-live="off" tabIndex={0}>
              {entries.length === 0 ? <p className="muted">События появятся здесь после подготовки или отправки задачи.</p> : <ol className="feed">{entries.map(entry => <li key={entry.id} className="feed-entry">
                <div className="panel-heading"><h3 className={entry.tone === 'error' ? 'status-error' : entry.tone === 'warning' ? 'status-warning' : undefined}>{entry.title}</h3><span className="event-meta">№ {entry.seq} · <time dateTime={entry.timestamp}>{new Date(entry.timestamp).toLocaleTimeString('ru')}</time></span></div>
                {entry.text && <div className="event-text">{entry.text}</div>}
                {entry.truncated && <p className="help">Показаны первые 64 000 символов сообщения. Полный текст сохранён в истории приложения.</p>}
              </li>)}</ol>}
            </div>
          </section>
          <form className="panel composer" onSubmit={event => { event.preventDefault(); send(); }}>
            <label htmlFor="prompt">Задача или следующий вопрос</label>
            <textarea id="prompt" ref={composer} value={draft} maxLength={64_000} disabled={busy} aria-describedby="prompt-help action-reason"
              onChange={event => { setDrafts(previous => ({ ...previous, [selected]: event.target.value })); event.target.style.height = 'auto'; event.target.style.height = `${event.target.scrollHeight}px`; }}
              onFocus={event => event.currentTarget.scrollIntoView({ block: 'nearest' })}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); send(); }
              }} />
            <p id="prompt-help" className="help">Return — отправить, Shift+Return — новая строка.</p>
            {session.actions.newConversation && session.participant.context !== 'new' && <label className="inline-check"><input type="checkbox" checked={newConversation} onChange={event => setNewConversation(event.target.checked)} disabled={busy} />Начать новый диалог без прежнего контекста CLI</label>}
            <p id="action-reason" className="help">{canSend ? newConversation ? 'Прежняя история останется в ленте, но не будет передана CLI.' : 'Сообщение получит закреплённая за участником CLI.' : session.actions.reason ?? 'Отправка пока недоступна.'}</p>
            <div className="actions"><button className="primary" disabled={busy || unresolved || !canSend || !draft.trim()}>{newConversation ? 'Начать новый диалог' : 'Отправить'}</button>
              <button type="button" disabled={busy || !session.actions.stop} onClick={() => { focusComposerAfterAction.current = true; runSession('stop'); }}>Остановить</button>
            </div>
          </form>
        </>}
      </div>
    </div>
  </main>;
}
