#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

UIDN="$(id -u)"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$UIDN}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"

if [ -S "$XDG_RUNTIME_DIR/pulse/native" ]; then
  export PULSE_SERVER="${PULSE_SERVER:-unix:$XDG_RUNTIME_DIR/pulse/native}"
fi

if [ -z "${DISPLAY:-}" ] && [ -S /tmp/.X11-unix/X0 ]; then
  export DISPLAY=:0
fi

if [ -z "${XAUTHORITY:-}" ] && [ -f "$HOME/.Xauthority" ]; then
  export XAUTHORITY="$HOME/.Xauthority"
fi

if [ ! -x node_modules/.bin/electron ]; then
  echo "[MCF] Instalando dependências..."
  npm install
fi

exec npm start -- --force-renderer-accessibility "$@"
