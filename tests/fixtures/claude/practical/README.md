# Реальные наблюдения practical-набора

Это безопасные отчёты practical-стенда и отдельно согласованной немодельной auth-диагностики, не synthetic doubles и не сырые JSONL для parser replay. Старые `../real/01–04` сохранены отдельно. Отчёты не содержат raw stdout/stderr, ответов модели, значений env, credentials или чужих transcripts.

## 2026-10-17-p01

Исполнитель A однократно выполнил согласованную команду из worktree после поручения пользователя завершить P2b:

```sh
LIVE=1 PRACTICAL_LIVE=1 CLAUDE_BIN=/opt/homebrew/bin/claude sh scripts/with-node.sh npm exec --offline --no -- vitest run --config vitest.live.config.ts tests/live/claude-practical.live.ts
```

Начало — 2026-10-17 18:15:01 MSK. Команда exit 1, Vitest Duration 712 мс (tests 495 мс). Отдельное wall-clock время команды не измерялось.

`2026-10-17-p01.json` — побайтовая копия собственного `vs-practical-evidence-SkxI49/results.json`, SHA-256 `0ce79d65708f968a7f81ff878969d57626f87da1656df577ca1259659500efbe`; mode исходника/копии 0600. В исходнике сохранены путь только собственного временного проекта и закрытые данные процессов/проверок; проект удалён подтверждённым cleanup. Git не сохраняет POSIX read/write mode 0600 при переносе checkout.

Проверенная редакция: live `4f0ef467a593fa0102c7eaf77f50a4dcf596eb3f55a05cf1611a8e8f5bc48ced`, helper `f0e31033e6ec8b10097cfc1ce0d00344c8cb8eb987a9caa6740ace630a3b134c`; executable `/opt/homebrew/bin/claude` → `/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe`, SHA `0116ee2e0a513900b633d9951367f18747686478e2b462805b8c31609f047f70`.

Результат: версия 2.1.295 и help завершились с exit 0; auth status — exit 1. `resultReason=not_authenticated` по действующему detect означает parsed `loggedIn:false`. Это утверждение о конкретном запуске, не диагноз аккаунта/Keychain/sandbox. Модельных запусков 0, диагностик 3. Остальные четыре сценария не запускались, автоматических повторов нет. Completion всех прямых процессов подтверждён, cleanup passed, root removed.

`readMarker/lifecycle/limitations=failed` — последствия недостигнутого модельного сценария. Пустой limitations не относится к ready, которого не было. `toolScope=passed` без модели не доказывает ограничений реальных tools. Отсутствие transcript без положительного контроля layout в acceptance остаётся unconfirmed. Этот fixture подтверждает отказ auth-gate до модели и завершение диагностики; **он не подтверждает модельную работу Claude, P2b или весь 0C**.

## 2026-10-17-auth01

После явного ответа пользователя «Разрешаю одну auth-пробу» A выполнил ровно один согласованный standalone entry:

```sh
LIVE=1 AUTH_STATUS_PROBE=1 CLAUDE_BIN=/opt/homebrew/bin/claude sh scripts/with-node.sh node --experimental-transform-types tests/live/claude-auth-status.probe.ts
```

Начало из evidence — `2026-10-17T15:51:25.354Z` (18:51:25.354 MSK). Команда exit 1; измерение `/usr/bin/time -p`: real 0,47 с, user 0,39 с, sys 0,13 с. Прямых auth-попыток 1, моделей 0, повторов нет. Production createClaudeAdapter и модельная методика не подменялись: это отдельная диагностическая команда `auth status` через существующий ProcessRunner, без `--safe-mode --restricted`.

`2026-10-17-auth01.json` — побайтовая копия собственного `/var/folders/b9/2rsrd3m96dq19pt0gnhl5flr0000gn/T/vs-auth-status-evidence-K1xkcg/results.json`, 1573 байта, mode исходника/копии 0600. SHA-256 **`3b12d16a6ac83542b82a79b1d5d28e97a6b6bd15849c4aca6c4da061957ca1d2`**; cmp и SHA проверены C. Git не сохраняет POSIX mode 0600 при переносе checkout.

Проверенная редакция entry — `1a0872dbe5dbfeccf931b7a431097948bb045daef709031f9c2dc20546dffa30`, helper — `81ae766cc3a14db8478dcc6e8893ee1b9fa9c381af42c536d0304b5fe895379e`. Executable и его SHA те же, что в p01. B независимо прочитал исходный JSON и сверил SHA: открытых несогласованностей нет.

Результат: `unauthenticated/completed`, `loggedIn:false`, `authMethod:none`, `apiProvider:firstParty`. CLI exit 1 без сигнала, stdout/stderr ended, wait settled, issues пусты; cleanup confirmed, stop not_needed. Учтено 217 байт stdout и 0 stderr, содержимое не сохранено. SIGKILL собственной группы со статусом not_found не подтверждает остановку detached-потомков.

Отсутствие подтверждённой авторизации наблюдалось и без двух режимных флагов. Это **не причинный A/B с p01**: различаются время и родительский запуск, тождественность PATH не доказана. Причина неизвестна; fixture не обосновывает снятие production-ограничений, диагноз аккаунта/Keychain/sandbox или повторный login. Provider refresh, реальная модельная работа, P2b и весь 0C не подтверждены. Исходное разрешение на одну команду израсходовано, новые вызовы не выполнялись.

## 2026-10-17-auth02

После нового явного сообщения «Разрешаю одну auth-пробу» A однократно повторил ту же команду auth01 без изменения entry/helper/argv. Это отдельно разрешённый повтор, не автоматический retry. Начало — `2026-10-17T15:56:28.503Z` (18:56:28.503 MSK); команда exit 1, `/usr/bin/time -p` real **0,44 с**. Прямых CLI-попыток 1, моделей 0; после этого вызова продолжения не было.

`2026-10-17-auth02.json` — побайтовая копия собственного `/var/folders/b9/2rsrd3m96dq19pt0gnhl5flr0000gn/T/vs-auth-status-evidence-EQtLjL/results.json`, 1573 байта, mode исходника/копии 0600, SHA-256 **`0b430d3c98b9afcb3e17265ff1c753be473f3de40b28cd2a3be88188fce77c00`**. C проверил cmp/SHA, B независимо прочитал исходник и подтвердил результат. SHA entry/helper/executable те же, что в auth01.

Результат снова `unauthenticated/completed`, loggedIn false, authMethod none, apiProvider firstParty; CLI exit 1 без сигнала, оба EOF ended, wait settled, issues пусты, cleanup confirmed, stop not_needed. В закрытом JSON auth01/auth02 отличается только startedAt; C подтвердил diff, B — совпадение содержимого после исключения строки времени. Это не сравнение сырых ответов, они не сохранялись. Причина расхождения с обычным рабочим запуском пользователя остаётся неизвестной; разрешение израсходовано, модель/P2b/0C не подтверждены.
