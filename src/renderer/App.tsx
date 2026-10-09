export function App() {
  return (
    <main className="app-shell">
      <header className="app-header">
        <span className="app-name">{window.api.appName}</span>
        <span className="app-status">Локальная рабочая среда</span>
      </header>
      <section className="empty-state" aria-labelledby="sessions-title">
        <h1 id="sessions-title">Сессии</h1>
        <p>Пока нет активных сессий.</p>
        <p className="muted">Создание рабочих областей появится в следующей версии.</p>
      </section>
    </main>
  );
}
