# Реальные наблюдения practical-набора

Это безопасные отчёты production-стенда, не synthetic doubles и не сырые JSONL для parser replay. Старые `../real/01–04` сохранены отдельно. Отчёты не содержат raw stdout/stderr, ответов модели, значений env, credentials или чужих transcripts.

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
