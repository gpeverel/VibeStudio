#!/bin/sh
set -eu

# Выбор Node не должен зависеть от профиля оболочки, запускающей VibeForge.
project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
IFS= read -r required_node < "$project_root/.nvmrc"
required_node=${required_node#v}

if [ "$(node --version 2>/dev/null || true)" != "v$required_node" ]; then
  node_bin="${NVM_DIR:-$HOME/.nvm}/versions/node/v$required_node/bin"
  if [ ! -x "$node_bin/node" ]; then
    printf 'Не найден Node %s из .nvmrc: добавьте установленную версию в PATH или NVM_DIR.\n' "$required_node" >&2
    exit 1
  fi
  PATH="$node_bin:$PATH"
  export PATH
fi

if [ "$(node --version)" != "v$required_node" ]; then
  printf 'Версия Node не совпадает с .nvmrc (%s).\n' "$required_node" >&2
  exit 1
fi

if [ "$#" -eq 0 ]; then
  printf 'Использование: sh scripts/with-node.sh <команда> [аргументы…]\n' >&2
  exit 1
fi

exec "$@"
