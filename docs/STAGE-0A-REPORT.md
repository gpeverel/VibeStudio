# Отчёт по этапу 0A

Дата прогона: 2026-10-09. macOS (Darwin 24.0.0), Node v24.15.0 (`.nvmrc`), npm 12.2.0. Исторический результат из `tests/spec-boundaries.md` (14 passed от 2026-10-08) заново не засчитывался: все прогоны ниже выполнены в этой сессии.

## Предпосылки

- Системный Node в окружении — v26.11.0, проект требует `>=24.15.0 <25` (`engine-strict`). Исходный Node-runner на Node 26 дал 14 passed / 0 failed (~5,5 с), дальнейшая работа шла на Node 24.15.0.
- В окружении сессии задано `NODE_ENV=production`; в `.npmrc` добавлено `include=dev`, поэтому dev-зависимости ставятся и так. Установки выполнялись с `unset NODE_ENV`.
- Установка штатная: `npm ci`. Бинарник Electron скачивает корневой `postinstall` (`install-electron`, кеш `.cache/electron`): у electron 43.7.9 собственного postinstall нет. `allowScripts` в `package.json` разрешает `@swc/core`, `esbuild`, `fsevents`.
- npm пишет предупреждение, что install-скрипт `better-sqlite3@13.0.3` (`node-gyp rebuild`) не разрешён. Это безопасно: пакет содержит prebuilds, проба проходит под Node и под Electron без сборки.

## Команды и результаты

| Команда | Код | Результат |
|---|---|---|
| `node --test tests/run-git-boundaries.node.ts` (Node 26.11.0, до каркаса) | 0 | 14 pass, 0 fail |
| `rm -rf node_modules && npm ci` (Node 24.15.0, итоговый lockfile) | 0 | 266 пакетов, `postinstall` отработал, `npm audit`: 1 low (esbuild 0.27.3–0.28.0 внутри vite) |
| `npm run typecheck` | 0 | tsconfig.node.json и tsconfig.web.json без ошибок, без `skipLibCheck` |
| `npm run lint` | 0 | `--max-warnings 0` |
| `npm run check:boundaries` | 0 | нарушений нет; правила проверены на временных нарушающих файлах (удалены): `shared-no-node-builtins`, `shared-is-leaf`, `renderer-isolated`, `core-no-npm` сработали |
| `npm test` | 0 | Vitest, 1 файл `tests/spec-boundaries.test.ts`, 14 passed; Node-runner вторым набором не подхватывается |
| `npm run test:node` | 0 | 14 pass, 0 fail, 0 skipped |
| `npm run build` | 0 | собраны `out/main`, `out/preload/index.cjs`, `out/renderer` |
| `npm run check:sqlite` | 0 | Node 24.15.0, ABI 137, SQLite 3.53.4, запись и чтение во временной БД |
| `npm run check:sqlite:electron` | 0 | Electron 43.7.9 (Node 24.21.0), ABI 148, SQLite 3.53.4 |
| `npm run smoke` | 0 | «Проверка окна Electron и preload пройдена» |

Существующие файлы (`src/core/ports/git.ts`, `src/adapters/git/index.ts`, `tests/*`) не изменялись.

## Критерии приёмки 0A

| Критерий | Состояние |
|---|---|
| Существующие сценарии действительно исполнены | выполнено: 14/14 в Node-runner и в Vitest, без skip и ослабления |
| typecheck/lint/границы зелёные | выполнено |
| Минимальная сборка запускается | выполнено на этой машине (`smoke`); другой машиной не подтверждено, у A `smoke` завершился SIGABRT |
| Нативный SQLite загружается | выполнено под Node и под Electron |
| `.gitignore`, `CLAUDE.md`, токены | выполнено (`.gitignore`, `CLAUDE.md`, `src/renderer/styles/tokens.css`, `docs/DESIGN.md`) |

## Открытые вопросы

- Ручная приёмка сборки в GUI macOS не выполнялась: `smoke` проверяет скрытое окно, preload и отрисованный React-заголовок, не интерфейс целиком. У A `smoke` завершался SIGABRT (вероятно, ограничения sandbox его окружения; причина не разбиралась), у B после чистого `npm ci` — exit 0.
- `npm audit`: после обновления до `@electron/rebuild` 4.2.1, vite 7.3.7, dependency-cruiser 17.4.3, vitest 4.1.11 осталась 1 low-уязвимость (esbuild 0.27.3–0.28.0, вложенный в vite; исправление доступно через `npm audit fix`, не применялось, затрагивает dev-сервер на Windows). Остальные 8 закрыты.
- `rebuild:native` не запускался: prebuilds подошли без пересборки.
- Контроль ABI при смене версии Electron: `check:sqlite:electron` должен проходить после каждого обновления Electron или better-sqlite3.

## Следующая задача

Этап 0B: свести типы `GitPort` и тестового контракта (G4), добавить положительный squash и воспроизведения G1–G3, не меняя существующие 14 сценариев. Параллельно можно начинать 0C (парсер stream-json, диагностика бинарника) при согласованных портах в `src/core/ports/`.
