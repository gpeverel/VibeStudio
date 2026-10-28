#!/bin/sh
set -eu

# Только на время команды: автоматический сон останавливает тесты, но внешний
# deadline продолжает идти. Экран и глобальные настройки питания не меняются.
if [ "$#" -eq 0 ]; then
  printf 'Использование: sh scripts/with-test-awake.sh <команда> [аргументы…]\n' >&2
  exit 1
fi

if [ "$(uname -s)" = Darwin ]; then
  exec /usr/bin/caffeinate -i "$@"
fi

exec "$@"
