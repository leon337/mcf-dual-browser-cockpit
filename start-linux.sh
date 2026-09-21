#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "[ERRO] Node.js 22.12+ não foi encontrado."
  exit 1
fi
if [ ! -x node_modules/.bin/electron ]; then
  echo "[MCF] Instalando dependências na primeira execução..."
  npm install
fi
exec npm start
