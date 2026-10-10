# Этап 0C: протокол Claude CLI, диагностика, профиль доступа — отчёт

Дата: 2026-10-09; доработка B (live-runner, стенд, отчёт) и сверка с аудитом C/A: 2026-10-10. Окружение: Node `v24.15.0` (через `scripts/with-node.sh`), npm `12.2.0`, существующий lockfile; зависимости и lockfile не менялись. Работали три воркера: A (порты и адаптеры, конфигурация), B (тесты, fixtures, стенд, этот отчёт, итоговые прогоны), C (сборщик инструкций §12 и план живых проб).

Продолжение 2026-10-10 одним агентом: согласованные живые пробы выполнены один раз после технического расширения прав через Codex. Выполнены 4 модельных запуска CLI и один --version; первые три пробы прошли, четвёртая остановила набор. Подробные фактические результаты — в последнем разделе. Исторические разделы ниже сохранены с прежними результатами.

## Текущее состояние

Последнее исследование профиля доступа: [STAGE-0C-ISOLATION.md](STAGE-0C-ISOLATION.md), результаты — в заключительном разделе этого отчёта. Новых модельных вызовов в исследовании нет. Итоговая автоматическая проверка: **257/257**. Простая path-only Seatbelt-граница отклонена по воспроизведённому hardlink-обходу; AccessVerifier остаётся неподключённым.

| | Статус |
|---|---|
| Реализация | Профиль остаётся fail-closed: обеспеченных fs/network/managed-границ нет, штатный AccessVerifier не добавлен. |
| Smoke | SIGABRT воспроизведён в sandbox инструментов; GUI-запуск с техническим расширением прав проходит при сохранённом sandbox renderer. |
| Живая приёмка | Первый ход, сохранение и resume подтверждены. Проба script провалилась из-за safeguards/API error; symlink/Git/hooks/MCP/plugins не исполнены после bail. Во всех init присутствуют builtin plugins. |
| Fixtures | 21 синтетическая запись отдельно от четырёх просмотренных real-redacted в tests/fixtures/claude/real/. |

Этап 0C **не завершён**: успех первых ходов не обеспечивает изоляцию; критерии доступа §3/§10 остаются открытыми. Перехода к этапу 1 нет.

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
| `tests/claude/*.test.ts` (8 файлов, 174 теста) | B, затем C | Тесты 0C; C добавил 6 проверок снимка и 4 проверки сохранения stdout |
| `tests/helpers/claude/{fake-claude.mjs,stand.ts,requests.ts,access-stand.ts}` | B | Двойник CLI, временный стенд, стенд границ доступа (2026-10-10: plugin-приманка, права/размер, состав общего Git-каталога, цель симлинка) |
| `tests/helpers/claude/probe-output.ts`, `tests/claude/probe-output.test.ts` | C | Ограниченный сбор сырого stdout до парсинга; регрессии ошибки протокола и byte-бюджета |
| `tests/fixtures/claude/*` (21 JSONL + `README.md`) | B | Синтетические fixtures с описанием происхождения |
| `tests/live/claude-live.live.ts` | B, затем C | Живой сценарий (только `LIVE=1`): 7 модельных запусков + `--version`; сохранение ошибочного события, отдельный turnId, контроль без восстановления |
| `tests/spec-boundaries.md` | B | Добавлен раздел «Покрытие этапа 0C» |
| `docs/STAGE-0C-REPORT.md` | B, затем C | Этот отчёт |

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

Все 21 JSONL непосредственно в `tests/fixtures/claude/` — **синтетические** (`origin: synthetic`), написаны вручную по форме stream-json из документации и SDK (`ResultMessage.api_error_status`, `terminal_reason`: <https://raw.githubusercontent.com/anthropics/claude-agent-sdk-python/main/src/claude_agent_sdk/types.py>). Это НЕ записи настоящей CLI 2.1.295. В прежнем прогоне реальных записей не было; в текущем продолжении добавлены четыре просмотренные записи в отдельный real/ (см. последний раздел). Таблица файлов — `tests/fixtures/claude/README.md`. Формат `real-redacted` (версия CLI, безопасная конфигурация, argv, ожидаемые события) описан там же; живой сценарий пишет такие артефакты в `os.tmpdir()/vs-live-<ts>/`, перенос в `tests/fixtures/claude/real/` — только после просмотра. В fixtures нет токенов, `.env` и пользовательского кода; фиктивных реальных записей не добавлено.

## Источники инструкций (§12) и адаптации

Подробно — `docs/STAGE-0C-PROMPTS.md` (C). Использованы `prompts/README.md`, `REPORT.md`, `worker-first-task.md`, `session-followup.md`, `shared-language.md` из `/Users/nishimata/Desktop/site/VibeForgeInfo`. Адаптации: исключены заголовок/описание/notes, имя сессии, английская ветвь языка, исследовательские обозначения, утверждения о причинах завершения прошлого хода, восстановлении и обработчиках маркеров. Тестами (`instructions.test.ts`, 8 штук) проверены обе ветви, отсутствие `⟦…⟧`, плейсхолдеров, обещаний harness/отката/sandbox и имён инструментов шире read-only. Принято решение: инструкции идут через `--append-system-prompt`, пользовательский `prompt` — только stdin; для смены вводной на resume нужен `--system-prompt-snapshot off` — его применение в живой CLI **не подтверждено**.

## Предыдущие результаты команд (B, до заключительной доработки C)

Node `v24.15.0`, `sh scripts/with-node.sh …`, рабочая копия сессии. Исходное состояние (до правок B 2026-10-10) подтверждено текущим прогоном: `npm run test:node` 78/78, `npm test` 235/235. Итоговый прогон после доработки (2026-10-10, одним скриптом подряд; из-за дублирующего запуска команды выполнены дважды, результаты совпали):

| Команда | Результат |
|---|---|
| `npm run test:node` (исходное и итоговое) | exit 0, **78/78**, fail 0, cancelled 0, skipped 0, todo 0 (≈138 с) |
| `npm test` (исходное) | exit 0, 8 файлов, **235/235** |
| `npm test` (итог) | exit 0, 8 файлов, **242/242** (78 Git + 164 теста 0C: прежние 157 + 7 новых проверок чувствительности стенда), без skip |
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 (`--max-warnings 0`) |
| `npm run check:boundaries` | exit 0, нарушений нет (31 модуль, 49 зависимостей) |
| `npm run build` | exit 0 |
| `npm run smoke` | exit 0: «Проверка окна Electron и preload пройдена» |
| Запуск живого сценария без `LIVE=1` | отказ сразу при загрузке файла (модель не вызывалась) — ожидаемо |

После правки A (общая причина `profile_unverified`, комментарий `AccessVerification`) A отдельно прогнал `detect.test.ts` + `adapter-lifecycle.test.ts`: 49/49; полный итоговый прогон B выполнен уже с этой правкой. Зависимости, lockfile и среда не менялись, поэтому SQLite-пробы под Node и Electron не повторялись.

Проверка чувствительности тестов (мутации на копии `src` во временном каталоге, исходные файлы не затрагивались): молчаливое принятие повреждённой JSONL-строки → упали 5 тестов; снятие проверки «ненулевой exit после success» → упал тест; замена `--restricted/--safe-mode` на `--bare` → упал тест профиля.

## Проверенные версии и возможности CLI

Исторически проверено **без модельных вызовов** на `/opt/homebrew/bin/claude`; C в заключительном прогоне настоящую CLI не запускал:

* `--version` → `2.1.295 (Claude Code)`, exit 0. В PATH оболочки есть и другая установка (`~/.nvm/versions/node/v24.15.0/bin/claude`) — вывод относится только к `/opt/homebrew/bin/claude`.
* `--help` показывает `--print`, `--output-format`/`stream-json`, `--include-partial-messages`, `--restricted`, `--safe-mode`, `--tools`, `--setting-sources`, `--strict-mcp-config`, `--mcp-config`, `--permission-mode`, `--permission-prompts`, `--session-id`, `--resume`, `--no-session-persistence`, `--append-system-prompt`, `--system-prompt-snapshot`, `--disable-slash-commands`, `--no-chrome`, `--disallowedTools`/`--allowedTools`.
* `claude auth status` для текущего пользователя вернул `loggedIn: true` (authMethod claude.ai) — только факт входа; содержимое в отчёт не переносится.
* **`--max-turns` в `--help` 2.1.295 отсутствует.** Совместимость не подтверждена: `maxTurns` не считается поддерживаемой возможностью, `detect.capabilities.maxTurns` выводится только из help, а запрос с `maxTurns` блокируется при отсутствии флага. Живой сценарий `maxTurns` не передаёт.
* Наличие флага в help — только объявленный интерфейс, а не доказательство эффекта (`readOnly` остаётся `unverified`).

## Границы гарантий

* Тесты `access-profile.test.ts` проверяют **argv и окружение**, а не то, что CLI их выполняет. «Закрытый `--tools`», «пустые источники настроек/MCP» и «без `--bare`» доказаны как факт сборки команды, но не как ограничение реальной CLI.
* `access-stand.test.ts` доказывает лишь, что стенд (script/hook/MCP/symlink/общий Git-каталог) **чувствителен**: изменения контрольных файлов, маркеров, refs и config обнаруживаются, и сравнение «до/после» после живой пробы будет осмысленным. Это не проверка CLI.
* `ProcessRunner` управляет **POSIX-группой** процессов текущего запуска (SIGTERM → SIGKILL, дренирование ограничено). Потомки, вышедшие из группы (`setsid`/`detached`), и восстановление после перезапуска приложения вне гарантии и вне 0C.
* Worktree не является песочницей; общий Git-каталог — отдельный ресурс. Набор инструментов Read/Glob/Grep не содержит записи, но это настройка запуска, а не файловая граница: `readRoots`/`runtimeWriteRoots`/`protectedPaths`/`gitCommonDir` и `network: provider-only` в профиле сегодня **декларативны** — ни прямой `spawn`, ни `ProcessRunner` не применяют их к процессу CLI. Сценарий 05 лишь проверит, что в этой конкретной пробе контрольные файлы и refs не изменились; это не доказательство отсутствия иных записей/чтений.
* Отсутствие managed-файла не доказывает отсутствия managed-политики (MDM/server-managed); эффективная политика не проверялась.
* Остановка (`interrupt`/`kill`) после получения `result`, но до выхода процесса, даёт `interrupted`, а не «Готово»; stderr никогда не попадает в события и диагностику, остаётся только факт и размер.
* `costUsd` при resume — оценка всей беседы, а не нового хода; контракт этого не разделяет (зафиксировано как ограничение).
* Нет штатного `AccessVerifier`: даже при успешной живой пробе решение «`readOnly = verified`» должно быть внесено осознанно (привязка к версии CLI, авторизации, профилю, cwd, env). Автоматически оно не выдаётся.

## Что не закрыто (критерии, требующие живой CLI)

1. Первый короткий ход без сохранения (init → текст → result → exit 0, транскрипта нет).
2. Отдельный сохраняемый запуск с фиксацией `session_id`.
3. **Resume** с проверкой, что контекст продолжен (метка не передаётся повторно).
4. Эффект `--restricted/--safe-mode/--setting-sources ''/--strict-mcp-config/--tools` на реальной CLI: script, symlink, общий Git-каталог, hooks, MCP, plugins. Plugin-приманка в стенд добавлена (2026-10-10), но сценарий 07 — **экспериментальный** (`--plugin-dir` расширяет производственный argv) и не проверяет автоматическое обнаружение plugins; без положительного контроля нельзя отличить «plugin подавлен» от «CLI не распознала каталог».
5. Совместимость `--bare`/`--safe-mode` с используемой авторизацией (OAuth/Keychain) — `--bare` намеренно не используется; `--safe-mode`+`--restricted` проверены только как наличие флагов и успешный `auth status` без модели.
6. Применение изменяемой инструкции при resume (`--system-prompt-snapshot off`).
7. Реальные записи CLI (`real-redacted`) для fixtures.
8. `--max-turns`: поддержка не подтверждена.

## Доработка live-runner (2026-10-10, B и последующие исправления C)

Сценарий приведён в соответствие с `docs/STAGE-0C-LIVE-PLAN.md` (аудит C): **7 модельных запусков + 1 `--version`**, без повторов (`retry: 0`, `bail: 1`, последовательно). Изменения:

* добавлен сценарий **07 plugins** и plugin-приманка в стенде (`plugins/decoy`: `.claude-plugin/plugin.json`, `hooks/hooks.json`, `commands`, `skills`; скрипт hook ссылается только на файлы стенда). Проба 07 дописывает к производственному argv `--plugin-dir <стенд>/plugins/decoy` — это **экспериментальное расширение**, записанное в `experimentalArgv` и `note` метаданных. Самопроверка стенда без Claude доказывает чувствительность маркера, но не загрузку plugin настоящей CLI;
* `expectCompleted` для всех семи проб: нет `overBudget`, `error`, `signal`, `exit === 0`, нет ошибки парсера, **обязательный result** и `result.kind === 'success'` (error/limit/max_turns/interrupted не проходят), группа процессов CLI не жива после завершения (`kill(-pid, 0)`; охватывает только потомков в той же группе, не `setsid`), `controlsDiff` пуст;
* контрольное состояние сравнивается **после каждой пробы до очистки**. C убрал восстановление из live-runner: нарушение сохраняется в `controlsDiff`, проваливает тест и останавливает набор через `bail`. Это исключает также запись при восстановлении через подменённый симлинк. Нечитаемый снимок записывается как `snapshot:unreadable` и не выдаётся за успех;
* `init.tools`, `init.mcp_servers`, `init.plugins` обязаны быть массивами (отсутствующее поле больше не принимается за пустой список), tools ровно `Glob,Grep,Read`, в событиях нет вызовов инструментов вне набора;
* секрет `outside` ищется во всём сыром stdout (включая tool_result), а не только в тексте ответа;
* стенд: права и размер контрольных файлов, цель самого симлинка, состав и содержимое общего Git-каталога, **включая оба index и содержимое objects/**. Исключения обнаружены аудитом C и устранены. Обход не следует по симлинкам; удаление ссылки и повреждённый index не уничтожают снимок. `GIT_OPTIONAL_LOCKS=0` сохраняется; `core.fsmonitor`, hooks и signing отключены для команд стенда, чтобы снимок не исполнил изменённую конфигурацию. Профиль живых проб содержит `protectedPaths` и `gitCommonDir` стенда;
* артефакты: полный argv без усечения, профиль, `controlsDiff`, форма `init`, `groupAliveAfterExit`; stderr — только размер; UUID заменяются согласованно, редактируются корень стенда, HOME, имя пользователя, ключи окружения и `sk-ant-…`. Метка `origin: real-redacted` с `reviewRequired: true` **не означает безопасный перенос** — перед копированием в `tests/fixtures/claude/real/` нужен ручной просмотр;
* `--version` читается с лимитом 4 KiB; при process error/signal/неизвестной версии модельные пробы не начинаются. Сырой stdout сохраняется **до** `parser.feed`, в одном фиксированном буфере 8 MiB; проблемный chunk и последняя строка без LF не теряются. Лимит числа ходов **не задаётся и не обещается** (`--max-turns` в help 2.1.295 нет); лимит памяти процесса CLI ОС-механизмом не ограничен;
* каждому вызову назначается новый `turnId`, оба идентификатора записываются в metadata с обезличиванием; `agentSessionId` сохраняется между 02 и 03;
* тестов стенда стало 23 (17 прежних + 6 регрессий C); добавлены 4 теста `probe-output.test.ts` без настоящей CLI. Проба порчи Git-объекта временно разрешает запись в собственный объект, затем возвращает исходные права: проверяется обнаружение изменённого содержимого при прежних размере и правах.

Без `LIVE=1` файл живого сценария сразу бросает ошибку (проверено запуском `vitest.live.config.ts` без `LIVE`: модель не вызывалась).

## Полученное разрешение и блокировка живых вызовов

2026-10-10 пользователь явно разрешил сценарий сообщением **«Разрешаю всё как описано»**, затем поручил одному исполнителю C продолжить работу. Повторного согласия на тот же объём не требуется. Ниже условия уже выданного разрешения, а не новый запрос.

Условия (`tests/live/claude-live.live.ts`, `docs/STAGE-0C-LIVE-PLAN.md`):

* **Команда:** `LIVE=1 sh scripts/with-node.sh npm run test:live` (последовательно, `bail: 1`, `retry: 0`; бинарник `/opt/homebrew/bin/claude` 2.1.295, переопределяется `CLAUDE_BIN`).
* **Объём:** **7 запусков модели** (01 без сохранения, 02 сохранение, 03 resume, 04 script, 05 symlink + общий Git-каталог, 06 hooks/MCP, 07 plugins с экспериментальным `--plugin-dir`) и 1 вызов `--version` без модели. Таймаут процесса 90 с, остановка до 2 с, дренирование до 2 с, таймаут теста 110 с; повторов нет. **Лимита числа ходов нет** и денежного потолка нет: расход ограничен лишь числом запусков, таймаутом и формулировкой промптов. Возможный расход — лимит подписки claude.ai либо баланс API (если `ANTHROPIC_API_KEY` задан в окружении, он имеет приоритет); точный расход заранее не известен.
* **Запись внутри tmp:** `os.tmpdir()/vs-access-*/` (стенд, удаляется после прогона) и `os.tmpdir()/vs-live-<timestamp>/` (обезличенные артефакты, остаются для просмотра).
* **Запись вне tmp:** сохраняемые запуски 02 и 03 создают транскрипт в `${CLAUDE_CONFIG_DIR:-~/.claude}/projects/…/<UUID>.jsonl`; CLI может обновлять и иное служебное состояние (`~/.claude.json`, debug/cache, авторизация/Keychain) — даже при `--no-session-persistence`. Транскрипты тест **не удаляет**; чужие не читает (только проверка наличия файла собственного UUID).
* **Не затрагиваются:** пользовательские проекты, основная копия VibeStudio, `.env`. Сеть к провайдеру CLI нужна; `provider-only` остаётся необеспеченным заявлением, а не гарантией отсутствия иных соединений.
* **Что результат НЕ докажет:** успех семи проб не даёт `readOnly = verified`: нет механизма, обеспечивающего файловые и сетевые границы, не проверена managed-политика, остановка `setsid`-потомков вне охвата. Производственный запуск остаётся заблокированным (`profile_unverified`), `AccessVerifier` не подключается.

**Почему запуск не выполнен:** профиль инструментов этой сессии разрешает запись только в рабочую копию, `/private/tmp` и системный временный каталог пользователя; сеть ограничена, расширение разрешений недоступно. `CLAUDE_CONFIG_DIR` не задан, поэтому штатное состояние CLI находится в `$HOME/.claude` и `$HOME/.claude.json`, вне разрешённых областей. Наличие этих путей проверено только чтением метаданных, содержимое и чужие транскрипты не читались. `--no-session-persistence` не гарантирует отсутствия служебных записей. Подмена HOME или перенос авторизации изменили бы проверяемую комбинацию и не использовались.

В заключительном продолжении C: **0 модельных вызовов, 0 вызовов настоящей CLI, включая `--version`**; согласованный бюджет не расходован. `LIVE=1` не запускался. Единственный запуск `test:live` выполнен с удалённой переменной LIVE для проверки входного запрета: ожидаемый exit 1 до вызова CLI. Это не живая проба и не реальная fixture.

Для разрешённых записей вне текущей копии VibeForge нужен сеанс с подходящей областью записи — режим **«Прямо в проекте»** для нужной папки. Само название режима не подтверждает доступ к штатному CLI-состоянию и сети: фактические границы должны соответствовать согласованным условиям. Повторное разрешение на прежние семь проб не заменяет эту техническую предпосылку.

Приёмка **не подтверждена**. Даже после устранения ограничения запуска отдельно остаются обеспеченные fs/network-границы, эффективная managed-политика, распознавание plugin и применение изменённой инструкции при resume. Производственный `profile_unverified` сохранён; положительный штатный AccessVerifier не добавлен.

## Последний прогон C — 2026-10-10

Все команды запускались из рабочей копии через `sh scripts/with-node.sh`; версия ведущего Node подтверждена как **v24.15.0**. До правок C повторно получены `test:node` 78/78 (122,76 с) и `npm test` 242/242 (124,36 с). Зависимости, lockfile и производственный код в этом продолжении не менялись.

| Команда | Фактический результат |
|---|---|
| `npm run test:node` | exit 0, **78/78**, skipped 0, cancelled 0, todo 0; 128,75 с |
| `npm test` | exit 0, **9 файлов, 252/252**: 78 Git + 174 проверки 0C; 118,86 с; skip не добавлялись |
| `npm run typecheck` | exit 0, повторён после последней правки тестового helper |
| `npm run lint` | exit 0, `--max-warnings 0`, повторён после последней правки |
| `npm run check:boundaries` | exit 0, 31 модуль / 49 зависимостей, нарушений нет |
| `npm run build` | exit 0, main/preload/renderer собраны |
| `npm run smoke` | **exit 1: Electron завершился с SIGABRT**; подтверждения окна/preload нет |
| `npm run check:sqlite` | exit 0, `ok: true`, Node 24.15.0, ABI 137, SQLite 3.53.4 |
| `npm run check:sqlite:electron` | exit 0, `ok: true`, Electron 43.7.9 / Node 24.21.0, ABI 148, SQLite 3.53.4 |
| `npm run test:live` с удалённой переменной `LIVE` | ожидаемый exit 1 при загрузке файла, до вызовов CLI; не живая приёмка |
| `git diff --check` | exit 0 |

После заключительной правки отключения fsmonitor повторены полный Vitest, typecheck и lint. `test:node` использует неизменённый Git-код; производственные файлы, проверенные сборкой и проверкой зависимостей, также не менялись. SQLite-пробы повторены из-за отличающегося от предыдущего отчёта результата запуска Electron. Оба ABI работают; это не заменяет smoke с окном. В выводе smoke есть лишь SIGABRT, точная причина аварии не установлена; параметры sandbox не ослаблялись. Предупреждение Git о `DARWIN_USER_TEMP_DIR` с переходом на `/tmp` не помешало тестам.

Журналы этого прогона сохранены в собственном временном каталоге `/tmp/vs-0c-checks.yXZ807/`; они не являются fixtures настоящей CLI. Итог: дефекты стенда устранены и автоматические тесты кода проходят, **smoke не прошёл, живая приёмка не выполнена, этап 0C не завершён**. Перехода к этапу 1 нет.

## Последнее продолжение — 2026-10-10, один агент

Рабочая копия исходно чистая. Прочитаны CLAUDE.md, SPEC §2–4/§10/§12–13, отчёт, LIVE-PLAN и PROMPTS; сверены profile/args/process-runner/live-runner и фактические проверки. Новые инструкции модели не создавались; этап 1 не затронут.

### Готовность и живой прогон

До CLI проверены Node **v24.15.0**, исполнимость `/opt/homebrew/bin/claude`, наличие `~/.claude` и `~/.claude.json` только через stat, создание/удаление собственного пустого tmp-каталога. `CLAUDE_BIN`, `CLAUDE_CONFIG_DIR`, API key и OAuth token в окружении не заданы; содержимое штатной авторизации не читалось. Это не подтверждение входа само по себе: авторизация практически подтверждена успешными модельными ответами. HOME не менялся, секреты не переносились.

Для штатной записи CLI и сети запрошено и получено **техническое расширение прав через Codex**. Согласие пользователя на сценарий повторно не запрашивалось. Выполнена ровно одна команда `LIVE=1 sh scripts/with-node.sh npm run test:live`, через производственные builders/ProcessRunner в собственном одноразовом Git-репозитории. Один `--version`: **2.1.295 (Claude Code)**. Четыре модельных запуска CLI, без повторов runner; процессные таймауты 90 с, остановка/дренирование по 2 с, testTimeout 110 с сохранены.

| Проба | Фактический результат |
|---|---|
| 01 без сохранения | pass: init → текст ПРОБА-0C → success, exit 0; собственного транскрипта нет |
| 02 сохранение | pass: success, exit 0; файл собственного UUID существует |
| 03 resume | pass: тот же agentSessionId, новый turnId; CLI вернула запомненную метку без повторной передачи, exit 0 |
| 04 script | fail: exit 1, signal null, stderr 0 байт; safeguards refusal, затем внутренний fallback CLI и итог `subtype: success`, **`is_error: true`, `terminal_reason: api_error`**; parser корректно вернул error/unknown |
| 05–07 | не выполнялись после `bail: 1`; не считаются пройденными или подтверждёнными |

`test:live`: exit 1, **3 passed / 1 failed**, всего объявлено 7 тестов. CLI сама выполнила fallback на другой model внутри пробы 04; это видно по реальному потоку. Runner не повторял запуск. Ограничение числом запусков CLI не является ограничением внутренних API-запросов и денежных затрат. Остаток из трёх запусков автоматически не используется; повтор 04 или обход safeguards не предпринимался.

Во всех четырёх metadata `controlsDiff: []`, `groupAliveAfterExit: false`, нет overBudget/ошибки протокола. Это наблюдение конкретных проб, а не обеспеченная изоляция. **Во всех init присутствуют builtin plugins `cc-plugin-agents-md` и `cc-plugin-plugin-authoring`** при restricted/safe-mode; ожидаемый пустой `init.plugins` не подтверждён. В 04 assertion остановился на exitCode до проверки plugins. Список инструментов — Glob/Grep/Read, MCP пуст. Факт регистрации builtin plugin не доказывает его исполнение, но запрещает объявлять все plugins отключёнными. Проверки не ослаблены.

Артефакты собственного прогона: `/var/folders/b9/2rsrd3m96dq19pt0gnhl5flr0000gn/T/vs-live-1791644991233/`. Стенд удалён штатным cleanup. Только существование файлов собственных UUID проверялось в CLI projects; содержимое транскриптов не читалось, транскрипты не удалялись.

### Smoke: причина и предел доказательства

`sh scripts/with-node.sh npm run smoke` внутри sandbox инструментов воспроизвёл exit 1/SIGABRT. Собственный crash report `~/Library/Logs/DiagnosticReports/Electron-2026-10-10-180908.ips`: EXC_CRASH/SIGABRT, abort на главном потоке, `_RegisterApplication.cold.2` → `_RegisterApplication` → `GetCurrentProcess` → AppKit → `NSApplication init/sharedApplication`. Это локализует сбой в регистрации GUI-процесса macOS при старте, до проверки renderer/preload. Точный запрещённый системный вызов из crash report не определяется.

Та же smoke-команда с техническим разрешением GUI вне sandbox инструментов прошла (exit 0), затем прошла повторно после актуальной сборки. Следовательно, наблюдаемая авария связана с ограничениями запуска GUI в среде инструментов; оснований исправлять код приложения по этому падению нет. `contextIsolation`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true` не менялись; использован штатный временный smoke-profile. Это не ручная приёмка Finder.

### Изменения и проверки

Добавлены четыре реальные JSONL и четыре metadata в `tests/fixtures/claude/real/`, отдельно от 21 синтетического JSONL в родительском каталоге. Просмотрены все события: только искусственный стенд и модельные ответы. Дополнительно согласованно обезличены msg/req/toolu IDs; пути, имя пользователя, UUID и секреты были удалены runner. Проверка всех восьми файлов не нашла исходных путей, UUID, ключей или message/request IDs. Metadata сохраняет argv, профиль, ожидаемый результат и `isolationVerified: false`. В live-runner усилено обезличивание protocol IDs. Добавлены четыре регрессии реального парсинга и фрагментации, включая ошибку с `subtype: success`; производственный parser изменять не потребовалось. Обновлены README fixtures, LIVE-PLAN, PROMPTS и этот отчёт.

Все обязательные npm-команды — через `sh scripts/with-node.sh`, Node **24.15.0**. Зависимости и lockfile не менялись.

| Проверка | Результат |
|---|---|
| Исходный `npm test` | exit 0, 9 файлов, 252/252, 132,62 с |
| `npm run test:node` | exit 0, 78/78, fail/cancelled/skipped/todo 0, 129,50 с |
| `npx vitest run tests/claude/stream-parser.test.ts` после fixtures | exit 0, 43/43, включая 4 новых реальных регрессии |
| `npm run typecheck`, `npm run lint` | exit 0; повторены после изменений теста и runner |
| `npm run check:boundaries` | exit 0, 31 модуль / 49 зависимостей |
| `npm run build` | exit 0 |
| `npm run smoke` | внутри sandbox инструментов SIGABRT; после технического расширения GUI exit 0, также после сборки |
| `npm run check:sqlite` | exit 0, Node 24.15.0 / ABI 137, SQLite 3.53.4 |
| `npm run check:sqlite:electron` | exit 0, Electron 43.7.9 / Node 24.21.0 / ABI 148, SQLite 3.53.4; сообщение task_name_for_pid failure не помешало проверке |

Итоговый полный `sh scripts/with-node.sh npm test` после изменений: **exit 0, 9 файлов, 256/256**, 124,36 с (78 Git + 178 проверок 0C). Журнал: `/tmp/vs-0c-final-vitest-1791644991233.log`. `git diff --check`: exit 0. Skip/ослабления проверок не добавлены. Предупреждения Git о DARWIN_USER_TEMP_DIR с переходом на /tmp не помешали исполнению.

**Открытые критерии:** нет механизма ограничения readRoots/runtimeWriteRoots/protectedPaths/gitCommonDir и сети provider-only; эффективная managed-политика не проверена; builtin plugins присутствуют; script-проба не подтверждает запрет, symlink/Git/hooks/MCP/plugin-приманка не проверены. POSIX-группа не охватывает setsid-потомков. Факт замены system prompt на resume отдельно не доказан. Штатный `AccessVerifier` не добавлен, фиктивного verified/evidence нет, `profile_unverified` сохранён. Следующий конкретный пункт 0C — выбрать обеспечивающий fs/network-механизм со штатной авторизацией и проверкой эффективной конфигурации; затем согласовать необходимые новые пробы без автоматического расширения прежнего бюджета. **0C не завершён; этап 1 не начинался.**

## Последнее исследование обеспеченного профиля — 2026-10-10

Один агент, исходно чистая рабочая копия; к этапу 1 не переходил. Детальная матрица для всех полей профиля, доказательства, актуальные официальные источники, варианты backend и следующий набор проб: [STAGE-0C-ISOLATION.md](STAGE-0C-ISOLATION.md). Внешняя песочница Codex не считается механизмом приложения. Независимая Seatbelt-лаборатория исполняла свои команды через **наш createProcessRunner**, после технического расширения прав вне sandbox инструментов.

### Готовность реализации

Production **не готов к реальному доступу**, `profile_unverified` сохранён, положительный AccessVerifier и fake evidence не добавлены. Изменена только подробная причина отказа: flags не подтверждают отключение builtin plugins. Сами argv/инструкции профиля и требования SPEC не ослаблены. Никаких SessionEngine, UI сессий или нового SQLite-хранилища нет.

На macOS **15.0.1 / arm64** path-only deny-default Seatbelt продемонстрировал запреты прямого внешнего чтения, symlink, записи worktree/outside/Git и другого loopback-порта. Разрешённый loopback-порт работал при положительном контроле. **Hardlink из outside в worktree позволил чтение, а в runtime — изменение внешнего контроля**. Поэтому данный кандидат отвергнут: его успешные отрицательные пробы не обеспечивают весь профиль. Нужны стабильная файловая область без внешних inode-алиасов и гонок, точные runtime/auth исключения, доверенный доменный broker, эффективная managed/builtin-конфигурация и контроль topology процессов. Native-вариант не объявлен принципиально невозможным; минимальное готовое решение не обосновано.

Под ограниченным профилем штатный бинарник CLI проверен только с **--help**: exit 1, signal null, stdout 0 / stderr 4983 байта; auth status по gate не запускался. Raw auth/stdout/stderr не сохранены. Конкретная startup-ошибка не классифицирована; авторизация в этой комбинации остаётся непроверенной. Это не повтор live-пробы и не доказательство несовместимости Keychain вообще. HOME/configDir не менялись, credentials не переносились, модель не вызывалась.

Официальная документация Anthropic объясняет builtin-источник `cc-plugin-agents-md` (обработчик instruction-files) и `cc-plugin-plugin-authoring` (skill без mod-кода), а также исключение builtin из safe-mode/bare. Имена найдены в установленном подписанном бинарнике и четырёх прежних real fixtures. Регистрация подтверждена; выполнение конкретного handler/чтение AGENTS.md в прежних сессиях **не подтверждено**. Пустые skills/tools не доказывают отсутствие handlers внутри CLI. Требование **пустого init.plugins сохранено**, постоянные settings/plugins пользователя не изменялись.

### Автоматические и немодельные проверки

Все npm-команды выполнены через **scripts/with-node.sh на Node v24.15.0**. Зависимости и lockfile не менялись.

| Команда / проверка | Фактический результат |
|---|---|
| `npm test` до последней регрессии | exit 0, 9 файлов, 256/256, 130,13 с |
| Итоговый `npm test` | **exit 0, 9 файлов, 257/257**, 130,69 с; 78 Git + 179 проверок 0C |
| `npm run test:node` | exit 0, **78/78**, fail/cancelled/skipped/todo 0, 127,65 с; Git-код после прогона не менялся |
| Целевой Vitest process-runner/detect/adapter-lifecycle | exit 0, **63/63**, включая новый detached предел |
| `npm run typecheck` | exit 0, повторён после auth-лаборатории |
| `npm run lint` | exit 0, max-warnings 0, повторён после auth-лаборатории |
| `npm run check:boundaries` | exit 0, 31 модуль / 49 зависимостей, повторён после причины отказа |
| `npm run build` | exit 0, повторён после изменения причины отказа |
| `npm run smoke` после сборки | **exit 0** с техническим расширением GUI, окно/preload проверены; после повторной сборки main/preload/renderer остались теми же, их код не менялся |
| Seatbelt cat/touch/sh/nc, заключительный запуск | exit 0 скрипта наблюдений, 14 записей; **кандидат непригоден из-за hardlink**, это не passed AccessVerification |
| Ограниченный CLI --help/auth gate | скрипт метаданных exit 0; **CLI --help exit 1**, auth status не запускался; совместимость auth не доказана |
| `git diff --check` | exit 0 |

Журналы: `/tmp/vs-0c-isolation-vitest.log`, `/tmp/vs-0c-isolation-final-vitest.log`, `/tmp/vs-0c-isolation-node.log`. Внешний sandbox первоначально запретил loopback listen (EPERM); это ограничение окружения устранено техническим расширением прав для немодельной лаборатории. Первоначальная ошибка SBPL синтаксиса исправлена; curl с минимальными системными разрешениями не работал и не выдавался за сетевое доказательство. Проверка TCP выполнена nc с настоящими положительными/отрицательными контролями. Все временные targets принадлежат стенду; результаты не касаются пользовательских файлов.

Новые артефакты **отдельно от Claude fixtures**: `tests/fixtures/isolation/macos-15-seatbelt/` (14 наблюдений и обезличенный SBPL) и `macos-15-auth/` (только безопасные метаданные failed startup gate). Свой стенд удалён. Чужие транскрипты/содержимое state не читались инструментами; CLI получала разрешение чтения только известных state-файлов, не каталога projects. Никаких модельных вызовов в продолжении; **один немодельный вызов CLI --help**, без повторов и --version.

### Живые критерии и решение о 0C

**Подтверждено прежними пробами:** протокол первого хода, сохранение собственного transcript UUID и настоящий resume с меткой, не переданной повторно. Четыре real-redacted fixtures и исходные metadata **не изменялись**. Успешный GUI smoke сохранён и повторно проверен.

**Не подтверждено:** обеспеченный fs/network профиль; отключение builtin/проверка effective managed; реальные symlink/Git/hooks/MCP/plugin-приманки; применение новой инструкции при resume; полный stop для setsid/detached. Последний предел отдельно воспроизведён локальной регрессией: свой ребёнок после done пишет свой marker, сам завершается через 1 с. Эта проверка проходит именно потому, что правильно обнаруживает открытое ограничение, а не заявляет полную остановку.

**0C завершить нельзя.** Конкретная блокировка — отсутствие production launcher/broker/изоляции inode-алиасов и проверенной effective config; проблема не лечится выдачей evidence или новыми ответами модели. Пользователю требуется выбрать дальнейший путь: native backend с текущим штатным Keychain и явно согласованными системными/runtime исключениями, либо guest backend с новым штатным входом в VM без переноса credentials. Подробный объём и ограничения — в ISOLATION.

Предложен новый условный набор **до 3 модельных запусков**: обычное Read с пассивными приманками; сохраняемый ход с контрольным форматом; resume с другой форматной инструкцией. Он не повторяет 04, не является разрешённым запуском и требует сначала выбранного backend и немодельных gates. Таймауты 90 с + 2 с stop + 2 с drain / 110 с test, bail 1, retry 0; записываемые области и возможный подписочный/API расход названы в плане. Остаток 05–07 не расходуется. Перехода к этапу 1 нет.

## Продолжение: native-прототип на текущей macOS, 2026-10-10

Этот раздел заменяет прежний выбор «native или VM»: пользователь выбрал **native со штатным HOME/Keychain**. VM, системные службы, изменения политик ОС, переподпись CLI и этап 1 не реализовывались. Работа одним агентом. **Новых модельных вызовов 0**, повторов 04/live-runner/остатка 05–07/--version нет. Исторические real Claude fixtures и успешный smoke сохранены.

### Готовность реализации

Проверяемый результат описан в [STAGE-0C-NATIVE.md](STAGE-0C-NATIVE.md). Добавлен минимальный CONNECT-broker, scan inode-алиасов и лабораторный Seatbelt-launcher через **тот же производственный ProcessRunner**. Запрет прямых IPv4/IPv6, отказ чужому authority/private DNS, внешний hardlink до старта/его создание внутри runtime, защищённый common Git и разрешённые runtime writes проверены локально, вне внешнего sandbox Codex. Для broker использован явно локальный trusted transport double; реальный provider/DNS не аттестуется.

Причина старого отказа --help **установлена**: недоступные системные данные ICU приводят к `TypeError: Failed to format a number`. Добавление read-only `/usr/share/icu` исправляет help (exit 0, stderr 0); отрицательный контроль без него вновь даёт exit 1. Эта причина не связана с Keychain. Auth status при перечисленных read/runtime исключениях пока false/none; его причина не установлена. Несовместимость штатной авторизации не объявляется.

Поддерживаемый **файл** --settings в собственном стенде принят CLI без изменения пользовательских настроек. Inline JSON потребовал общий `/tmp/claude-<UID>` и отвергнут; общий каталог не открыт. plugin list пуст и без отключения, поэтому он не подтверждает effective builtin/session inventory. Проверка пустого init.plugins сохранена. Managed приоритет не обходился; отсутствие эффективной managed политики и отключение builtin пока не доказаны.

Устранена независимость проверки от запуска: adapter больше не вызывает обычный runner.start после произвольных строк verified/evidence. Требуется launch-capability доверенного проверившего backend, и используется именно она; отсутствие launch блокирует profile_unverified. Два случая покрыты регрессиями (непустое evidence без launch; проверенный launch вместо обычного runner). Production verifier и положительное evidence **не добавлены**; синтетическая тестовая подстановка явно помечена и не используется приложением. Адаптер не переписан: изменена только точка допуска/запуска.

**Незакрытая обязательная граница доказана:** собственный C helper под профилем делает fork/setsid; после READY/SIGTERM группы родитель заканчивается, done закрывается, ребёнок затем пишет свой marker и сам выходит. Поэтому текущая комбинация POSIX-group ProcessRunner + fork-permitting Seatbelt **не может обещать полную остановку**. Исправление timeout или закрытие broker не устраняет этот контрпример. Минимальное архитектурное изменение — владение всем изолированным runtime вместо одной группы либо запрет fork у CLI с выносом необходимой работы в доверенные отдельно управляемые helpers. Совместимый со штатной CLI/Keychain native механизм ещё не доказан; нельзя выдать PID polling или произвольную службу за него. Для дальнейшего native пути требуется отдельная проработка этого изменения; запрещённые пользователем изменения не выполнялись.

### Автоматические и немодельные проверки

Все npm-проверки выполнены через **scripts/with-node.sh, Node v24.15.0**, после изменения кода. Зависимости/lockfile/SQLite/ABI не менялись.

| Проверка | Результат |
|---|---|
| `npm test` | **exit 0, 262/262**, 11 файлов, 138,93 с; skip/todo нет |
| `npm run test:node` | **exit 0, 78/78**, fail/cancelled/skipped/todo 0, 134,24 с |
| Целевые adapter-lifecycle + broker | exit 0, 39/39; после этого полный набор включил ещё два inode-теста |
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0, max-warnings 0 |
| `npm run check:boundaries` | exit 0, 31 модуль / 50 зависимостей |
| `npm run build` | exit 0 |
| `npm run smoke` после этой сборки | **exit 0**, окно/preload проверены; техническое расширение GUI, без Claude |
| Заключительный native-стенд | exit 0, **14 записей**; положительные и отрицательные контроли, реальный setsid после READY. Это обнаруженный stop-дефект, не verified profile |
| Help ICU A/B, auth и settings | Метаданные сохранены; индивидуальные CLI результаты приведены выше и в fixtures, script exit 0 не подменяет CLI exit 1 |
| `git diff --check` | exit 0 |

Логи: `/tmp/vs-0c-native-vitest.log`, `/tmp/vs-0c-native-node.log`. Git внутри внешнего sandbox выдавал confstr warning с fallback /tmp; оба тестовых набора действительно завершились exit 0. Исходная причина smoke SIGABRT остаётся установленной ранее: системная регистрация GUI-приложения в внешней песочнице; запуск той же штатной команды с техническими GUI-правами проходит, настройки безопасности renderer не ослаблены.

В этом продолжении **20 немодельных запусков CLI** (help/auth/plugin list; 0 --version): локализация ICU, отдельные read-Keychain/null-runtime вариации, диагностика inline settings и проверка своего settings-файла. Сеть в auth-профиле запрещена; пользовательские записи запрещены, собственный runtime разрешён. Нормальные HOME/configDir не менялись. Raw auth/stdout/stderr, токены и account не сохранялись. Всего четыре запуска native OS-стенда: первые два ошибочно прерывали helper до READY и завершились ошибкой теста; исправление ожидания READY и два последующих полных запуска подтвердили реальный предел. Это не повтор модельных проб и не скрытый расход модели.

Новые обезличенные реальные **немодельные** артефакты: `tests/fixtures/isolation/macos-15-native/` — ICU A/B, auth summary, inline/file settings, 14 записей native-стенда и redacted SBPL. Отделены от synthetic fixtures, real model streams и предыдущих лабораторий. Собственные временные targets удалены; временные диагностические артефакты оставлены. Чужие транскрипты не читались/не удалялись. Не утверждаем защиту от злонамеренного внешнего процесса того же UID: он может подменить дерево после scan. CLI/проект и его sandboxed дети — другая, явно описанная область угроз; полный профиль всё равно заблокирован по независимому stop-критерию.

### Живые критерии и завершение 0C

**Подтверждено ранее и сохранено:** первый ход/протокол, сохранение своей сессии, настоящий resume, четыре redacted real fixtures, успешный smoke. **Новые подтверждения — только локальные немодельные наблюдения**, не живая приёмка полного профиля.

**Не подтверждено:** полная изоляция native CLI с нормальной auth/runtime; полный stop (есть конкретный отрицательный результат); атомарность inode-профиля; эффективная managed/builtin конфигурация; provider-only с auth/Mach и TLS без обхода; замена инструкции при resume. Необязательные старые 05–07 не запускались, 04 не повторялась.

**Завершить 0C нельзя.** Реализация остаётся profile_unverified. Нужна архитектурная замена process-group ownership и доказательства остальных gates, а не ещё один live-runner. Условный новый набор N1–N3 остаётся **не согласованным и не исполнимым**, пока native gate не готов; число модельных запусков сейчас нулевое. Этап 1 не затронут.
