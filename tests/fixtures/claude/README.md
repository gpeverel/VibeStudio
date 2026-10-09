# Fixtures протокола Claude CLI (этап 0C)

**Все файлы в этом каталоге — СИНТЕТИЧЕСКИЕ (`origin: synthetic`).** Они написаны вручную (одноразовым скриптом) по форме `--output-format stream-json` из документации Claude Code и сообщений, ранее виденных в разборе протокола. Это НЕ записи настоящей CLI и НЕ доказательство того, что CLI 2.1.295 выдаёт именно такой поток. Обезличенных записей реальной CLI (`origin: real-redacted`) в репозитории пока нет: живой запуск не был разрешён пользователем (см. `docs/STAGE-0C-REPORT.md`, раздел «Незакрытые критерии»).

Когда появятся реальные записи, каждая кладётся в `tests/fixtures/claude/real/` с сопроводительным `<имя>.meta.json`: `origin: "real-redacted"`, версия CLI (`claude --version`), безопасная конфигурация, точный argv, ожидаемые события. Токены, `.env`, пути пользователя и пользовательский код в fixtures не сохраняются.

| Файл | Что моделирует | Ожидание |
|---|---|---|
| `success-simple.jsonl` | init → assistant(snapshot) → result success | `run_started`, текст, usage, success |
| `partial-deltas-then-snapshot.jsonl` | `--include-partial-messages`: дельты, затем полный assistant | текст не дублируется, usage не удваивается |
| `tool-use.jsonl` | tool_use + tool_result | `tool_started`/`tool_finished` с одним `toolCallId`, вход инструмента не попадает в события |
| `tool-error-and-denial.jsonl` | ошибка инструмента + `permission_denials` в result | `tool_finished.isError`, `permission_denied` |
| `unknown-events.jsonl` | неизвестные верхнеуровневые, системные и partial-события, неизвестный блок | диагностика ограничена, успех не ломается |
| `rate-limit.jsonl` | `rate_limit_event` | событие `rate_limit` |
| `retry.jsonl` | `system/api_retry` | событие `retry` |
| `error-max-turns.jsonl` | result `error_max_turns` | `max_turns` |
| `error-execution.jsonl` | result `error_during_execution` | `error` |
| `no-result.jsonl` | поток без result | нет терминального результата |
| `truncated-result.jsonl` | оборванная строка result без LF | не success, `protocol_incompatible` |
| `result-without-lf.jsonl` | валидный result без завершающего LF | success после `end()` |
| `result-malformed-fields.jsonl` | result без обязательного `is_error` | не success |
| `events-after-result.jsonl` | событие после result | `protocol_incompatible` |
| `other-session.jsonl` | другой `session_id` | отказ при заданном `expectedSessionId` |
| `corrupt-middle.jsonl` | повреждённая строка в середине | не success |
| `result-api-error-401/429/529.jsonl` | `subtype: success`, но `is_error: true` и `api_error_status` (по `ResultMessage` в claude-agent-sdk-python) | не success: авторизация / лимит / перегрузка |
| `result-aborted-streaming.jsonl` | `is_error: false`, но `terminal_reason: aborted_streaming` | не success |
| `result-success-is-error-no-status.jsonl` | `subtype: success` при `is_error: true` без кода | не success |
