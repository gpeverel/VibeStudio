# Этап 0C: протокол Claude CLI, диагностика, профиль доступа — отчёт

Дата: 2026-10-09. Окружение: Node `v24.15.0` (через `scripts/with-node.sh`), npm `12.2.0`, существующий lockfile; зависимости и lockfile не менялись. Работали три воркера: A (порты и адаптеры, конфигурация), B (тесты, fixtures, стенд, этот отчёт, итоговые прогоны), C (сборщик инструкций §12 и план живых проб).

## Итог в трёх строках

| | Статус |
|---|---|
| Реализация | **Готова** (диагностика, запуск, парсер, жизненный цикл процесса, профиль read-only с fail-closed запуском). |
| Автоматические тесты | **Пройдены** (результаты команд — ниже). Они синтетические и проверяют наш код, а не поведение настоящей CLI. |
| Живая приёмка | **НЕ подтверждена и НЕ выполнялась.** Явного разрешения на запуск Claude нет. Первый ход, сохраняемый запуск, resume и границы доступа реальной CLI остаются **незакрытыми**. |

Этап 0C **не завершён** по критерию §10: «подтверждены первый ход и resume», «правки через script/symlink/hook/MCP не обходят выбранный профиль» — пока проверены только на синтетике.

## Изменённые и добавленные файлы

| Файл | Владелец | Назначение |
|---|---|---|
| `src/core/ports/agent.ts`, `src/shared/agent.ts` | A | Порт `AgentAdapter`, `AccessProfile`, события и результаты (закрытые union, без `Promise<unknown>`) |
| `src/core/ports/process-runner.ts` | A | Порт `ProcessRunner` (`start` → `ProcessRun`: раздельные stdout/stderr, `interrupt`/`kill`/`done`) |
| `src/adapters/process-runner/{index,queue}.ts` | A | Запуск без shell, своя POSIX-группа процессов, ограниченные очереди, таймауты |
| `src/adapters/claude/{index,args,detect,parser,profile}.ts` | A | Адаптер, сборка argv/stdin/env, диагностика, парсер потока, проверка профиля |
| `src/core/agent-instructions.ts`, `docs/STAGE-0C-PROMPTS.md` | C | Инструкции первого запуска/resume и их происхождение (§12) |
| `docs/STAGE-0C-LIVE-PLAN.md` | C | Спецификация живых проб |
| `package.json` (`test:live`), `tsconfig.node.json`, `vitest.live.config.ts` | A | Отдельный вход живых проб, вне `npm test` |
| `tests/claude/*.test.ts` (7 файлов, 157 тестов) | B | Тесты 0C |
| `tests/helpers/claude/{fake-claude.mjs,stand.ts,requests.ts,access-stand.ts}` | B | Двойник CLI, временный стенд, стенд границ доступа |
| `tests/fixtures/claude/*` (21 JSONL + `README.md`) | B | Синтетические fixtures с описанием происхождения |
| `tests/live/claude-live.live.ts` | B | Живой сценарий (только `LIVE=1`) |
| `tests/spec-boundaries.md` | B | Добавлен раздел «Покрытие этапа 0C» |
| `docs/STAGE-0C-REPORT.md` | B | Этот отчёт |

Существующие Git-файлы, UI и Git-тесты не менялись.

## Контракт

* `AgentAdapter.detect(options?) → Promise<AgentDetection>`: `status`, `binaryPath`, `version`, `auth` (`authenticated|unauthenticated|unknown`), `capabilities` (в том числе `readOnly: verified|unverified|unsupported`), `unavailable[]` с причиной из закрытого `AgentErrorReason` (`binary_missing`, `not_authenticated`, `capability_missing`, `profile_unverified`, …).
* `AgentAdapter.start(request) → Promise<AgentRun>`; `AgentRun = { events, interrupt(), kill(), done, diagnostics }`; `interrupt`/`kill` — `Promise<void>`, идемпотентны.
* `AgentRunRequest`: `sessionId` (ID приложения), `turnId`, `participantId`, `workspaceId`, `cwd`, `prompt`, `agentSessionId` (UUID диалога CLI), `resume`, `profile`, `model?`, `maxTurns?`, `env`, `persistSession?`. Первый ход → `--session-id <agentSessionId>`, продолжение → `--resume <тот же agentSessionId>`; `turnId` в argv не попадает.
* `AccessProfile`: `mode: 'read-only'`, закрытый `tools` (`Read|Glob|Grep`), `allow/deny`, `configPolicy` (пустые `settingSources`, `loadHooks/Mcp/Plugins: false`), `fs` (корни чтения/записи, защищённые пути, Git-каталог), `network`. Это не строка permission mode.
* События §4: `run_started`, `text` (delta/snapshot с `messageId`), `tool_started`/`tool_finished` (`toolCallId`), `permission_denied`, `retry`, `usage` (`mode: 'snapshot'`), `rate_limit`, `run_finished`; конверт `schemaVersion/eventId/sessionId/turnId/participantId/seq/timestamp`. Итог: `success|error|max_turns|interrupted|limit`; причина ошибки — закрытый union.
* `start` блокируется **до создания процесса**, если: профиль ослаблен; нет бинарника/авторизации/обязательной возможности; нет доверенного `verifyAccess` с `status: 'verified'` и непустым `evidence`. **Штатного `AccessVerifier` в 0C нет**, поэтому производственный запуск по умолчанию отклоняется с `profile_unverified`.
* Argv (`buildClaudeArgs`): `--print --verbose --input-format text --output-format stream-json --include-partial-messages --restricted --safe-mode --setting-sources '' --strict-mcp-config --mcp-config '{"mcpServers":{}}' --tools Read,Glob,Grep --permission-mode dontAsk --permission-prompts none --disable-slash-commands --no-chrome --disallowedTools … --system-prompt-snapshot off --append-system-prompt <инструкции> --session-id|--resume <uuid>`; промпт — только stdin; `--bare` не используется. Окружение — allowlist (`HOME, PATH, USER, LOGNAME, LANG, LC_ALL, LC_CTYPE, TMPDIR, CLAUDE_CONFIG_DIR, ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN`) плюс `DISABLE_AUTOUPDATER=1`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`.

## Происхождение fixtures

Все 21 файл в `tests/fixtures/claude/` — **синтетические** (`origin: synthetic`), написаны вручную по форме stream-json из документации и SDK (`ResultMessage.api_error_status`, `terminal_reason`: <https://raw.githubusercontent.com/anthropics/claude-agent-sdk-python/main/src/claude_agent_sdk/types.py>). Это НЕ записи настоящей CLI 2.1.295. Обезличенных записей реальной CLI (`real-redacted`) **нет**: живые вызовы не разрешались. Таблица файлов — `tests/fixtures/claude/README.md`. Формат `real-redacted` (версия CLI, безопасная конфигурация, argv, ожидаемые события) описан там же; живой сценарий пишет такие артефакты в `os.tmpdir()/vs-live-<ts>/`, перенос в репозиторий — только после просмотра. В fixtures нет токенов, `.env` и пользовательского кода.

## Источники инструкций (§12) и адаптации

Подробно — `docs/STAGE-0C-PROMPTS.md` (C). Использованы `prompts/README.md`, `REPORT.md`, `worker-first-task.md`, `session-followup.md`, `shared-language.md` из `/Users/nishimata/Desktop/site/VibeForgeInfo`. Адаптации: исключены заголовок/описание/notes, имя сессии, английская ветвь языка, исследовательские обозначения, утверждения о причинах завершения прошлого хода, восстановлении и обработчиках маркеров. Тестами (`instructions.test.ts`, 8 штук) проверены обе ветви, отсутствие `⟦…⟧`, плейсхолдеров, обещаний harness/отката/sandbox и имён инструментов шире read-only. Принято решение: инструкции идут через `--append-system-prompt`, пользовательский `prompt` — только stdin; для смены вводной на resume нужен `--system-prompt-snapshot off` — его применение в живой CLI **не подтверждено**.

## Реальные результаты команд

Node `v24.15.0`, `sh scripts/with-node.sh …`, рабочая копия сессии:

| Команда | Результат |
|---|---|
| Исходное состояние `npm run test:node` (до правок 0C) | exit 0, **78 из 78** Git-тестов, 0 skipped (≈175 с) — отчёт 0B подтверждён |
| `npm run test:node` (итог) | exit 0, **78/78**, fail 0, cancelled 0, skipped 0, todo 0 |
| `npm test` | exit 0, **8 файлов, 235 тестов** (78 Git через `spec-boundaries.test.ts` + 157 тестов 0C), без skip |
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 (`--max-warnings 0`) |
| `npm run check:boundaries` | exit 0, нарушений нет (31 модуль, 48 зависимостей); предупреждение no-orphans по `agent-instructions.ts` исчезло после подключения в адаптер |
| `npm run build` | exit 0 |
| `npm run smoke` | exit 0: «Проверка окна Electron и preload пройдена» |
| `git diff --check` | exit 0 |
| Повторяемость `npx vitest run tests/claude` | 3 прогона подряд: 157/157 |

SQLite-пробы не повторялись: зависимости и среда не менялись. Ошибок окружения не наблюдалось.

После последних правок A повторно выполнены `npm test` (235/235, exit 0), `typecheck`, `lint`, `check:boundaries` (31 модуль / 48 зависимостей) и `git diff --check` — все exit 0. `test:node`, `build`, `smoke` прогонялись на том же Git-коде (его никто не менял) и производственных файлах 0C до этих правок.

Проверка чувствительности тестов (мутации на копии `src` во временном каталоге, исходные файлы не затрагивались): молчаливое принятие повреждённой JSONL-строки → упали 5 тестов; снятие проверки «ненулевой exit после success» → упал тест; замена `--restricted/--safe-mode` на `--bare` → упал тест профиля.

## Проверенные версии и возможности CLI

Проверено **без модельных вызовов** на `/opt/homebrew/bin/claude`:

* `--version` → `2.1.295 (Claude Code)`, exit 0. В PATH оболочки есть и другая установка (`~/.nvm/versions/node/v24.15.0/bin/claude`) — вывод относится только к `/opt/homebrew/bin/claude`.
* `--help` показывает `--print`, `--output-format`/`stream-json`, `--include-partial-messages`, `--restricted`, `--safe-mode`, `--tools`, `--setting-sources`, `--strict-mcp-config`, `--mcp-config`, `--permission-mode`, `--permission-prompts`, `--session-id`, `--resume`, `--no-session-persistence`, `--append-system-prompt`, `--system-prompt-snapshot`, `--disable-slash-commands`, `--no-chrome`, `--disallowedTools`/`--allowedTools`.
* `claude auth status` для текущего пользователя вернул `loggedIn: true` (authMethod claude.ai) — только факт входа; содержимое в отчёт не переносится.
* **`--max-turns` в `--help` 2.1.295 отсутствует.** Совместимость не подтверждена: `maxTurns` не считается поддерживаемой возможностью, `detect.capabilities.maxTurns` выводится только из help, а запрос с `maxTurns` блокируется при отсутствии флага. Живой сценарий `maxTurns` не передаёт.
* Наличие флага в help — только объявленный интерфейс, а не доказательство эффекта (`readOnly` остаётся `unverified`).

## Границы гарантий

* Тесты `access-profile.test.ts` проверяют **argv и окружение**, а не то, что CLI их выполняет. «Закрытый `--tools`», «пустые источники настроек/MCP» и «без `--bare`» доказаны как факт сборки команды, но не как ограничение реальной CLI.
* `access-stand.test.ts` доказывает лишь, что стенд (script/hook/MCP/symlink/общий Git-каталог) **чувствителен**: изменения контрольных файлов, маркеров, refs и config обнаруживаются, и сравнение «до/после» после живой пробы будет осмысленным. Это не проверка CLI.
* `ProcessRunner` управляет **POSIX-группой** процессов текущего запуска (SIGTERM → SIGKILL, дренирование ограничено). Потомки, вышедшие из группы (`setsid`/`detached`), и восстановление после перезапуска приложения вне гарантии и вне 0C.
* Worktree не является песочницей; общий Git-каталог — отдельный ресурс. Профиль read-only не даёт Bash, но изоляция Git refs обеспечивается только отсутствием инструмента; доказательство — живая проба (сценарий 05).
* Остановка (`interrupt`/`kill`) после получения `result`, но до выхода процесса, даёт `interrupted`, а не «Готово»; stderr никогда не попадает в события и диагностику, остаётся только факт и размер.
* `costUsd` при resume — оценка всей беседы, а не нового хода; контракт этого не разделяет (зафиксировано как ограничение).
* Нет штатного `AccessVerifier`: даже при успешной живой пробе решение «`readOnly = verified`» должно быть внесено осознанно (привязка к версии CLI, авторизации, профилю, cwd, env). Автоматически оно не выдаётся.

## Что не закрыто (критерии, требующие живой CLI)

1. Первый короткий ход без сохранения (init → текст → result → exit 0, транскрипта нет).
2. Отдельный сохраняемый запуск с фиксацией `session_id`.
3. **Resume** с проверкой, что контекст продолжен (метка не передаётся повторно).
4. Эффект `--restricted/--safe-mode/--setting-sources ''/--strict-mcp-config/--tools` на реальной CLI: script, symlink, общий Git-каталог, hooks, MCP, plugins (plugins в стенде не моделируются — отдельно не проверено).
5. Совместимость `--bare`/`--safe-mode` с используемой авторизацией (OAuth/Keychain) — `--bare` намеренно не используется; `--safe-mode`+`--restricted` проверены только как наличие флагов и успешный `auth status` без модели.
6. Применение изменяемой инструкции при resume (`--system-prompt-snapshot off`).
7. Реальные записи CLI (`real-redacted`) для fixtures.
8. `--max-turns`: поддержка не подтверждена.

## Запрос разрешения на живые вызовы (не выдан)

Прошу явного разрешения пользователя. Условия сценария (`tests/live/claude-live.live.ts`, `docs/STAGE-0C-LIVE-PLAN.md`):

* **Команда:** `LIVE=1 sh scripts/with-node.sh npm run test:live` (последовательно, `bail:1`, `retry:0`; бинарник `/opt/homebrew/bin/claude`, переопределяется `CLAUDE_BIN`).
* **Объём:** 6 запусков настоящей CLI, каждый — 1–3 хода модели; таймаут запуска 90 с; повторов нет. Возможный расход: лимит подписки claude.ai (или баланс API при `ANTHROPIC_API_KEY`); денежного потолка у `--max-turns` нет (флаг не используется), ограничение — только таймаут и формулировки промптов.
* **Запись:** одноразовый каталог в `os.tmpdir()` (`main/` Git-репозиторий, `worktree/`, `outside/`, `markers/`, `artifacts/`) — удаляется в конце; обезличенные артефакты — в `os.tmpdir()/vs-live-<ts>/`. **Вне tmp:** сохраняемые запуски (2 и 3) создают транскрипт в штатном каталоге CLI (`~/.claude/projects/…`) и могут обновлять служебное состояние авторизации; запуски 1, 4–6 идут с `--no-session-persistence`. Транскрипты CLI тестом **не удаляются**, чужие не читаются (только `readdir` каталога проектов на наличие файла нужного UUID).
* **Не затрагиваются:** пользовательские проекты, основная копия VibeStudio, `.env`, сеть кроме провайдера CLI.
* **Атаки стенда** используют только собственные безопасные скрипты в tmp, без сетевого кода.
* До запуска автоматически проверяется, что `LIVE=1`; в обычном CI и в `npm test` сценарий не участвует.

Пока разрешения нет, живую приёмку считаем **не подтверждённой**.
