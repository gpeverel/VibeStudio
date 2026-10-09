# VibeStudio: правила работы с проектом

Единый источник требований — `docs/SPEC.md`. Токены и правила интерфейса — `docs/DESIGN.md`. Состояние этапов — в конце соответствующих отчётов (`docs/STAGE-0A-REPORT.md`).

## Окружение

- Node 24 для разработки (`engines`, `.nvmrc`; Node 26 отклоняется `engine-strict`); npm, не pnpm/yarn.
- В `.npmrc` задано `include=dev`; если в окружении `NODE_ENV=production`, на всякий случай ставить с `unset NODE_ENV`.
- npm 12 блокирует install-скрипты без `allowScripts` (список в `package.json`). Бинарник Electron скачивает корневой `postinstall` (кеш `.cache/electron`); `better-sqlite3` работает на prebuilds без install-скрипта. Установка: `npm ci`.
- Electron + TypeScript strict + React + electron-vite; SQLite через `better-sqlite3`.
- Версии Electron и нативных модулей закреплены; ABI better-sqlite3 для Electron отличается от Node — проверять оба.

## Команды

| Команда | Назначение |
|---|---|
| `npm test` | Vitest, только `tests/**/*.test.ts` |
| `npm run test:node` | Исходный Node-runner Git-границ (`node --test tests/run-git-boundaries.node.ts`) |
| `npm run typecheck` | TypeScript strict без вывода |
| `npm run lint` | ESLint |
| `npm run build` | Сборка electron-vite в `out/` |
| `npm run check:boundaries` | dependency-cruiser, правила в `.dependency-cruiser.cjs` |
| `npm run check:sqlite` | Проба better-sqlite3 под Node (`scripts/check-sqlite.mjs`) |
| `npm run check:sqlite:electron` | Та же проба под ABI Electron |
| `npm run rebuild:native` | Пересборка нативных модулей под Electron |
| `npm run smoke` | Запуск собранного Electron с `--smoke-test`: скрытое окно, проверка HTML и preload, выход за 15 с. Без Claude и пользовательских проектов |

Перед завершением задачи прогнать `typecheck`, `lint`, `check:boundaries`, `test`, `test:node`, `build`, `smoke`. Результаты записывать как есть; ограничение окружения фиксировать, а не объявлять успех.

## Архитектура

```text
src/shared/    DTO, типы и zod-схемы; без Node/Electron и бизнес-логики
src/core/      домен, порты, SessionEngine; зависит только от shared
src/adapters/  claude, git, process-runner, workspace-files, store, journal
src/main/      сборка зависимостей, IPC, окна
src/preload/   мост к window.api
src/renderer/  React; приложение только через window.api
```

Границы проверяет `npm run check:boundaries`. Не ослаблять правила ради прохождения: исправлять импорт.

## Границы записи

- Тесты создают только собственные временные репозитории и каталоги и удаляют их.
- Не писать в пользовательские проекты, их основную копию и каталоги вне worktree/временной папки.
- Реальный Claude не запускать без явного разрешения и только в одноразовом репозитории (`LIVE=1`, не в обычном CI).
- Git — системный `git` через `execFile` с массивом аргументов, без shell.

## Тесты и качество

- Не скрывать ошибки через `skip`, `todo`, ослабление assertions или расширение игнор-списков линтера.
- Существующий Node-runner и общий набор `tests/cases` сохраняются; Vitest запускает набор через `tests/spec-boundaries.test.ts` и не подхватывает `*.node.ts`.
- Типы известных результатов и коды ошибок — в производственном коде, без `Promise<unknown>` и свободных строк.

## Дизайн

Только токены из `src/renderer/styles/tokens.css`; анимации до 150 мс; один акцент; без градиентов и эмодзи в кнопках.
